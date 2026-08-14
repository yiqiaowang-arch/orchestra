# CHANGELOG.md — 版本史

## v5/v4/v3/v2 — 优化轮（2026-08-14）

**插件 v5 · rotation v4 · worktree v3 · mission v2**（旧代次全部保留，110/110 测试）

- 热路径：增量游标替代全量 `session.events` 扫描（O(新事件)，语义等价有测试）。
- 稳健性：`/rotate` 幂等 + 部分成功诚实上报；waits 超时自清理 + timer 缺失三级兜底；worktree 事务式回滚（非强制）、审批拒绝零副作用、非 Git 诚实分类；mission 并发批次异常隔离、`capTextSafe` 代理对安全截断。
- 新能力：`/mission resume`（显式、从持久 checkpoint 重建）、`/worker-successor`（coordinator 显式派 successor 继承 checkpoint）、`/worktree-cleanup --dry-run|--confirm`（两步清理，目录/日志保留）、`workerVisibility` 子会话 workspace reconcile。
- 测试 60 → **110**（+50）；文档=真相（V3/V4 设计文档逐条修正）。

## V4-C — 自动 mission 编排（2026-08-14）

- `continuity-mission` v1：有界自动循环（plan → 分批 worktree worker → collect → VERDICT 审查 → 有界 rework → 持久 mission checkpoint | escalate）。
- `/mission <目标>`、`/mission status`；mission marker `<!-- DSH_MISSION v1 -->`。
- 真实冒烟：2 任务并行 worktree → 双 approve → 磁盘产物逐字节验证 → `phase: done`。

## V4-B — worktree + coordinator + worker（2026-08-14）

- `continuity-worktree` v1/v2：授权式 `git worktree add`（非 Git → 普通兄弟目录）、`workspaceRegistry` 登记、worker 会话（独立 cwd + `parentSession` 谱系）、双向通道（`/worker-send` 推送、`/worker-report` 拉取、`/worker-stop` 取消）。
- 预设 v3：`/worktree` `/workers` `/worker-send` `/worker-stop` `/worker-report` + `continuity-roles` 角色 prompt 段。

## V4-A — 确认式自动交接（2026-08-13/14）

- `continuity-rotation` v1-v3：`/rotate` 一键轮换（终 checkpoint → 自动建会话 → 注入先于唤醒 → 只做 next action）；阈值建议 + `autoRollover` 可选自动；链保护防递归。
- 预设 v2：`/rotate` + `/continuity` rollover 行。

## V3 — MVP（2026-08-13）

- 预设 `continuity`（接力模式），复制自 `standard`，官方 roster 创建。
- `/continuity`（压力/容量/比率/压缩/checkpoint/建议）、`/handoff`（安全边界 8 节 checkpoint + 持久校验 + 有界重试）、`/continue`（精确匹配 + 有界快照注入先于唤醒）。
- 持久伴生插件（预设目录相对行）；`sessionReferenceResolver` 预设 isolate realm（本部署 host 无此服务）。
- 挂载验证 + 跨仓库冒烟（非 Git 诚实记录）通过。
