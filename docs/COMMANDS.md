# COMMANDS.md — Orchestra（乐团模式）命令全集

> 当前版本：预设插件 v5 / rotation v4 / worktree v3 / mission v2。
> 12 条专属命令 + 6 条继承自标准模式。

## 一、上下文健康

### `/continuity`
读-only 状态面板：实测 tokens、上下文容量（未知即 `unknown`）、比率、压缩次数、checkpoint 状态（机器态 + 持久 seq）、`worker visibility` 行、分档建议（0.60 提醒 / 0.70 建议交接 / 0.78 建议轮换）、worker successor 提示。
- 无参数；随时可跑。

### `/handoff`
在下一个**安全回合边界**（或空闲时立即）让当前会话写交接 checkpoint：标记 `<!-- DSH_CONTINUITY_CHECKPOINT v1 -->` + 8 个必需章节 + 唯一 Next atomic action；post-commit 持久校验通过才算 `ready`；无效自动重试 1 次。
- 幂等：已 pending/checkpointing/ready 不重复调度。
- 绝不打断正在跑的工具调用。

### `/continue <session-id-or-title>`
在**空白**会话中从旧会话继续：精确 id → 精确标题 → 唯一匹配（歧义/无匹配/自引用全部拒绝）；注入有界快照（明确标注为背景资料）→ 唤醒指令 → 新会话核实 workspace 后**只做** checkpoint 的 next atomic action。

### `/rotate`
一键确认式轮换：终 checkpoint（复用 `/handoff` 机制）→ 自动在同 workspace 建新会话（`parentSession` 谱系）→ 快照注入先于唤醒 → 旧会话保持存活。
- **链保护**：轮换产物会话再 `/rotate` 会被拒绝（上下文本来就是新鲜的）。

## 二、worktree / worker

### `/worktree <task brief>`
开 worker：Git 仓库 → `git worktree add <兄弟目录> -b <分支>`；非 Git → 普通兄弟目录（诚实注明）；登记 `workspaceRegistry`；派发独立 worker 会话（同预设、独立 cwd、谱系）并注入任务书。
- 授权门：审批政策非 `never` 时要求 `allowed-once`（GUI 弹确认）。

### `/workers`
列出本 coordinator 的全部 worker（id / 工作区 / 在线状态）+ mission checkpoint 状态。

### `/worker-report <worker-id>`
拉取 worker 最新消息/`## Worker report` + checkpoint 事实（有界截断；不要求 worker 存活）。

### `/worker-send <worker-id> <message>`
coordinator → worker 实时消息（仅存活 worker；worker 处理完可回复）。

### `/worker-stop <worker-id>`
取消存活 worker 并解除其工作区挂靠。

### `/worker-successor <worker-id> [remaining instruction]`
worker 写完终 checkpoint 并报告后，coordinator **显式**派 successor 继承其 checkpoint 与 cwd 继续；同一 checkpoint 只派一次（幂等）。worker 自身永不自动轮换。

### `/worktree-cleanup --dry-run | --confirm`
两步清理：dry-run 只列（零变更）；confirm 解除已 settled worker 的工作区挂靠并删除空工作区**注册记录**——目录与会话日志永远保留；live worker 跳过。

## 三、mission 编排

### `/mission <goal>`
启动有界自动循环：分解（≤4 任务）→ 并行派发 worktree worker → 收集 `## Worker report` → coordinator `VERDICT` 审查 → 有界返工 → 收口持久 mission checkpoint（`<!-- DSH_MISSION v1 -->` + 6 节）。任何阶段超时/失败 → 显式升级报告。

### `/mission status`
phase / goal / 每任务裁决 / worker 矩阵 / 最近错误。

### `/mission resume`
从会话日志中最近一次持久 mission checkpoint 重建状态机并续跑（显式命令，绝不自动；已收敛幂等）。

## 四、继承自标准模式

| 命令 | 用途 |
|---|---|
| `/compact` | 手动压缩历史（`/continuity` 的压缩计数来源） |
| `/plan` | 计划模式：只读探索、先出完整方案再动手 |
| `/goal` | 持久目标（跨轮自动延续） |
| `/permission` | 切换会话权限预设（read-only / workspace-write / danger-full-access）——决定 worktree 授权门与审批行为 |
| `/feedback` | 消息反馈 |
| `/export` | 导出会话日志 |

## 五、典型组合

```
看压力:      /continuity
长任务存档:  /handoff   → (新会话) /continue <id>
上下文快满:  /compact   → 还高 → /rotate
并行拆解:    /mission <高级目标>   （或手动 /worktree + /worker-report + /worker-send）
worker 接班: (worker) /handoff 报告 → (coordinator) /worker-successor <worker-id>
收尾清理:    /worktree-cleanup --dry-run → --confirm（经同意）
```
