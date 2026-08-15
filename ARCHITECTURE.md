# ARCHITECTURE.md — Orchestra（乐团模式）架构

> 目标读者：想理解或修改本项目的开发者。
> 所有结论均来自实测（源码级验证 + 真实会话冒烟），非推断。

## 1. 目标与设计原则

把"上下文连续性"做成 DeepSeek Harness 的用户级系统能力：

- **持久**：文件全部位于用户自有目录（`~/.dsh`），重启即恢复，不随会话消散；
- **可验证**：交接产物（checkpoint/mission）带标记、有必需章节、持久化在会话日志中，读取方校验而非信任；
- **有界**：所有自动机制带超时/轮数/预算上限，失败显式升级，绝不静默扩张；
- **可回滚**：版本化文件 + 补丁层，任何一步都能退回上一版本；
- **零侵入**：不修改出厂安装、不动业务仓库、不动 Host 组合的出厂部分。

## 2. 平面划分

| 平面 | 职责 | 实例 |
|---|---|---|
| **Host**（进程单例，跨会话） | 会话/Agent 创建、跨会话快照、token 计量、worktree 授权、mission 编排循环 | 三个驱动器（经用户 profile 补丁层挂载） |
| **预设**（每会话一份） | 命令、角色 prompt、每会话状态机、Host 服务消费 | `continuity` 预设 + 伴生插件 |

硬性规则：预设行发布 Service 必须置于 `isolate` realm 组（本项目的 `sessionReferenceResolver` 即如此）；驱动器只做调用期惰性 `ctx.get`。

## 3. 组件清单（当前版本）

| 组件 | 版本 | 真实文件 | 发布/注册 | 命令面 |
|---|---|---|---|---|
| 预设插件 | v5 | `.agent-presets\continuity\continuity-plugin.v5.mjs` | 12 条命令 + `continuity-roles` prompt 段 | 全部专属命令 |
| 轮换驱动器 | v4 | `continuity-host\continuity-rotation.v4.mjs` | `continuityRotation` | `/rotate`、`/worker-successor`（经预设） |
| worktree 驱动器 | v3 | `continuity-host\continuity-worktree.v3.mjs` | `continuityWorktree` | `/worktree` `/workers` `/worker-send` `/worker-stop` `/worker-report` `/worktree-cleanup` |
| mission 驱动器 | v2 | `continuity-host\continuity-mission.v2.mjs` | `continuityMission` | `/mission` `/mission resume` `/mission status` |

## 4. 运行时拓扑

```mermaid
graph TD
    subgraph "浏览器 / GUI"
        S1[根会话（coordinator）]
        S2[worker 会话]
        S3[轮换产物会话]
    end
    subgraph "进程 Host"
        ROOT[Host 组合（出厂 + 用户补丁层）]
        R4[continuity-rotation v4]
        W3[continuity-worktree v3]
        M2[continuity-mission v2]
        SR[sessionReferenceResolver（预设 isolate realm）]
    end
    subgraph "预设 standing mount（每代一次）"
        P5[插件 v5 实例<br/>每会话状态按 sessionId 键控]
    end
    ROOT --> R4
    ROOT --> W3
    ROOT --> M2
    S1 -.->|scope parent| P5
    S2 -.->|composeFrom / mount| P5
    S3 -.->|mount| P5
    S2 -->|parentSession 谱系| S1
    S3 -->|parentSession 谱系| S1
    P5 --> R4
    P5 --> W3
    P5 --> M2
    P5 --> SR
```

要点：

- **standing mount**：预设组合按进程代次挂载一次，同代所有会话共享插件实例；状态按 `sessionId` 键控，互不串扰。
- **谱系**：worker/轮换产物/子代理都在 header 里带 `parentSession`——发现、追溯、链保护全部依赖它。
- **热应用**：补丁行换 URL 即热换驱动器（新模块 = 新 import）；预设插件换版需触碰组合文件开新代次（只影响之后的新会话）。

## 5. 交接状态机（预设插件）

```mermaid
stateDiagram-v2
    [*] --> normal
    normal --> pending : /handoff 或压缩后自动准备
    pending --> checkpointing : 安全边界（turn-stopping/idle）→ steer
    checkpointing --> ready : post-commit 校验通过
    checkpointing --> checkpointing : 无效尝试 → 有界重试（≤1）
    checkpointing --> failed : 重试耗尽
    failed --> pending : 再次 /handoff（重来）
    ready --> [*]
    note right of checkpointing : steer 仅发生在<br/>安全边界，绝不打断<br/>工具调用
```

持久性：`ready` 永远以日志中带标记的 `assistant/message`（seq）为证据；重启后由日志重推，**无假就绪**。

## 6. `/rotate` 时序（确认式轮换）

```mermaid
sequenceDiagram
    participant U as 用户
    participant P as 预设插件 v5
    participant R as rotation v4
    participant M as 模型
    participant A as agents 注册表
    U->>P: /rotate
    P->>R: rotate(agent)
    R->>R: 链保护（parentSession 拒绝）<br/>幂等（已有有效 checkpoint 且无新输入 → 复用）
    R->>P: 触发 /handoff（若需终 checkpoint）
    M-->>R: 写 checkpoint（安全边界回合）
    R->>R: 持久校验（marker + 8 节）
    R->>A: create(新会话, meta.cwd=同 workspace, parentSession=旧id)
    R->>A: inject(有界快照) → followup(指令) 唤醒
    Note over R,U: 旧会话保持存活；新会话只做 next action
```

## 7. mission 编排循环（有界自动）

```mermaid
flowchart TD
    Start([/mission 目标]) --> Plan[plan：模型分解<br/>TASK 行格式，1 次格式重试]
    Plan -->|超时/无效| Esc[escalate：显式阻塞报告]
    Plan --> Dispatch[dispatch：分批派发<br/>worktree worker ≤ maxConcurrent]
    Dispatch --> Collect[collect：轮询 ## Worker report<br/>per-worker 超时]
    Collect -->|超时| Fail[任务失败记录]
    Collect --> Review[review：coordinator VERDICT<br/>approve / rework]
    Review -->|rework 且轮数内| Send["/worker-send 返工指令"] --> Collect
    Review -->|approve| Done{全部任务完成?}
    Review -->|轮数耗尽| Fail
    Done -->|否| Dispatch
    Done -->|是| Close[closeout：持久 mission checkpoint<br/>marker + 6 节]
    Close --> Finished([phase: done])
    Esc --> Finished
    Fail --> Finished
    Finished -->|显式命令| Resume[/mission resume<br/>从 checkpoint 重建状态机/]
```

预算护栏：`maxTasks`/`maxConcurrent`/`planTimeoutMs`/`reviewTimeoutMs`/`workerTimeoutMs`/`workerRounds`/`missionTimeoutMs` 全部行内可配；任何超时只影响对应阶段并显式上报。

## 8. 持久事实与恢复

| 事实 | 存储 | 恢复方式 |
|---|---|---|
| 交接 checkpoint | 会话日志 `assistant/message`（marker + 8 节） | 日志反向扫描 + 校验；`/continue` 快照或日志召回注入 |
| mission checkpoint | coordinator 会话日志（mission marker + 6 节） | `/mission resume` 从 `## Goal` 节重建并续跑 |
| worker 记录 | 会话 header（`parentSession`/`cwd`/`delegationDepth`）+ `workspaceRegistry` | `sessionQuery.listSessions` 按父过滤；attach 后 GUI 分组可见 |
| 会话状态机 | 代内内存 Map | 重启归位；一切对外"就绪"状态均以持久事实为证据 |

## 9. 升级与回滚机制

```mermaid
flowchart LR
    Edit[改 .mjs] -->|发布| New[新版本文件 vN+1]
    New --> Ref[更新全部引用：<br/>web/smoke patch、组合、测试 import、管线]
    Ref --> Touch[预设插件则触碰组合文件]
    Touch --> Test[110 项测试 + dump-config + 离线管线]
    Test --> Sync[sync-deploy.ps1] --> Commit[提交]
    Rollback[回滚] -->|改回旧 URL| New
    Rollback -->|禁行| Disable[补丁行 disabled: true]
    Rollback -->|删除| Remove[删补丁行 / 删预设]
```

## 10. 框架约束清单（实测，编号沿用 V4 设计文档）

- **G7** loader 按 URL 缓存模块、进程内不过期 → 版本化文件升级铁律。
- **G8** 补丁插入行 apply 可能早于依赖行加载 → 惰性 `ctx.get`。
- **G9** 轮换产物再轮换会无限递归 → 链保护。
- **G10** 动态插件沙箱不给 `ctx.fiber` → 驱动器必须是真实 host 行；失败诊断面 = `hmr/config-update-failed` + 离线管线。
- 另有：预设服务需 isolate realm；`session/event` 经 scope parent 可见；standing 代次以组合文件 stamp 换代；subagent 会话在 GUI 工作区组默认被客户端过滤（`ui-workspace/tree.ts` L118-119，PR 待合）。

## 11. 已知限制与路线图

| 项 | 状态 |
|---|---|
| mission 跨重启自动续跑 | `/mission resume` 显式续跑已实现；全自动恢复未做 |
| coordinator → worker 推送 | 仅存活 worker；持久报告永远可拉取 |
| 建议卡 UI（G3） | 未实现（`/continuity` 文本建议 + `/rotate` 即确认） |
| subagent 会话工作区可见 | 平台过滤，PR 分析就绪（方案 A 最小改动） |
| G2 per-child cwd seam | 未改框架，用 `agents.create` + 谱系绕开 |
