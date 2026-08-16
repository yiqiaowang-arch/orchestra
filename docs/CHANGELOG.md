# CHANGELOG.md — 版本史

## 仓库：deploy 镜像只留当前版本（2026-08-17）

- `sync-deploy.ps1` 重写：从 web patch / 组合行**自动解析当前版本**（正则锚定 `name:` 行，注释里的旧版本号不再干扰），只镜像当前版本；deploy 中非当前文件自动移入 `deploy\archive\`（55 个旧代次归档，回滚时取回即可，install.ps1 永不复制）。
- live `~/.dsh` 目录照旧保留全部代次（红线 4 不变）。

## v32/v8 — 轮换链接迁移 + 标记收敛（2026-08-17）

**插件 v32 · rotation v8 · worktree v8 · mission v8 · shared v2**（旧代次全部保留，153/153 测试）

- **rotate 本意落地**：rotation v8 创建继任者时自动迁移协调链接——扫描源 hub 日志最新 `<!-- DSH_COORD_LINKS v1 -->` 记录 → `hub=` 改写为继任者注入其日志；给每个 spoke 注入新 `hub=<继任者>` 记录（恢复时最新记录胜出，spokes 重启后自动指向新 hub，无双重转发、无需手动 /coordinate-hub）；`/worker-successor` 同样继承 worker 链接。
- **COORD_LINK_MARKER 收敛**：shared.v2 新增导出，插件 v32 与 rotation v8 共用同一绑定（单一真相源闭环）；worktree/mission v8 仅 import URL 前移，逐字节等价。
- 测试 151 → **153**（+2：链接迁移 / 无记录不迁移）。

## v31 — 压力感知巡检（2026-08-17）

**插件 v31**（驱动器不变；151/151 测试）

- hub 巡检升级为"进度 + 压力"双查：每次 check-in 顺带测每个 spoke 的上下文压力（tokenMeter + llm 容量，与 /continuity 同口径），超过 rotateRatio 的 spoke 在巡检提示里给出 **CONTEXT PRESSURE ALERT**（worker → `/worker-successor` 提示；其他 → 建议用户 `/rotate`）；容量未知跳过、非 live 报告。
- 纯函数 `spokePressureAlert` 导出可测；巡检提示 `hubCheckPrompt` 支持 alerts 块。
- 测试 149 → **151**（+2：压力告警数学 / 提示含 alerts 块）。

## v30 — 完成报告必达（2026-08-17）

**插件 v30**（驱动器不变；149/149 测试）

- 转发闸门对含 `## Worker report` 的终局消息**放行**（绕过 marker 检查）——spoke 干完即使不发协调标记也能直达 hub。
- 角色段协议新增硬性要求：**任务结束必须以 marker 或 `## Worker report` 收尾**（哪怕无事可协调），否则 hub 只能等下次巡检。
- 测试 148 → **149**（+1：无 marker 的完成报告仍转发）。

## v29 — 标记协议进角色段（2026-08-16，深夜）

**插件 v29**（驱动器不变；148/148 测试）

- 转发标记协议写入**角色段**（每个会话的系统提示，spoke 也读得到）：配置 `coordinateForwardMarker` 后无需再靠上任引导转达，重启即自动生效，无需重跑 `/coordinate-hub`。
- 默认装配启用：`agent.cordis.yml` 插件 config 现带 `coordinateForwardMarker: 请coordinate以下消息`。
- 测试 147 → **148**（+1：角色段含协议 / 未配置缺席）。

## v28 — 转发标记闸门 + 恢复兜底（2026-08-16，深夜）

**插件 v28**（驱动器不变；147/147 测试）

- **标记闸门** `coordinateForwardMarker`（默认空 = 全量终局转发）：设置后仅含抬头的终局消息自动转发——spoke 想介入就抬头，hub 零 ack 噪音、零小消息稀释；其余进度靠 v27 巡检兜底。
- **恢复兜底**：链接恢复加 `sessionQuery.readSession` 全量日志扫描（内存事件被压缩剪掉记录时仍重建链接）。
- 测试 145 → **147**（+2：标记闸门 / readSession 兜底恢复）。

## v27 — 协调链接持久化 + 空闲巡检（2026-08-16，同日晚）

**插件 v27**（驱动器不变：rotation v7 / worktree v7 / mission v7 / shared v1；145/145 测试）

- **链接耐久**：`/coordinate` `/coordinate-hub` 把链接以 `<!-- DSH_COORD_LINKS v1 -->` 记录注入各会话日志；进程重启后按会话惰性恢复（restore-once），转发与 hub 结构自动重建；`/uncoordinate` 同步改写。
- **空闲激活**：有 spoke 的 hub 静默超 `hubCheckMinutes`（默认 15 分钟）且无入站消息时，主动 steer 轻量 "Coordinator check-in"（peek 去重感知 → 有完成/卡住则调解或报告 → 一切正常一行回复保持安静）；忙碌 agent 绝不打断；巡检由 host timer 驱动（无 timer 环境纯事件驱动）。
- 测试 141 → **145**（+4：parseLinkRecord / hubCheckDue+clamp / 重启恢复 / 空闲接线）。

## v26/v7/v7/v7 — Orchestra 品牌 + mission 取消（2026-08-16）

**插件 v26 · rotation v7 · worktree v7 · mission v7 · shared v1**（旧代次全部保留，141/141 测试）

- 品牌：人类名 接力模式 → **Orchestra（乐团模式）**（技术命名空间 continuity-* 不变）；仓库改名 `orchestra`；双语 README（动机/做法/用法/快速开始）+ MIT LICENSE。
- 会话：`/sessions_active`（未归档 + workspace 组内）、`/current_session`（只回当前 id）。
- 协调：有界 hub onboarding（spoke=兄弟会话非 subagent）、`/coordinate-hub <ids> [-- 你的想法]`、终局回复转发（v22）、推送/拉取读一次（peek 去重）、`/steer` 重要升级（忙碌守卫）。
- mission：`/mission stop` 取消（v7，phase `cancelled` 终态）、裸 `/status` 别名、`/mission_status`、说人话进度。
- 收敛：worktree v7 的 MISSION_MARKER 从 shared.v1 导入（单一真相源闭环）。
- 测试 136 → **141**（+5）；文档=真相（V4 §7e 等全量同步）。

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
