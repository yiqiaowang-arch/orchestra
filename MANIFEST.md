# Continuity 项目清单（MANIFEST）

> 本仓库是 DeepSeek Harness 上下文接力能力栈（V3 MVP + V4 阶段 A/B/C）的版本控制中枢。
> 运行时文件因 G7（loader 按 URL 缓存模块）必须留在原地；`deploy/` 是本仓库对这些**真实运行文件**的镜像。
> **每次提交前必须运行 `sync-deploy.ps1`**，然后确认 `git status` 只含预期 diff。

## 当前版本与引用（2026-08-14 基线）

| 组件 | 当前版本 | 真实位置 | 被引用处 |
|---|---|---|---|
| 预设插件 | **v5** | `~/.dsh/.agent-presets/continuity/continuity-plugin.v5.mjs` | `agent.cordis.yml`（continuity group 内） |
| 轮换驱动器 | **v4** | `~/.dsh/continuity-host/continuity-rotation.v4.mjs` | `profiles/web/cordis.patch.yml`、`profiles/continuity-smoke/cordis.patch.yml` |
| worktree 驱动器 | **v3** | `~/.dsh/continuity-host/continuity-worktree.v3.mjs` | `profiles/web/cordis.patch.yml` |
| mission 驱动器 | **v2** | `~/.dsh/continuity-host/continuity-mission.v2.mjs` | `profiles/web/cordis.patch.yml` |

旧代次（plugin base/v2/v3/v4、rotation base/v2/v3、worktree v1/v2、mission v1）**全部保留**——运行中的进程可能仍引用它们，禁止删除。

## 测试与验证

```powershell
node tests\continuity-unit-tests.mjs      # 44 项
node tests\continuity-rotation-tests.mjs  # 18 项
node tests\continuity-worktree-tests.mjs  # 29 项
node tests\continuity-mission-tests.mjs   # 19 项  （合计 110）
node C:\Users\wangy\Documents\GitHub\deepseek-harness\apps\cli\lib\bin.js --profile web --dump-config
node C:\Users\wangy\Documents\GitHub\deepseek-harness\apps\cli\lib\bin.js --profile continuity-smoke
```

## 升级规程（版本化 URL 规则，G7/G8）

1. 任何 `.mjs` 内容修改 = 发布**新版本文件**（+1 版本号）+ 更新全部引用（web/smoke patch、组合行、测试 import、管线 runner）；
2. 旧版本文件原样保留；
3. 预设伴生插件换版必须同时触碰 `agent.cordis.yml`（standing 代次以组合文件 stamp 换代）；
4. 驱动器服务访问全部**调用期惰性 `ctx.get`**；预设行发布 Service 必须置于 `isolate` realm 组；
5. 运行 `sync-deploy.ps1` → 全量测试 → dump-config/离线管线 → 提交。

## 回滚路径（自上而下）

1. 版本回退：patch/组合行改回旧 URL（旧文件都在）；
2. 禁行：patch 对应行加 `disabled: true`；
3. 删补丁行（既有会话日志与 checkpoint 保留）；
4. 最坏：删预设（`agentPresets.remove('continuity')`）。

## 红线

- 出厂 Harness 安装（`Documents\GitHub\deepseek-harness\`）只读，绝不修改；
- 当前项目工作区（session cwd）零改动；
- 安全护栏只许加强：worktree 授权门 allowed-once、/rotate 链保护、worker 永不自动轮换、绝不自动 merge。
