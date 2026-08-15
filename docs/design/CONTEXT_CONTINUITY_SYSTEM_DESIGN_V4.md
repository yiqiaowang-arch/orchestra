# 上下文接力系统设计 V4 — 自动交接、Worktree 与 Coordinator 编排（Orchestra 乐团模式）

> 本文档是 continuity-v3（已交付并验证的 MVP：`continuity` / Orchestra（乐团模式，曾用名：接力模式）预设 + `/continuity` `/handoff` `/continue` + 持久 checkpoint）之上的演进设计。
> 覆盖三个阶段：**A 确认式自动交接** → **B worktree + coordinator + worker** → **C 高级目标自动编排**。
> 每阶段独立可上线、独立可回滚；阶段 C 是最终形态（列一个高级目标 → 自动多 worktree 并行 → 每个 worker 自动维持上下文健康）。
>
> 文中所有框架事实均来自本次实测（服务目录、loader 源码、真实会话冒烟测试），不臆测。

---

## 1. 现状基线（V3 MVP 已有资产，全部复用）

| 资产 | 位置 | 状态 |
|---|---|---|
| `continuity` 预设（Orchestra 乐团模式，曾用名：接力模式） | `~/.dsh/.agent-presets/continuity/`（用户 root） | 已挂载验证 + 跨仓库冒烟通过 |
| 持久伴生插件 | 预设目录内 `continuity-plugin.mjs`（相对行 `./continuity-plugin.mjs`） | 官方支持；重启后从磁盘重挂 |
| `/continuity` 状态面 | tokens / 容量(或 unknown) / 比率 / 压缩次数 / checkpoint 状态 / 分档建议 | 复用 host `tokenMeter`、`request/context`、`llm.resolveModelInfo` |
| `/handoff` 交接写盘 | 安全边界调度（`agent/turn-stopping`、idle 即时）、marker + 8 节校验、1 次有界重试、幂等 | 真实模型回合验证（seq 6952 valid） |
| `/continue` 继续 | 精确 id→标题→唯一匹配；`sessionReferenceResolver.prepare` 有界快照；注入先于唤醒；只做 next atomic action | 真实模型回合验证 |
| 压缩后自动准备 | `prepareAfterCompaction`，仅 root 会话 | 已验证（单元级） |
| 会话级状态机 | pending / checkpointing / ready / failed，键为 sessionId | 代内内存；持久状态从日志重推，无假就绪 |
| 测试设施 | `~/.dsh/designs/continuity-v3/tests/`（31 项为 V3 MVP 历史基线；当前 **147 项全绿**：unit 72 + rotation 20 + worktree 32 + mission 23，见 §7d/§7e）+ opt-scratch/smoke-a/smoke-b 草稿工作区 | 可扩展 |

**MVP 明确不做（本次设计要补的部分）**：自动新建会话、自动注入唤醒、自动 worktree、自动 coordinator/worker、同级会话消息通道。

---

## 2. 总体架构与平面归属

两平面规则（沿用 harness 约定）：

- **Host 平面**（进程单例，跨会话）：会话/Agent 创建与生命周期、会话查询与快照、token 计量、workspace 注册、沙箱与审批。**所有"驱动器"都在这一层。**
- **预设平面**（每会话贡献）：prompt 政策、斜杠命令、每会话状态、Host 服务消费者。预设行发布 Service 必须置于 `isolate` realm 组内。

**关键实测约束**（决定部署方式）：
1. 动态 Cordis 插件沙箱有意不给 `ctx.fiber`（`ownerCtx.fiber.assertActive()` 是 Agent 创建必经路径）→ **旋转/编排驱动器必须是真实挂载的 host 行，不能是动态插件**。
2. 本部署禁止改出厂 host 组合；用户可写层是 profile 补丁：`~/.dsh/profiles/web/cordis.patch.yml`（web 为本部署活动 profile；另有 home 级 `$DSH_HOME/cordis.patch.yml` 对所有 profile 生效），或用户自建 host bundle 目录经官方 `dsh plugin --profile` 安装。
3. 预设 standing mount 按组合文件 stamp 换代；改伴生插件后需触碰组合文件。
4. 子代理子会话默认继承父会话 cwd（`childSessionMeta` 取 `parentHeader.cwd`）；`SubagentStartRequest` 支持 per-child `persona`/`toolFilter`/`agentOptions`/`outputSchema`，**无 per-child cwd**（差距 G2，见 §8）。
5. 同级会话之间只有只读快照通道（`sessionReferenceResolver`）；**双向消息通道只存在于 coordinator↔子代理**（`send_message`/`report`/`interrupt`）——这是 B/C 的主通道选择依据。

### 组件总览

```
Host 平面（用户 profile 补丁层挂载）
├─ continuity-rotation   (阶段A)  观察→建议→(确认)→执行：终 checkpoint + 建新会话 + 注入 + 唤醒
├─ continuity-worktree   (阶段B)  授权式 git worktree 生命周期 + workspaceRegistry 登记
├─ continuity-mission    (阶段C)  目标分解 / 分派 / 审查 / 收敛；mission 记录持久化
├─ continuity-shared     (v1)     共享纯 helper：checkpoint 格式单一真相源（MARKER / validateCheckpoint /
│                                  userMessage / capText / textOfMessage / sectionBody / buildInstruction）
└─ （复用）tokenMeter · sessionQuery · sessionReferenceResolver · agents · subagents ·
          workspaceRegistry · approval · permissionPresets

预设平面（continuity 预设内）
├─ continuity-plugin.mjs（扩展）  命令、每会话状态机、worker 角色 prompt、协调/节奏/纪律（提示词层）
├─ 复用 delegation 组              subagent(continuable) / subagent_fork / workflow / ralph
└─ 复用 isolate 组                 sessionReferenceResolver（有界快照 seam）
```

依赖方向单向：预设插件只消费 Host 服务；Host 驱动器通过 `agentPresets.serviceFor(agent, name)` 读取会话内实例（现有官方 read-addressing 路径）。

---

## 3. 阶段 A：确认式自动交接（自动 rollover）

### 3.1 目标

对话到达轮换带时：自动完成旧会话的最终 checkpoint → 用户一键确认 → 自动在同 workspace 新建空白会话并注入快照唤醒 → 新会话只做 next atomic action。零自动 git 操作。无确认模式（全自动）作为用户显式开启的设置项，默认关闭。

### 3.2 触发策略（建议层，复用 MVP 阈值）

- 比率带（默认 0.60 / 0.70 / 0.78）→ 到达 rotate 带发出**建议**；容量 unknown 时不自动触发（诚实 unknown），仅在压缩后按 `prepareAfterCompaction` 语义准备。
- 触发点必须是**安全边界**（`agent/turn-stopping` 或 idle）——绝不打断模型请求与工具调用（沿用 MVP 约定）。
- 防重复：每会话 rotation 锁 + 幂等键；已 ready 且无新用户输入的 checkpoint 直接复用，不重写。

### 3.3 执行流程（确认后，host 驱动器）

1. 旧会话写最终 checkpoint（复用 MVP 的 steered 模板与校验；有界重试 1 次；失败则停留并报告，不建新会话）。
2. 验证 durable（post-commit `assistant/message` + marker + 8 节 + next action 非空；重启场景从日志重推）。
3. 建新会话：`agents.create({ sessionId: 新id, meta: { cwd: 旧cwd, agentPreset: 'continuity', parentSession: 旧id }, agentOptions: 同路由, setup: mount('continuity') })`（冒烟测试已证明此路径可用；`parentSession` 打通 `sessionQuery.traceSession` 谱系）。
4. 注入先于唤醒：`sessionReferenceResolver.prepare` 产出有界快照 → `agent.inject(snapshot)`；若快照已无 checkpoint（被压缩遮蔽）→ 复用 MVP 的日志召回路径注入 checkpoint 消息 → `agent.followup(指令)` 唤醒（指令 = "核实 workspace、只做 next atomic action"）。
5. 旧会话处置：默认**保持存活、转只读**（不自动关、不自动禁）；可选 `workspaceRegistry.archiveSession(旧id)` 归档（行配置 `oldSession: keep | archive`，默认 `keep`）；绝不自动终止用户的旧会话。
6. 失败回滚：任一步失败 → 留在旧会话，产出错误报告；新会话创建后若发现 workspace 不符 → 新会话只报告不编辑（MVP 语义不变）。

### 3.4 确认机制（体验层）

- 默认：**建议卡 + 一键确认**。建议卡挂在现有 client Slot（`userQuestions` 或 shell 通知区，实施时 query 实际 Slot 契约）；确认即执行 3.3。
- 命令面：`/rotate`（手动触发一次完整交接，等价确认+执行）；`/continuity` 状态中显示"轮换建议待确认"。
- 设置 `autoRollover: off | suggest | auto`（rotation 行 config）：`auto` 仅在用户显式开启且会话审批政策允许时生效；`auto` 下仍遵守安全边界与失败回滚。

### 3.5 "2-3 轮自动交接"的定位

默认**单程交接**（写 checkpoint → 注入 → 做一件事）。若需要多轮协商，两个可选方案：

- **方案 1（推荐，B 阶段自然获得）**：交接发生在 coordinator↔worker 父子通道上，多轮 = coordinator 收 report 后 `send_message` 追问/追加指令——通道天然存在，无需同级会话互写。
- **方案 2（同级会话，受限于框架）**：新会话产出"交接回执/提问"作为带标记的 assistant 消息，旧会话（若仍存活）经 `sessionQuery` 只读该回执并补写 checkpoint 附注——技术上可行但旧会话必须被再次唤醒，复杂度高、收益低。

**结论**：A 保持单程；多轮协商放到 B 的父子通道上，用有界轮数（默认 ≤3；`handshake-max-rounds` 设置键未落地，见 §6）实现。

---

## 4. 阶段 B：Worktree + Coordinator + Worker

### 4.1 角色模型

- **Coordinator**：用户的主会话（Orchestra 乐团模式 + coordinator 角色 prompt 段）。职责：任务分解、worktree 规划、派发、审查 report、维持顶层 mission checkpoint（同样带 marker 与 8 节）、重试/中断/升级。
- **Worker**：coordinator 的 **continuable 子代理**（`backgroundMode: continuable`），每个占一个 worktree，独立会话、独立 token 折叠、独立 `/continuity` 状态（子代理经 `composeFrom` 继承父预设，每会话状态按 sessionId 键控——已实测成立）。
- **通道矩阵**（设计期选项）：coordinator→worker `send_message`；worker→coordinator `report`（含 `reportFrom`）；coordinator 任意时刻 `interrupt`；发现面 `listChildren`/`listDescendants`/`list_agents`。同层 worker 不直连（经 coordinator 中转或只读快照）。（实现见 §7c：worker 为普通 child 会话，coordinator→worker 走驱动器 `followup`、worker→coordinator 走 `## Worker report` 文本 + `/worker-report` 拉取、`/worker-stop` 取消；subagent 工具通道为设计期选项，未采用。）

### 4.2 Worktree 生命周期（host 驱动器 `continuity-worktree`）

1. **创建**（授权式）：`git worktree add <sibling-path> -b feature/x`（经 shell 执行）；默认每次创建需审批（approval 流），或用户对 coordinator 会话授权"本次会话内 worktree 免审"（`approval.setPolicy(agent, …)` 会话级政策——框架已有此 seam）。
2. **注册**：`workspaceRegistry.create(worktreePath, title)`（框架已有；`resolveByPath` 防重复登记）。
3. **派发**：spawn worker，`meta.cwd = worktreePath`（差距 G2，见 §8：优先给 `SubagentStartRequest` 增加可选 per-child `cwd`，向后兼容；临时方案为 host 驱动器直接 `agents.create` 并维护 `parentSession` 谱系）。
4. **回收**：worker 写报告（`report`）→ coordinator 审查 → 通过则记录 mission checkpoint；失败则 `send_message` 追问或 `interrupt` 后重派。
5. **归档与清理**：`workspaceRegistry.archiveSession(workerId)` 归档会话；worktree 目录保留、删除或合并**默认全部由人决定**（合并分支 = 审批动作；不自动 merge/checkout/clean）。

### 4.3 Worker 的上下文健康（A 的机制下沉到 worker 会话）

- worker 会话内 `/continuity` `/handoff` 照常可用；压缩后自动准备对"长驻 worker"放开（现仅 root 会话——差距 G4：以 `delegationDepth>0 且 label 带 worker 标记` 判定身份）。
- **worker 交接 = coordinator 驱动**：worker 达到轮换带 → worker 写最终 checkpoint（报告给 coordinator）→ coordinator 派 successor worker（新会话，注入该 worker 的 checkpoint 快照 + 剩余任务指令）。比 peer 自动轮换更可控，且天然走父子通道。
- 预算护栏（已实现集）：`maxTasks` / `maxConcurrent` / `workerTimeoutMs` / `workerRounds` / `missionTimeoutMs`（mission 行 config，见 §6）；每 worker `max-turns/tokens` 上限**未实现**。

### 4.4 Coordinator 自动承担 reviewer/coordinator 职能

- 通过 prompt 政策实现（coordinator 角色段 + report 处理纪律），不新建服务；模型本就在标准模式全工具下能做审查，这里把它变成**稳定角色**而非临时行为。
- 顶层 mission checkpoint：coordinater 会话内一份带 marker 的持久文档（工作区清单、各 worker 状态、已验收结论、next actions），`/continuity` 可读、重启后从日志重推——coordinator 自己也需要上下文健康，复用同一套机制。

---

## 5. 阶段 C：高级目标自动编排（mission loop）

### 5.1 目标

用户给出一个高级目标 → coordinator 自动分解 → 自动多 worktree + 多 worker 并行 → 每个 worker 内部自动维持上下文健康（A 机制）→ coordinator 审查、汇总、收口，直至完成或阻塞升级。

### 5.2 Mission 记录（持久化中枢）

- coordinator 会话日志中的 mission 文档（marker `<!-- DSH_MISSION v1 -->` + 节：Goal / Workspaces / Progress / Decisions / Open problems / Next actions），全部走标准 `assistant/message`/命令事件 → **进程重启后从日志重推**，无需新存储后端。
- 任务状态行（已实现 `state.results`）：`{ task, spawn{workerId,path,branch,git}, report{tail,hasCheckpoint,lastSeq}, verdict, rounds }`——由 host 驱动器维护为叶子字段 JSON（不序列化 live 对象）；原设计的「工作区矩阵行」（`checkpointSeq`/`reportSeq` 字段）未落地。

### 5.3 编排循环（有界）

```
plan → allocate → dispatch → collect → review → (converge | re-plan | escalate)
```

1. **plan**：coordinator 模型分解目标为 ≤N 个可并行的原子任务（N = `maxConcurrent`，默认 2）。
2. **allocate**：经 §4.2 创建 worktree（审批按设置），登记矩阵。
3. **dispatch**：每任务 spawn 一个 worker（initial prompt = 任务书 + 验收标准 + 报告格式 + "上下文快满时写 checkpoint 并报告"）。
4. **collect/review**：worker report → coordinator 逐条验收（对验收标准的可验证证据）；未过 → 追问/重派（有界重试，默认 1）；worker 轮换 → successor 注入继续（A 机制）。
5. **converge**：全部验收 → mission 收口文档（成果、遗留、建议合并清单——合并仍需人批准）。
6. **escalate**：预算耗尽、审批拒绝、worker 连续失败 → 阻塞上报（`/mission` 状态 + 建议），**绝不静默扩张**。

### 5.4 全局上下文健康

- mission 级视图：各 worker 的 tokens/比率/checkpoint 状态聚合成一张表（host 驱动器按 sessionId 读每会话折叠，只取叶子字段）。
- coordinator 自身达到轮换带 → 触发 A 机制（coordinator 的 checkpoint 就是 mission checkpoint）。

---

## 6. 用户控制与设置面

行内 config（各 host 行 / 预设插件行各自配置，用户可改、热生效；§6 原设计的 settings 命名空间未引入）：

| 行 | 键（默认） | 说明 |
|---|---|---|
| `continuity-rotation` | `rotateRatio`（0.78）、`autoRollover`（`off` / `suggest` / `auto`，默认 `suggest`）、`maxWaitMs`、`cooldownMs`、`oldSession`（`keep` / `archive`，默认 `keep`） | 轮换阈值 / 模式 / 等待与冷却 / 旧会话处置 |
| `continuity-worktree` | `askApproval`（bool，默认 true）、`reportCapChars`、`worktreeMarker`（默认 `-wt-`） | 授权门 / 报告截断 / 临时 worktree 路径标记 |
| `continuity-mission` | `maxTasks`（默认 4）、`maxConcurrent`（默认 2）、`planTimeoutMs`、`reviewTimeoutMs`、`workerTimeoutMs`、`workerRounds`（默认 1）、`missionTimeoutMs` | 任务数 / 并发 / 各阶段超时 / 轮数 / 总预算 |
| `continuity-plugin`（预设） | `warningRatio`、`checkpointRatio`、`rotateRatio`、`prepareAfterCompaction`、`maxCheckpointRetries`、`workerVisibility`（默认 true）、`cleanupSettledWorkers`（默认 false）、`coordinateAutoForward`（默认 true）、`coordinateRelayCap`（默认 20）、`paceCheckMinutes`（默认 30）、`paceCheckIntervalMin`（默认 20） | 阈值三带 / 压缩后准备 / checkpoint 重试 / 子会话 workspace reconcile / 清理 settled worker / 协调自动转发开关与单次突发转发上限 / 自动 pace check 首检与最小间隔 |

> 早期设计的 `handshake-max-rounds`、`merge-policy` 两键未实现（无 handshake 机制；合并永远人工、硬编码无设置）。

命令面（预设插件 v28 注册共 **25 条**，分组）：
- **接力（4）**：`continuity`、`handoff`、`continue`、`rotate`
- **worker（7）**：`worktree`、`workers`、`worker-send`、`worker-stop`、`worker-report`、`worker-successor`、`worktree-cleanup`
- **mission（3）**：`mission`（`<目标>` / `status` / `stop`）、`mission_status`（= `/mission status` 无空格别名）、`status`（裸别名）
- **协调（10）**：`coordinate`、`coordinate-hub`、`coordinate-intake`、`relay`、`steer`（重要消息升级推送，打断目标思考链——有守卫，见 §7e）、`uncoordinate`、`session-peek`、`sessions`、`sessions_active`（未归档且挂 workspace 组，见 §7e）、`current_session`（只回当前会话 id）
- **节奏（1）**：`pace`

MVP 三条命令（`/continuity` `/handoff` `/continue`）行为不变。

---

## 7. 框架差距清单（实测结论，全部可补）

| # | 差距 | 影响阶段 | 修补方式 | 规模 |
|---|---|---|---|---|
| G1 | 无 host 侧旋转/编排驱动器 | A/B/C | 新写 host 插件，挂用户 profile 补丁层 | 中 |
| G2 | 子代理无 per-child cwd（子会话继承父 cwd） | B/C | 给 `SubagentStartRequest` 加可选 `cwd`（向后兼容）；或驱动器直接 `agents.create`+谱系 | 小 |
| G3 | 现成 `ctx.userQuestions` seam 可复用（web profile 已部署），但驱动器尚未接线（实验性、优先级最低，见 T4 产出 C） | A | 接线现成 `ctx.userQuestions` seam（实验性、优先级最低） | 小 |
| G4 | 压缩后自动准备仍仅 root 会话（仍未实现，worker 未放开） | B | 插件策略放开 + worker 身份判定 | 小 |
| G5 | mission 编排引擎不存在 | C | 自写有界循环（或复用 workflow/ralph 引擎外壳） | 大 |
| G6 | worktree 沙箱授权 | B/C | **无需新 API**：现有审批流 + 会话级政策 + 权限预设已足够；缺的是策略设计 | — |

**阶段 A 实现中新增的实测约束**（同样适用于 B/C）：

| # | 约束 | 对策（已实施） |
|---|---|---|
| G7 | **loader 按 URL 缓存导入模块，进程生命周期内不失效**（web profile 的 HMR 行被禁用、watch-only 实例不监视模块）——原地编辑 `.mjs` 在运行进程内不生效，且失败过的模块作业会永远重放同一个错误 | **版本化文件 URL 升级路径**：每次代码变更发布新文件名（`continuity-plugin.v2.mjs`、`continuity-rotation.v3.mjs`），行与补丁更新为新 URL；旧文件保留供已加载代次引用。重启后无此约束（全新导入） |
| G8 | 补丁插入行的 apply 可能早于依赖行完成加载（启动期 `ctx.get` 捕获到 undefined） | **惰性服务读取**：驱动器的全部服务访问在调用期 `ctx.get`，不在 apply 期捕获 |
| G9 | 轮换产物的 checkpoint 若把 next action 写成 `/rotate`，会产生无限轮换链 | **链保护**：`rotate()` 拒绝 `parentSession` 非空的会话（轮换产物上下文新鲜，无轮换需求）——已实测拒绝 |
| G10 | 动态插件沙箱不给 `ctx.fiber`，且 `hmr/config-update-failed` 是唯一直达的刷新失败诊断面 | 驱动器必须是真实 host 行；诊断依赖该事件 + 离线最小 profile 管线测试（`profiles/continuity-smoke`） |

**无需改动**：tokenMeter、sessionReferenceResolver、workspaceRegistry、subagents 通道、sessionQuery 谱系、permission presets——全部现成且已实测。

**§7a 为 MVP V3 交付状态（见 V3 文档）**——§7 各子节从 §7b 起编号，记录 V4 各阶段交付。

**跨代引用（A.8，G7 连带）**：三个 host 驱动器（rotation v7 / worktree v7 / mission v7）现统一从 `continuity-shared.v1.mjs`（绝对 file URL，`~/.dsh/continuity-host/`）导入纯 helper（MARKER/validateCheckpoint/userMessage/capText/textOfMessage/sectionBody/buildInstruction）——**checkpoint 格式单一真相源**；MISSION_MARKER 亦全部从 shared.v1 导入（mission v6/v7、worktree v7 收敛完成，worktree v7 再导出保持兼容）。活动预设挂 v28（`/sessions_active`、`/current_session`、有界 hub onboarding、`--` 用户想法、终局回复转发、peek 去重、`/steer` 重要升级、模式改名 Orchestra、`/mission stop` + 裸 `/status`、**协调链接持久化 + 空闲巡检 + 转发标记闸门** 见 §7e）。checkpoint 格式三代稳定；升级 checkpoint 格式时需同步 shared.v1 一处即可。

---

## 7b. 阶段 A 交付状态（已实现）

- host 驱动器 `continuity-rotation`（v7）经 `~/.dsh/profiles/web/cordis.patch.yml` 热应用上线，发布 `continuityRotation` 服务；配置为行内 config（`rotateRatio`/`autoRollover`(`off|suggest|auto`，默认 `suggest`)/`maxWaitMs`/`cooldownMs`/`oldSession`(`keep|archive`)，见 §6），由 loader 热重载——**替代设计文档 §6 的 settings 命名空间**（settings 注册需要 schemastery schema，零依赖插件不引入；行配置对用户等价可编辑）。v4 起新增：tick 增量游标（O(新事件)）；重复 `/rotate` 幂等；部分成功诚实上报；`waitForCheckpoint` 超时自清理；`rotateSuccessor`（worker successor 轮换，worker 永不自动轮换）。v6 新增：无效 checkpoint 尝试（有 marker 缺节）不再秒中止 `/rotate`，等待合法 checkpoint 受 `maxWaitMs` 约束；v7 新增：轮换 successor 创建后即挂靠源会话 workspace（`workspaceRegistry.attachSession`），GUI 归组不再落 Ungrouped。
- 预设插件（v2 起，现 v28）：`/rotate` 命令 + `/continuity` 的 rollover 行（建议/禁用/进行中/自动武装 + 失败原因）。
- 冒烟实测：终 checkpoint → 建会话（谱系 `parentSession`）→ 注入先于唤醒 → 只做 next action → 链保护拒绝 → 旧会话存活。rotation 20 项驱动器测试全绿（含链保护 / 幂等 / 部分成功诚实上报 / 无效 checkpoint 等待 / successor 工作区挂靠）。
- 未实现（保留后续）：G3 建议卡 UI（当前 `/continuity` 文本建议 + `/rotate` 即确认）；`auto` 模式的 UI 开关（改行配置即开）。

---

## 7c. 阶段 B 交付状态（已实现）

- host 驱动器 `continuity-worktree`（v7）经同一 profile 补丁层热应用上线，发布 `continuityWorktree` 服务；授权门默认开启（会话审批政策非 `never` 时要求 `allowed-once`；`askApproval: false` 显式关闭）。v3 起新增：P0 错误路径修复（事务式回滚、重复启动幂等、审批拒绝零副作用、非 git 诚实分类）；spawn 后 `attachSession(workerId)`（GUI 工作区可见）；`/worktree-cleanup --dry-run|--confirm` 两步清理（保留目录与日志）；`/worker-stop` detach；配置键 `worktreeMarker`（默认 `-wt-`）。v5 新增：worker 完成通知（worker 发 `## Worker report` → coordinator 会话收到一次性提示，`notifyWorkerDone` 默认 true，覆盖普通 /worktree 与 mission 派发）；v6 新增（实验性）：worker 提权/审批请求经 `ctx.userQuestions` **转发到主对话**由人决定（`forwardWorkerApprovals` 默认 true，失败/超时回落到 worker 内提示）；v7：MISSION_MARKER 从 shared.v1 导入（收敛单一真相源，再导出保持兼容）。
- 预设插件（v3 起，现 v28）：`/worktree <任务简报>`、`/workers`、`/worker-send <id> <msg>`、`/worker-stop <id>`、`/worker-report <id>` + `continuity-roles` 提示段（coordinator/worker 角色纪律，order 150）。
- worker = 独立会话（continuity 预设，`meta.cwd`=worktree，`parentSession`=coordinator，`delegationDepth: 1`）——谱系可追溯、语料可持久发现；worker→coordinator 走 `## Worker report` 消息 + `/worker-report` 拉取；coordinator→worker 走驱动器 `followup` 推送（仅活会话）；`/worker-stop` 取消。
- Git 仓库 → `git worktree add <sibling>-wt-<slug> -b <slug>`；非 Git → 普通兄弟目录 + 诚实说明；均注册 `workspaceRegistry`。
- 冒烟实测（真实模型回合）：git 路径 worker 在 worktree 建 `REPORT.md`（内容逐字节校验）→ 规范报告 → `/worker-send` 推送 → worker 回 ACK → `/worker-report` 拉到 → `/worker-stop` ✓；非 Git 路径 worker 建 `hello.txt` ✓；测试 worktree 已清理（合并/删除永远人工）。
- worktree 32 项驱动器测试全绿（含事务式回滚 / 重复启动幂等 / 两步清理 / 完成通知 / 提权转发 / MISSION_MARKER 收敛）。
- 未实现（保留后续）：G2 per-child cwd seam（本实现用驱动器 `agents.create`+谱系绕开，未改框架）。（successor 继承 checkpoint 已由 rotation（v4 起）`rotateSuccessor` + 插件 `/worker-successor` 落地；mission 编排循环见 §7d。）

## 7d. 阶段 C 交付状态（已实现）

- host 驱动器 `continuity-mission`（v7）经同一补丁层热应用上线，发布 `continuityMission` 服务：`/mission <目标>` 启动有界自动循环（plan → 分批派发 worktree worker → 收集 `## Worker report` → coordinator `VERDICT` 审查 → 有界 rework → closeout 持久 mission checkpoint），`/mission status` 全程可查；`/mission stop` 随时取消。
- 驱动器拥有机制与预算（超时/轮数/并发/总预算全部配置化），模型拥有判断（分解/审查/收口），交互经严格标记格式（`TASK|`、`VERDICT:`、mission marker）；任何阶段失败 → 显式升级报告，绝不静默扩张。
- 冒烟实测（真实模型回合）：高级目标自动分解为 2 个任务 → 2 个并行 worktree worker 各自完成（磁盘逐字节验证 `alpha-done`/`beta-done`）→ 双 approve → 持久 mission checkpoint（seq 2101）→ `phase: done`。测试 worktree/分支已清理。
- 147 项单元测试全绿（unit 72 + rotation 20 + worktree 32 + mission 23）；基线 145 为上一代快照。
- v2 起新增：collect 增量游标（O(新事件)）；waits 超时清理 + timer 缺失三级兜底（不悬挂）；并发批次异常隔离；worker 非 live 恢复（`reworkError`）；`capTextSafe` 对安全截断（不劈开 UTF-16 代理对）；`/mission resume`（显式命令、不自动、已收敛幂等）。v4 新增：plan/review 提示要求 Markdown 摘要先行、`/mission status` 报 elapsed 与 settled 进度（人可读输出）；v5 修复：idle 任务 elapsed 显示 n/a 而非伪纪元时长（`startedAt: null`）；v6 新增：`/mission status` 首行说人话进度（`missionSummary`，如"已派 2 个任务给 worker，正在干活、等报告"）；v7 新增：`/mission stop` 取消（清 waits/timer、phase `cancelled` 终态、resume 拒绝、start 可重开、已派 worker 保持运行由 /worker-stop 单独停）。
- 预设插件已迭代至 v28（活动预设挂 `./continuity-plugin.v28.mjs`）：v6 新增 `/mission_status`（`/mission status` 无空格别名，GUI 可能吞掉双 token 形式）；命令面现 25 条（分组见 §6）；v8-v17 为协调/节奏/纪律迭代（见 §7e）；v18 新增 `/sessions_active`（未归档且挂 workspace 组的会话，见 §7e）；v19 新增 `/current_session`（只回当前会话 id，见 §7e）；v20 收紧 hub 上任引导（spoke 是兄弟会话非 subagent——用 /session-peek，禁 list_agents/文件系统翻找；intake 一轮后停下等用户，见 §7e）；v21 支持 `/coordinate-hub <ids> [-- <用户想法>]` 同命令携带用户想法 + 无想法时 intake 后**主动问用户想干啥**（见 §7e）；v22 协调自动转发只转发**回合终局回复**（含 `tool_use` 的中间步消息不再打扰 coordinator，见 §7e）；v23 转发/窥视**双通道读一次**（已转发消息的 seq 记入账本，`/session-peek` 跳过之，`--full` 可强制重读，见 §7e）；v24 新增 `/steer <会话> <消息> [--force]` **重要消息升级推送**（打断目标思考链，忙碌拒绝 + `--force` 仅紧急，见 §7e）；v25 **模式改名**（人类名 → Orchestra（乐团模式），技术命名空间 continuity-* 不变，见 §7e）；v26 接线 `/mission stop`（委托 host mission v7）并新增**裸 `/status` 别名**（见 §7e）；v27 **协调链接持久化 + 空闲巡检**（`hubCheckMinutes` 默认 15，见 §7e）；v28 **转发标记闸门**（`coordinateForwardMarker` 默认空；设置后仅含抬头的终局消息转发）+ **readSession 全量日志恢复兜底**（见 §7e）；v5 新增的 `/worker-successor`、`/worktree-cleanup` 接线与配置键 `workerVisibility`（默认 true，子会话 workspace reconcile）、`cleanupSettledWorkers`（默认 false）保持。
- 未实现（保留后续）：G3 确认卡 UI（`ctx.userQuestions` seam 已可复用但驱动器尚未接线）。

## 7e. 协调 / 节奏 / 纪律 交付状态（已实现，命令 + 提示词层）

插件 v9-v28 在**预设层**（命令 + 提示词/steer，不新增 host 驱动器）迭代协调、节奏与纪律；全部与既有接力/worktree/mission 正交可独立回滚（改回旧插件 URL 即回退，G7 版本化路径）。

- **协调模式（v10）**：`/coordinate <会话>` 两会话**对等直连**——任一方的 assistant 回复**自动互相转发**；转发消息带 `continuity-coord` 源标记，**防循环**（转发消息不再被二次转发）；容量护栏：`coordinateAutoForward`（默认 true，可关）与 `coordinateRelayCap`（默认 20，单次事件突发最多转发条数）。`/relay <会话> <消息>` 免链接单向推送一次；`/uncoordinate` 断开（可指定或 all）。
- **协调者 hub 模式（v11）**：`/coordinate-hub <spoke-id>…` 本会话成为对**已有会话**的星型协调者：每个 spoke 的回复**单向自动转发**到 hub（不回发）；hub 用 `/relay` 定向指挥 spoke、用 `/session-peek <会话> [n]` 只读窥视其上下文。
- **/sessions（v12）**：列出**全部会话**的 id / title / cwd / live 状态（GUI 只显示 title）——解决"看不到会话 id"；用户复制 id 供 `/coordinate`、`/coordinate-hub`、`/relay`、`/session-peek` 使用。
- **/sessions_active（v18）**：列出**未归档**（不在 `workspaceRegistry.archivedSessionIds`）且**挂在 workspace 组**（出现在某 workspace 记录的 `sessionIds` 中，即 worktree/worker 与 subagent 的工作区组）的会话，按组展示（registry 显示序）；归档成员与未分组会话隐藏；`/sessions` 仍是全量列表（含未分组与已归档）。
- **/current_session（v19）**：只输出**当前会话 id**（无任何装饰），供脚本/复制/作为 `/coordinate`、`/relay`、`/session-peek` 的目标。
- **有界 hub onboarding（v20）**：`/coordinate-hub` 上任引导改为有界协议——①spoke 是**兄弟会话而非 subagent**：用 `/session-peek <id> [n]` 窥视，**禁用** `list_agents`/subagent 注册表与文件系统/会话存储翻找（peek 失败就向用户报告，不即兴发挥）；②`/session-peek` 每个 spoke → `/coordinate-intake` **一次**（状态同步问题自动发给全部 spoke）→ 简短综合共享图景 → **停下向用户汇报并等待**：在用户回复前不拟定联合计划、不用 `/relay` 指挥 spoke、不开始内容活；用户新消息即用户自己的想法/指令，优先折入再调解。目的：协调者不再陷入长自主 onboarding 回合（用户在该回合期间无法向会话输入），intake 后即可插话。
- **用户想法随命令携带 + 主动询问（v21）**：`/coordinate-hub <spoke-id>... [-- <你的想法>]` —— `--` 之后的内容作为**用户自己的想法**注入上任引导（"THE USER'S THOUGHTS" 块），coordinator 折叠进综合与方案；带想法时：intake 后汇报共享图景 + **含用户想法的拟议联合计划，并请用户确认/调整**再指挥 spoke；不带想法时：intake 后**停下并向用户主动询问想干啥**（目标/协调点/优先级），未答前不拟计划、不指挥、不干活。usage 与成功回执均提示 `--` 用法。
- **终局回复转发（v22）**：协调自动转发（v10 对等 + v11 hub spoke）**只转发回合终局的 assistant 消息**——内容含 `tool_use` 块的消息视为回合中途（工具调用前的引导文字、步骤间的进展文字），不再转发；此前每个中间步都会向 coordinator 推一条消息、各触发一次完整回合，频繁打扰其思考并污染上下文。纯 thinking/空文本照旧排除；`continuity-coord` 源标记防循环不变。转发路径单点（`onCoordEvent`）生效，v10/v11 同受约束。
- **推送/拉取双通道读一次（v23）**：coordinator 默认**并不**自动看到 spoke 全量历史（只看到转发回复 + 主动 `/session-peek` 的返回），但同一条消息可能"推送一次 + 再拉取一次"重复入上下文。v23 修复：转发成功后把该事件 seq 记入**已转发账本**（`coordForwarded`，按源会话、上限 200 条、unlink 时清除）；接收方（hub 窥 spoke / 对等方互窥）调用 `/session-peek` 时**跳过已转发 seq**（回执注明跳过条数），`--full` 强制重读；hub 自身回复（不转发）不受影响。上任引导同步说明该语义，coordinator 可放心 peek 补细节而不重复读。
- **重要消息升级 /steer（v24）**：`/steer <session-id> <message> [--force]`——把一条**明确标记【重要】**的消息（`continuity-steer` 源标记，防循环语义独立）推送到任意**活会话**（典型：hub 把关键进展升级到**用户主会话**引起注意）。**steer 会打断目标当前思考链，故有硬守卫**：目标 mid-turn（`status === 'running'`）时**拒绝**执行（提示改用 `/relay`——正常排队不打断），`--force` 仅限真正紧急；自身会话与未知目标拒绝。上任引导与角色段写明该纪律（只在真正重要且目标空闲时用）；普通消息一律走 `/relay`。
- **模式改名 Orchestra（v25）**：人类可见模式名 **Orchestra（乐团模式）**（曾用名：接力模式），对应功能范围五域：接力/轮换（乐手轮换）、worktree 并行（声部）、mission 编排（乐谱）、协调指挥（指挥/执棒）、节奏感知（节拍）。**技术命名空间全部不变**：预设 id `continuity`、24 条命令、`continuity-*` 服务/文件/源标记、checkpoint marker；仅预设显示名（`preset.yml`）、插件角色段标题、文档标题更新；历史规范文档（CREATION_MODE/DEEPSEEK_SYSTEM/CHANGELOG 等）原样保留为历史记录。
- **协调链接持久化 + 空闲巡检（v27）**：解决"复杂任务无人值守持续工作"的两个断点——①**链接耐久**：`/coordinate` `/coordinate-hub` 把链接以 `<!-- DSH_COORD_LINKS v1 -->` 记录（`hub=<id> spokes=…` / `peers=<id>`）注入各会话日志；进程重启后插件按会话惰性恢复（restore-once），转发路径与 hub 结构自动重建；`/uncoordinate` 同步改写记录。②**空闲激活**：有 spoke 的 hub 静默超过 `hubCheckMinutes`（默认 15 分钟）且期间无任何入站消息（用户或转发）时，主动 steer 一次轻量 "Coordinator check-in"（peek 各 spoke——去重感知；有完成/卡住的用 `/relay` 调解或向用户报告；一切正常则一行回复保持安静）；忙碌 agent 绝不打断；巡检由 host timer 服务驱动（无 timer 的环境纯事件驱动，测试进程不悬挂）。效果：coordinator 从"停下等用户"升级为"停下、等用户、同时定期照看合奏"。
- **转发标记闸门 + 恢复兜底（v28）**：新配置 `coordinateForwardMarker`（默认空 = 全量终局转发；设置如"请coordinate以下消息"后，**仅含该抬头的终局消息**自动转发）——spoke 想介入就抬头，hub 只收到值得处理的消息，其余进度靠 v27 巡检兜底：**hub 上下文零 ack 噪音、零小消息稀释**（对等直连与 hub 模式同闸门，v22 中途过滤优先级更高）；链接恢复加 `sessionQuery.readSession` 全量日志兜底（内存事件被压缩剪掉记录时仍能重建链接）。
- **协调者 intake + 调解（v13）**：`/coordinate-hub` 激活即向 hub 会话注入上任引导——先对各 spoke **各问一次**任务/进展/阻塞（`/relay` 发出，回复自动转发回来）→ 综合**共享图景** → **老板式调解**（像 lead 一样对每个 spoke 产出建设性/安全/创造性的共同方案，绝不单方面强推）；`/coordinate-intake` 可随时对全部 spoke 重跑状态同步问题。
- **节奏感知（v14）**：会话活跃超 `paceCheckMinutes`（默认 30 分钟）后按 `paceCheckIntervalMin`（默认 20 分钟）间隔自动注入 "Pace check" 反思（**是否真的需要这么久** / 能否缩小范围 / 并行 / 是否升级，或 /handoff）；`/pace` 手动立即触发；纯函数 `paceDue` 导出可测；配合 mission 硬预算 `missionTimeoutMs`（§6）构成时长双护栏。
- **纪律四则（提示词层，v9/v15/v16/v17）**：
  - **愿景纪律（v9）**：改 README/愿景/设计文档前先读既定愿景并说明如何保持目的；绝不删/替换愿景；文档与现实的漂移记入 Open problems 而非侵蚀愿景。
  - **协调者 = 委托者（v15）**：coordinator 不做内容活；被要求直接干活时**礼貌推辞并转派**给对应 worker/spoke；保持对用户响应、把新问题 triage 给正确 worker；checkpoint 必须记录协调者角色 + spoke id，使 `/rotate` `/continue` 后角色保留、后继可用 `/coordinate-hub <ids>` 重建。
  - **单委托机制（v16）**：同一任务**绝不既走 worktree worker 又走 subagent**（修复"worker split"：同一任务同时以 worktree worker 与直接 subagent 出现）；已有 worker 的任务用 `/worker-send` 扩展而非再开 subagent。
  - **委托选择规则（v17）**：按任务需求选机制，见下表：

| 任务场景 | 机制 | 机制事实 |
|---|---|---|
| 需**干净隔离工作区**（文件写入、长任务、独立目录） | **worktree worker**（`/worktree`） | 独立工作区 + 独立会话 + 独立 token 折叠与 `/continuity` 状态；完成通知 + 提权转发到主对话（§7c） |
| 不需干净工作区、但会**污染 coordinator 上下文**（调研、搜索、噪音工具输出、多中间步） | **subagent 工具** | 共享 cwd、隔离上下文（coordinator 上下文保持干净）；不隔离文件写入 |
| 快速小活、低噪音、无需隔离 | **自己做** | 不引入子代理开销；不违反上述两规则即可 |

- 上述协调/节奏/纪律均为**提示词层**约束 + 命令接线：模型大概率遵循、非硬性强制。

## 8. 测试与验收

每阶段验收（沿用 V3 风格：单元 + 真实会话冒烟）：

- **A**：阈值/unknown 容量；建议不重复；确认前零动作；确认后全链路（终 checkpoint → 新会话 → 注入先于唤醒 → 只做 next action）；新会话创建失败回滚；非 Git workspace；重启后状态从日志重推；旧会话存活不被关。
- **B**：worktree 创建/注册/归档全周期；审批流（拒绝=不建）；worker report 双向通道实测；worker 轮换 = successor 继承 checkpoint；并发上限与追问上限；merge 永不自动。
- **C**：小型真实目标端到端（≥2 worktree 并行）；阻塞升级路径；进程重启后 mission 从 durable 恢复；预算护栏生效；最终验收"每个 worker 至少经历一次上下文轮换仍完成任务"。
- 回归：MVP 31 项单元测试（V3 历史基线）；当前 147 项全绿（unit 72 + rotation 20 + worktree 32 + mission 23，见 §7d/§7e）；`/handoff` `/continue` 行为不变。

---

## 9. 风险总表与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 无人值守自动旋转误伤在跑工作 | 安全边界-only；默认 `suggest`；`auto` 需显式开启 | 设置切回 `off` |
| worktree 在主 workspace 外触发沙箱/审批 | 默认 `askApproval: true`；会话级授权是显式动作 | 设置 `askApproval: false`；驱动器行禁用 |
| worker 膨胀/成本失控 | 并发、回合、追问全部有界；预算护栏 | 停用 mission；删除 host 行 |
| 报告丢失/worker 卡死 | `interrupt` + 有界重派 + 谱系查询兜底 | 人工接管：所有中间产物在 worktree + 会话日志 |
| 协调转发循环 / relay 洪泛 | `continuity-coord` 源标记防循环；`coordinateRelayCap` 容量护栏（单次突发上限）；pace 频率护栏（`paceCheckIntervalMin`）；转发 best-effort 失败静默 | 关 `coordinateAutoForward` / 调低护栏（行配置） |
| host 补丁层误伤运行中 GUI | 补丁只 insert/disable 行；live 热载机制本身有校验 | 删补丁行即回滚，不影响预设与已存会话 |

**回滚层级（自上而下）**：设置开关 → 禁 host 行 → 删 profile 补丁行 → （最坏）删预设。任何一层回滚后，既有会话日志与 checkpoint 均保留，旧会话可继续手工 `/continue`。

---

## 10. 实施顺序与工作量

1. **阶段 A**（小-中）：G1+G3 一次交付；MVP 全部复用。产出 = 你问题 1、2 的答案。
2. **阶段 B**（中-大）：G2+G4+worktree 驱动器；A 已就位。产出 = 你问题 3 的答案（coordinator/worker/双向对话）。
3. **阶段 C**（大）：G5 编排循环，B 全部复用。产出 = 最终形态（高级目标 → 自动多 worktree 并行实现）。

每阶段独立上线、独立验收、独立回滚；阶段间无破坏性迁移（MVP 用户不升级也一切照旧）。
