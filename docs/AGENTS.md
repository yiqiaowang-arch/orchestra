# AGENTS.md — 本仓库的 Agent 工作协议

> 在 Orchestra（乐团模式，曾用名：接力模式；或任何预设）中打开本仓库工作时，本文件即权威协议。
> 违反"红线"或"版本铁律"的改动视为失败提交。

## 1. 本仓库是什么

DeepSeek Harness 的上下文接力能力栈：预设 `continuity`（Orchestra 乐团模式，曾用名：接力模式）+ 三个 host 驱动器，全部用户自有、位于 `~/.dsh` 下、与业务仓库解耦。`deploy/` 是**真实运行文件**的镜像——运行位置由 harness 固定（见 §8），仓库通过镜像进行版本控制。

## 2. 红线（违反即失败）

1. **绝不修改**出厂 Harness 安装（`C:\Users\wangy\Documents\GitHub\deepseek-harness\` 只读参考）；绝不修改当前项目工作区（你的 session cwd）。
2. **护栏只许加强**：worktree 授权门（审批 `ask` 必须 `allowed-once`）、`/rotate` 链保护（拒绝 `parentSession` 会话）、worker 永不自动轮换、绝不自动 merge/checkout/reset/clean。
3. 预设行发布 Service 必须置于 `isolate` realm 组；驱动器服务访问必须**调用期惰性 `ctx.get`**。
4. 旧代次文件**永远保留**（运行中的进程可能仍引用它们）。

## 3. 版本铁律（唯一合规的改码方式）

Loader 按 URL 缓存模块、进程内永不过期（G7）。因此：

1. 任何 `.mjs` 内容修改 = 发布**新版本文件**（文件名 +1 版本号，如 `continuity-rotation.v5.mjs`）；
2. 更新**全部**引用：`profiles\web\cordis.patch.yml`、`profiles\continuity-smoke\cordis.patch.yml`、`agent.cordis.yml`（预设插件行）、4 个测试文件的 import、`patch-pipeline-test.mjs`；
3. 预设伴生插件换版 = 同时触碰 `agent.cordis.yml`（standing 代次以组合文件 stamp 换代）；
4. 旧版本文件原地保留；
5. 跨代 import 只允许指向**保留的旧代次**（导出不得再变）。

## 4. 测试门禁（每个改动）

```powershell
node tests\continuity-unit-tests.mjs       # 76
node tests\continuity-rotation-tests.mjs   # 20
node tests\continuity-worktree-tests.mjs   # 32
node tests\continuity-mission-tests.mjs    # 23   —— 合计 151，必须全绿
node C:\Users\wangy\Documents\GitHub\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config
node C:\Users\wangy\Documents\GitHub\deepseek-harness\apps\cli\lib\bin.js --profile continuity-smoke
node tests\validate-mermaid.mjs   # 所有 ```mermaid 图必须解析通过
```

- 每个新纯函数都要有单元测试；行为改动要有等价性/回归测试。
- 热应用失败的唯一直达诊断面：监听 `hmr/config-update-failed` 事件；离线管线结果见 `pipeline-result.json`。

## 5. 提交协议

1. 改码（按 §3）→ 测试全绿（§4）；
2. 运行 `powershell -ExecutionPolicy Bypass -File scripts/sync-deploy.ps1`；
3. **文档=真相**：同步更新 `docs\MANIFEST.md`（版本/引用表）与 `docs\CHANGELOG.md`；行为变化更新 `docs\COMMANDS.md` 与 `docs\ARCHITECTURE.md`；
4. `git add -A && git commit`（一条逻辑改动一条提交）；
5. 真实会话验证走 §7 清单，结果写进提交说明或报告。

## 6. 交接协议（本仓库长任务强制）

- 长任务（多轮改动）收尾**必须**运行 `/handoff` 并确认 `/continuity` 显示 `ready (durable: seq N, valid)`——把交接文档写进仓库（`docs\handoffs\` 或报告内），让下一个会话可 `/continue`。
- 报告模板：改动清单（文件级）→ 测试结果 → 部署状态（热应用/需新会话）→ 遗留风险 → 回滚路径 → 用户验证清单。

## 7. 用户验证清单（真实会话冒烟模板）

1. 新会话跑 `/continuity` → 出现 `worker visibility` 行；
2. `/handoff` 两次 → 第二次幂等提示；
3. Git 仓库 `/worktree <简报>` → worktree + worker 建起且工作区组内可见；
4. `/worktree-cleanup --dry-run` 零变更；`--confirm` 需用户同意；
5. `/mission <小目标>` → `status: done`；`/mission resume` → "already converged"；
6. 护栏：successor/轮换产物 `/rotate` 被拒绝；coordinator 连跑 `/rotate` 第二次幂等。

## 8. 目录地图（绝对路径）

| 路径 | 内容 |
|---|---|
| `C:\Users\wangy\.dsh\.agent-presets\continuity\` | 预设（组合 + 插件全代次 + preset.yml） |
| `C:\Users\wangy\.dsh\continuity-host\` | 三个驱动器全代次 + 离线管线设施 |
| `C:\Users\wangy\.dsh\profiles\web\cordis.patch.yml` | host 补丁层（三行驱动器，热应用） |
| `C:\Users\wangy\.dsh\profiles\continuity-smoke\` | 离线管线测试 profile |
| `C:\Users\wangy\.dsh\designs\continuity-v3\` | 本仓库（README + LICENSE 在根；`docs\` 文档、`docs\design\` 设计文档、`scripts\` 安装/同步脚本、`tests\`、`deploy\` 镜像） |
| `C:\Users\wangy\.dsh\designs\continuity-v3\opt-scratch\` | 临时工作区与草稿（不入库；含 smoke-a/smoke-b/smoke-repo） |

## 9. 常见陷阱

- **信号**：`sessionQuery.listSessions(signal)` 要求真实 AbortSignal（`throwIfAborted`）；探针 shim 信号会抛错——传 `signal && typeof signal.throwIfAborted === 'function' ? signal : undefined`。
- **版本一致性**：测试 import、补丁行、组合行三处版本号必须同一步骤改完。
- **部分成功**：worktree 已建但 worker 失败 → 必须事务式回滚（`git worktree remove` + `branch -d`，**非强制**），并把回滚结果写进返回值。
- **waits 悬挂**：所有等待必须有超时兜底（timer 服务 → 原生 `setTimeout` → 立即触发），超时后从表中移除。
