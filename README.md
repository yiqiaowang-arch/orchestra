# Orchestra（乐团模式）· Continuity for DeepSeek Harness

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1F6FEB)](https://github.com/topics/dsh-plugin)
[English](README.en.md) | 中文

> 让一个长任务跨多个上下文有限的 AI 会话持续前进：压力可测、交接可验证、会话可续、任务可并行、目标可自动编排、多会话可协调。

## 动机

1. **上下文窗口有限**：长任务跑到后半程，模型会遗忘、变慢、被压缩，最后无法继续。
2. **手工续写不可靠**：把旧对话内容复制给新对话，会丢信息、无法验证、不保证"从上次的下一步继续"。
3. **复杂任务需要协作**：多个并行会话各干一段，由一个协调者统筹；任何会话上下文快满时都能无缝轮换到新会话，任务不中断。

## 做法

全部是**用户级装配**，零侵入出厂 Harness，运行在 `~/.dsh`：

| 层 | 位置 | 作用 |
|---|---|---|
| Agent 预设 | `~/.dsh/.agent-presets/continuity/` | 24 条命令 + 角色纪律；GUI 预设选择器选中即用 |
| Host 驱动器 | `~/.dsh/continuity-host/` | 轮换、并行 worker、自动编排——经 profile 补丁层热应用 |
| 持久 checkpoint | 会话消息流 | 重启、轮换、新会话都从日志恢复，不依赖内存 |

能力五域：接力（跨会话续接）· 并行（worktree worker）· 编排（mission）· 协调（多会话 hub）· 节奏（pace）。

## 用法

| 你想…… | 敲 |
|---|---|
| 看上下文还剩多少 | `/continuity` |
| 存档后继续 | `/handoff` |
| 从旧会话续跑 | `/continue <session-id>` |
| 一键换新会话 | `/rotate` |
| 开启并行任务 | `/worktree <任务简报>` |
| 管理 worker | `/workers` · `/worker-report <id>` · `/worker-send <id> <消息>` · `/worker-stop <id>` |
| 自动实现一个目标 | `/mission <目标>` · `/mission_status` · `/mission resume` |
| 链接两个会话 | `/coordinate <session-id>` |
| 星型协调已有会话 | `/coordinate-hub <spoke-id>… [-- 你的想法]` · `/coordinate-intake` |
| 定向指挥 / 重要升级 | `/relay <id> <消息>` · `/steer <id> <消息> [--force]` |
| 只读窥视 | `/session-peek <id> [n] [--full]` |
| 会话清单 | `/sessions` · `/sessions_active` · `/current_session` |
| 节奏自省 | `/pace` |

完整命令参考见 [`docs/COMMANDS.md`](docs/COMMANDS.md)。

## 快速开始

前提：已部署 DeepSeek Harness（`DSH_HOME`，默认 `~/.dsh`）。

在**任意目录**执行（克隆到哪都行：安装脚本会把 `deploy/` 镜像复制进 `~/.dsh`，这个目录只是暂存区）：

```powershell
git clone https://github.com/yiqiaowang-arch/orchestra.git
cd orchestra
powershell -ExecutionPolicy Bypass -File install.ps1
```

然后新建会话，预设选择器选 **Orchestra（乐团模式）**，跑 `/continuity` 看到 tokens / 容量 / 比率即成功。

> 平台：当前面向 Windows。macOS / Linux 需自装 PowerShell Core（`brew install powershell` → `pwsh`）才能运行安装脚本；且本预设的 shell 工具链目前只启用了 Windows 的 pwsh，macOS / Linux 暂未适配。

## 文档索引

| 文档 | 读者 |
|---|---|
| [README.en.md](README.en.md) | English readers |
| [AGENTS.md](AGENTS.md) | 在此仓库工作的 Agent（红线/升级/提交/交接协议） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 开发者（平面/组件/状态机/时序/约束） |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 使用者（命令全集） |
| [docs/STATES.md](docs/STATES.md) | 所有人（三种状态环速查） |
| [CHANGELOG.md](CHANGELOG.md) / [MANIFEST.md](MANIFEST.md) | 版本史 / 维护速查 |
| [CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md](CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md) | 设计文档 |

## 声明

本项目为 DeepSeek Harness 的个人能力扩展，运行于用户自有目录（`~/.dsh`），与业务仓库解耦；不修改出厂安装。可自由学习、修改、自用；对外分发前请替换绝对路径并重新验证安装脚本。
