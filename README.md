# Orchestra（乐团模式）· Continuity for DeepSeek Harness

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1F6FEB)](https://github.com/topics/dsh-plugin)
[English](README.en.md) | 中文

> **让一个长任务跨多个"上下文有上限"的 AI 会话持续前进。** 压力可测、交接可验证、会话可续、任务可并行、目标可自动编排、多会话可协调——像一个乐团：一个指挥、多个声部、一份乐谱，乐手轮换而演出不停。

## 动机（Motivation）

1. **上下文窗口有限**：长任务跑到后半程，模型会遗忘、变慢、被压缩，最后无法继续。
2. **手工续写不可靠**：把旧对话内容复制给新对话，会丢信息、无法验证、不能保证"接着上次的下一步"。
3. **想要"交响乐"而不是"独奏"**：复杂任务应该由多个并行会话（声部）协作、由一个协调者（指挥）统筹，并且任何会话在上下文快满时都能**轮换**（乐手换人）而不打断整场演出。

## 做法（Approach）

全部是**用户级装配**，零侵入出厂 Harness，运行在 `~/.dsh` 下：

| 层 | 位置 | 作用 |
|---|---|---|
| Agent 预设 | `~/.dsh/.agent-presets/continuity/` | 24 条命令 + 角色纪律 + 每会话状态机；GUI 预设选择器选中即用 |
| Host 驱动器 | `~/.dsh/continuity-host/`（rotation / worktree / mission） | 轮换、并行 worker、自动编排——进程级服务，经 profile 补丁层热应用 |
| 持久 checkpoint | 会话消息流（marker + 8 节） | 重启、轮换、新会话都能从日志恢复，不依赖内存 |

能力五域（对应乐团隐喻）：**接力**（乐手轮换）/ **并行**（声部）/ **编排**（乐谱）/ **协调**（指挥）/ **节奏**（节拍）。

## 用法示例（Usage）

| 你想…… | 敲 |
|---|---|
| 看上下文还剩多少 | `/continuity` |
| 存个档再继续 | `/handoff` |
| 从旧会话接着干 | `/continue <session-id>` |
| 一键换新会话 | `/rotate` |
| 开一个并行任务 | `/worktree <任务简报>` |
| 管 worker | `/workers` · `/worker-report <id>` · `/worker-send <id> <消息>` · `/worker-stop <id>` |
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

```powershell
git clone https://github.com/yiqiaowang-arch/orchestra.git
cd orchestra
powershell -ExecutionPolicy Bypass -File install.ps1   # 一键安装（自动备份已有补丁）
```

或手工把 `deploy/` 镜像复制到实际运行位置（`deploy\agent-presets\continuity\` → `%DSH_HOME%\.agent-presets\continuity\`，host 驱动器与 web 补丁同理，见 install.ps1）。

然后新建会话，预设选择器选 **Orchestra（乐团模式）**（曾用名：接力模式），跑 `/continuity` 看到 tokens / 容量 / 比率即成功。

## 验证

```powershell
node tests\continuity-unit-tests.mjs      # 64
node tests\continuity-rotation-tests.mjs  # 20
node tests\continuity-worktree-tests.mjs  # 31
node tests\continuity-mission-tests.mjs   # 21   —— 合计 136，全绿
```

## 文档索引

| 文档 | 读者 |
|---|---|
| [README.en.md](README.en.md) | English readers |
| [AGENTS.md](AGENTS.md) | 在此仓库工作的 Agent（红线/升级/提交/交接协议） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 开发者（平面/组件/状态机/时序/约束） |
| [docs/COMMANDS.md](docs/COMMANDS.md) | 使用者（命令全集） |
| [docs/STATES.md](docs/STATES.md) | 所有人（三种状态环速查） |
| [CHANGELOG.md](CHANGELOG.md) / [MANIFEST.md](MANIFEST.md) | 版本史 / 维护速查 |
| [CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md](CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md) | 设计文档（V4 含全部实测约束） |

## 声明

本项目为 DeepSeek Harness 的个人能力扩展，运行于用户自有目录（`~/.dsh`），与业务仓库解耦；不修改出厂安装。可自由学习、修改、自用；对外分发前请替换绝对路径并重新验证安装脚本。
