# Orchestra (Ensemble Mode) · Continuity for DeepSeek Harness

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1F6FEB)](https://github.com/topics/dsh-plugin)
English | [中文](README.md)

> Keep one long task moving across many context-bounded AI sessions: pressure measurable, handoffs verifiable, sessions resumable, work parallelizable, goals auto-orchestrated, sessions coordinateable.

## Motivation

1. **Context windows are finite.** By the second half of a long task the model forgets, slows down, gets compacted, and eventually cannot continue.
2. **Manual copy-paste continuation is unreliable.** Copying an old conversation into a new one loses information, cannot be verified, and does not guarantee "pick up exactly the next step".
3. **Complex work needs collaboration.** Parallel sessions each work on a piece while one coordinator keeps the whole picture; any session can rotate into a fresh one when its context fills up, without interrupting the task.

## Approach

Everything is **user-level assembly**, zero intrusion into the shipped Harness, living under `~/.dsh`:

| Layer | Location | Role |
|---|---|---|
| Agent preset | `~/.dsh/.agent-presets/continuity/` | 24 commands + role discipline; pick it in the GUI preset selector and go |
| Host drivers | `~/.dsh/continuity-host/` | Rotation, parallel workers, auto-orchestration — hot-applied via the profile patch layer |
| Durable checkpoint | the session message stream | Restarts, rotations and new sessions recover from the log; nothing depends on memory |

Five capability domains: relay (cross-session continuation) · parallelism (worktree workers) · orchestration (mission) · coordination (multi-session hub) · pace.

## Usage

| Scenario | Command |
|---|---|
| See how much context is left | `/continuity` |
| Save a checkpoint and keep going | `/handoff` |
| Continue from an old session | `/continue <session-id>` |
| Rotate into a fresh session in one step | `/rotate` |
| Start a parallel task | `/worktree <task brief>` |
| Manage workers | `/workers` · `/worker-report <id>` · `/worker-send <id> <message>` · `/worker-stop <id>` |
| Auto-implement a goal | `/mission <goal>` · `/mission_status` · `/mission resume` |
| Link two sessions | `/coordinate <session-id>` |
| Coordinate existing sessions star-style | `/coordinate-hub <spoke-id>… [-- your thoughts]` · `/coordinate-intake` |
| Peek read-only | `/session-peek <id> [n] [--full]` |
| List sessions | `/sessions` · `/sessions_active` · `/current_session` |
| Pace self-check | `/pace` |

Full command reference: [`docs/COMMANDS.md`](docs/COMMANDS.md).

## Quick start

Prerequisite: DeepSeek Harness installed (`DSH_HOME`, default `~/.dsh`).

Run from **any directory** (the clone location does not matter: the installer copies the `deploy/` mirror into `~/.dsh`; the repo folder is just a staging area):

```powershell
git clone https://github.com/yiqiaowang-arch/orchestra.git
cd orchestra
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

Then create a session, pick **Orchestra** in the preset selector, and run `/continuity` — seeing tokens / capacity / ratio means it works.

> Platform: currently Windows-first. On macOS / Linux you need PowerShell Core (`brew install powershell` → `pwsh`) to run the installer, and the preset's shell tooling currently enables only the Windows pwsh — macOS / Linux are not adapted yet.

## Docs

| Doc | Audience |
|---|---|
| [README.md](README.md) | Chinese readers |
| [docs/AGENTS.md](docs/AGENTS.md) | Agents working in this repo (red lines / versioning / commit / handoff protocol) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Developers (planes / components / state machines / sequences / constraints) |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Users (full command reference) |
| [docs/STATES.md](docs/STATES.md) | Everyone (the three state-loop cheat sheet) |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) / [docs/MANIFEST.md](docs/MANIFEST.md) | Version history / maintenance quick reference |
| [docs/design/CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md](docs/design/CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md) | Design docs |

## License

This project is a personal capability extension for DeepSeek Harness (MIT), running entirely in the user-owned directory (`~/.dsh`), decoupled from any business repository; it never modifies the shipped installation. Licensed under the [MIT License](LICENSE), same as DeepSeek Harness.

The repository contains no personal absolute paths: local paths appear as the `C:\Users\<USER>\` placeholder, and the install script, tests, and doc checks resolve real locations dynamically from the `$DSH_HOME` / `$DSH_HARNESS` environment variables (defaulting to `~/.dsh` / `~/Documents/GitHub/deepseek-harness`).
