# Orchestra (Ensemble Mode) · Continuity for DeepSeek Harness

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-1F6FEB)](https://github.com/topics/dsh-plugin)
English | [中文](README.md)

> **One long task, moving across many context-bounded AI sessions.** Pressure measurable, handoffs verifiable, sessions resumable, work parallelizable, goals auto-orchestrated, sessions coordinateable — like an orchestra: one conductor, several sections, one score, and players rotate without stopping the show.

## Motivation

1. **Context windows are finite.** By the second half of a long task the model forgets, slows down, gets compacted, and eventually cannot continue.
2. **Manual copy-paste continuation is unreliable.** Copying an old conversation into a new one loses information, cannot be verified, and does not guarantee "pick up exactly the next step".
3. **You want an ensemble, not a solo.** Complex work should be done by parallel sessions (sections) coordinated by one conductor, and any session should be able to **rotate** (substitute players) when its context fills up — without stopping the show.

## Approach

Everything is **user-level assembly**, zero intrusion into the shipped Harness, living under `~/.dsh`:

| Layer | Location | Role |
|---|---|---|
| Agent preset | `~/.dsh/.agent-presets/continuity/` | 24 commands + role discipline + per-session state machine; pick it in the GUI preset selector and go |
| Host drivers | `~/.dsh/continuity-host/` (rotation / worktree / mission) | Rotation, parallel workers, auto-orchestration — process-level services, hot-applied via the profile patch layer |
| Durable checkpoint | the session message stream (marker + 8 sections) | Restarts, rotations and new sessions recover from the log; nothing depends on memory |

Five capability domains (orchestra metaphor): **relay/handoff** (player rotation) · **parallelism** (sections) · **orchestration** (score) · **coordination** (conductor) · **pace** (tempo).

## Usage

| You want to… | Type |
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
| Direct a session / escalate something important | `/relay <id> <message>` · `/steer <id> <message> [--force]` |
| Peek read-only | `/session-peek <id> [n] [--full]` |
| List sessions | `/sessions` · `/sessions_active` · `/current_session` |
| Pace self-check | `/pace` |

Full command reference: [`docs/COMMANDS.md`](docs/COMMANDS.md).

## Quick start

Prerequisite: DeepSeek Harness installed (`DSH_HOME`, default `~/.dsh`).

```powershell
git clone https://github.com/yiqiaowang-arch/orchestra.git
cd orchestra
powershell -ExecutionPolicy Bypass -File install.ps1   # one-shot install (backs up existing patches)
```

Or copy the `deploy/` mirror to the real runtime locations manually (`deploy\agent-presets\continuity\` → `%DSH_HOME%\.agent-presets\continuity\`, and likewise for the host drivers and the web patch — see install.ps1).

Then create a session, pick **Orchestra (Ensemble Mode)** in the preset selector (formerly known as 接力模式 / Relay Mode), and run `/continuity` — seeing tokens / capacity / ratio means it works.

## Verification

```powershell
node tests\continuity-unit-tests.mjs      # 64
node tests\continuity-rotation-tests.mjs  # 20
node tests\continuity-worktree-tests.mjs  # 31
node tests\continuity-mission-tests.mjs   # 21   —— total 136, all green
```

## Docs

| Doc | Audience |
|---|---|
| [README.md](README.md) | Chinese readers |
| [AGENTS.md](AGENTS.md) | Agents working in this repo (red lines / versioning / commit / handoff protocol) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Developers (planes / components / state machines / sequences / constraints) |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Users (full command reference) |
| [docs/STATES.md](docs/STATES.md) | Everyone (the three state-loop cheat sheet) |
| [CHANGELOG.md](CHANGELOG.md) / [MANIFEST.md](MANIFEST.md) | Version history / maintenance quick reference |
| [CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md](CONTEXT_CONTINUITY_SYSTEM_DESIGN_V4.md) | Design docs (V4 contains all measured constraints) |

## License note

This project is a personal capability extension for DeepSeek Harness. It runs entirely in the user-owned directory (`~/.dsh`), is decoupled from any business repository, and never modifies the shipped installation. Free to learn from, modify, and use privately; before redistributing, replace the absolute paths and re-verify the install script.
