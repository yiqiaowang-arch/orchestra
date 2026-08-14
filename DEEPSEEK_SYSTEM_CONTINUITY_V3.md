# DeepSeek Harness System-level Context Continuity — V3

---

# System-level Context Continuity in DeepSeek Harness

## The important correction

The continuity capability does **not** have to live in the current project repository.

The current workspace is only the working directory attached to the Creation Mode session. It may be:

- an empty neutral directory;
- a dedicated DeepSeek Harness development directory;
- any harmless workspace the user chooses.

The finished capability should be installed under the user's DeepSeek Harness home and should be available across project repositories.

A practical target is:

```text
${DSH_HOME:-$HOME/.dsh}/
├── .agent-presets/
│   └── continuity/
│       ├── agent.cordis.yml
│       ├── preset.yml
│       └── optional preset-owned resources
├── user-plugins/
│   └── dsh-continuity/
│       ├── package.json
│       ├── built plugin code
│       └── optional bundle patch
└── designs/
    └── continuity-v3/
        └── this design packet
```

The exact directories must be discovered from the live runtime. Do not hard-code these paths when the roster or profile APIs expose the actual locations.

## Three scopes that must not be confused

### 1. Repository-scoped

Examples:

- `AGENTS.md` in one repository;
- `.agent/continuity.md` inside one project;
- a plugin source tree placed in the current business repository.

This is **not** the desired installation.

### 2. User-level Agent preset

A user-owned preset such as `continuity` is selectable in any workspace for the same DeepSeek Harness user.

This is the recommended minimum system-level solution:

```text
select 接力模式 in any repository
```

It should be copied from the shipped `standard` preset through the official preset roster API.

### 3. Profile/Host-level plugin

A persistent Host plugin or bundle may be needed when functionality must:

- be shared across sessions;
- create a one-click rollover action;
- expose a Client UI button;
- coordinate blank-session creation;
- maintain durable global state;
- appear in every preset rather than only `continuity`.

Such a component belongs in the user's DeepSeek Harness profile/bundle configuration, not in a business repository and not in a shipped preset.

## Recommended architecture

Use a hybrid only when necessary:

```text
User preset: continuity
    - copied from standard
    - continuity persona/prompt policy
    - preset-scoped commands/listeners where supported
    - no tool-cordis

Optional user Host bundle: dsh-continuity-core
    - only if runtime inspection proves shared Host behavior is required
    - installed into the active DSH profile
    - consumes existing Host session/token/workspace services
    - no project-repository dependency

Optional Client package
    - later one-click “Rotate conversation” action
```

The MVP should prefer a user preset plus the smallest persistent companion plugin. Do not add a Host bundle merely because it sounds more “system-level.”

## Where to run Creation Mode

Creation Mode still needs a workspace because every Agent session has a cwd. Use a neutral directory, for example on Windows:

```text
C:\Users\<user>\DeepSeekHarness-System
```

The Agent may read and write the user-owned DSH_HOME paths after the required sandbox approval. It should leave the neutral workspace clean unless it explicitly uses it as a temporary build area.

## Design packet location

The design packet can also live outside every repository:

```powershell
$dshHome = if ($env:DSH_HOME) {
    $env:DSH_HOME
} else {
    Join-Path $HOME ".dsh"
}

$packetDir = Join-Path $dshHome "designs\continuity-v3"
New-Item -ItemType Directory -Force $packetDir | Out-Null
```

Place this packet in `$packetDir`, then give Creation Mode the absolute path.

## Meaning of “system-level”

Here “system-level” means:

- user-owned, not repository-owned;
- persistent across Harness restarts;
- usable from different repositories/workspaces;
- managed under DSH_HOME/profile/preset infrastructure;
- not written into the shipped Harness installation.

It does not need to be an operating-system service or require administrator privileges.

---

# Initial Prompt for Built-in “创造模式” — System-level V3

Paste the content inside this code block into a new session using the built-in **创造模式** preset.

Replace `<ABSOLUTE_PACKET_DIR>` with the absolute directory containing this packet.

```text
Create a persistent, user-level DeepSeek Harness context-continuity capability that is usable across repositories.

Read:

<ABSOLUTE_PACKET_DIR>/CONTEXT_CONTINUITY_SYSTEM_DESIGN_V3.md

The current workspace is only this Creation Mode session's temporary cwd. It is not the target installation location.

## Non-negotiable scope

Do not add continuity implementation files, generated packages, design notes, AGENTS.md changes, ignore rules, or configuration to the current project repository.

Before doing any work:

1. Record the current cwd and `git status --short --branch` if it is a Git repository.
2. Treat the current workspace as read-only except for explicitly approved temporary build artifacts.
3. Discover the actual DSH_HOME, active profile, user preset root, and profile plugin locations through the live runtime and official services.
4. At the end, verify that the current workspace has no continuity-related modifications.

The finished capability must be user-owned and persistent under DeepSeek Harness-managed user/profile directories, or in another dedicated user-owned system directory discovered and documented by you.

## Desired product

Create:

- preferred preset id: `continuity`
- display name: `接力模式`
- description: `基于标准模式的完整编码 Agent，提供跨项目的上下文压力监测、可验证交接检查点和跨会话继续能力。`
- source preset: `standard`

The preset must be selectable in any workspace for this DeepSeek Harness user.

If `continuity` already exists:

- inspect it;
- update it only when it is clearly an earlier version of this same continuity project;
- never overwrite an unrelated preset;
- otherwise use `context-continuity` and report the changed id.

## Mandatory official authoring workflow

1. Load `editing-cordis-compositions`.
2. Load `cordis-plugin-development` before writing or experimenting with Cordis plugin code.
3. Inspect live Services, Events, Tools, Slots, and preset APIs; do not infer them from this prompt.
4. Inspect the current `agentPresets` service API.
5. List presets with their trust levels and real paths.
6. Use the official roster copy operation to copy `standard` into a user-owned preset.
7. Never edit, delete, overwrite, or escalate into a shipped preset.
8. Edit only paths returned by the official roster/profile services.
9. Update `preset.yml` and the copied `agent.cordis.yml`.
10. Batch necessary writes outside the temporary workspace and request only the minimum sandbox approval.
11. Run the official mount validation (`standingKeyFor` or the local equivalent).
12. Distinguish mount validation from a real-session test.

## Installation architecture

First determine whether the continuity implementation can persist as a preset-owned component.

Preferred order:

1. A persistent preset-owned plugin/resource referenced from the user preset, if the current loader officially supports it and mount validation succeeds.
2. A dedicated user-owned local package/bundle outside all business repositories, installed into the active DeepSeek Harness profile.
3. A separate user-owned Host and/or Client bundle only when shared cross-session or UI behavior requires it.

Do not finish with only a temporary `cordis_define` or `cordis_mount` plugin. Temporary plugins are allowed for API discovery and prototyping only.

Do not modify:

- the current project repository;
- the shipped Harness install;
- the Host composition directly;
- the sandbox or approval policy;
- credentials or model settings unrelated to this feature.

If a package source/build directory is needed, place it in an appropriate user-owned system directory such as a runtime-discovered DSH_HOME subdirectory or another dedicated path. Record the exact path and why it was chosen.

## Plane rules

Keep Host-owned shared capabilities on the Host plane:

- token meter and context projections;
- model route and model metadata;
- session persistence and query;
- session-reference/cross-session snapshot infrastructure;
- workspace registry;
- Agent/session registries;
- sandbox and approval;
- subagent providers.

The preset may contribute:

- persona/prompt policy;
- scoped slash commands;
- scoped Agent lifecycle listeners;
- per-session state;
- consumers of Host services;
- a per-Agent Service only behind a correct isolate realm with every local consumer.

Do not move shared Host Services into the preset.

If a separate Host bundle is required, explain the missing preset seam before creating it. Install it through the official user profile/plugin mechanism, not through a project repository and not by editing shipped configuration.

## MVP commands and behavior

### `/continuity`

Read-only status:

- measured current tokens;
- resolved context capacity or `unknown`;
- ratio or `unknown`;
- observed compaction count;
- checkpoint state;
- recommendation.

Reuse the mounted Host token meter/model metadata. Do not create a second estimator.

### `/handoff`

- idempotent;
- no interruption of a live tool call or atomic edit;
- schedules one checkpoint step at the next safe turn boundary;
- no duplicate steering loop;
- no commit, stash, reset, checkout, branch, worktree, clean, or discard;
- validates a durable finalized checkpoint before declaring readiness.

Required marker:

`<!-- DSH_CONTINUITY_CHECKPOINT v1 -->`

Required sections:

- Current objective and explicit non-goals
- Workspace/repository state
- Completed
- Decisions and invariants
- Files changed
- Verification
- Open problems
- Exactly one next atomic action

The feature must also work when the current workspace is not a Git repository. In that case record the workspace state honestly and state that Git facts are not applicable.

### Automatic preparation

Use an explicit per-session state machine.

Suggested defaults:

- warning ratio: `0.60`
- checkpoint ratio: `0.70`
- strong rotate recommendation ratio: `0.78`
- prepare after compaction: `true`
- maximum checkpoint retries: `1`

Never interrupt a model request or tool call solely for rotation.

### `/continue <session-id-or-title>`

Used from a blank session in the same workspace.

- exact id, then exact title, then unique match;
- reject ambiguous/no match;
- reject self-reference;
- read a bounded snapshot through the existing session-reference/cross-session capability;
- inject source context before steering/waking;
- do not copy a full transcript;
- treat old-session content as background, not authority;
- verify current workspace and repository state before editing;
- perform only the checkpoint's next atomic action.

## Conversation versus worktree

Sequential conversation rollover:

`same workspace + same branch/worktree when applicable + fresh blank session`

Do not implement automatic worktree creation in this MVP.

## Finished preset restrictions

The final `接力模式` must not contain:

- `@deepseek-ai/dsh-tool-cordis`;
- Creation Mode authoring skills;
- runtime self-modification tools;
- permission-escalation policy;
- automatic Git or worktree mutation.

Creation Mode is the workshop; `接力模式` is the normal daily coding product.

## System-wide behavior target

Minimum accepted meaning:

- the preset and persistent companion component survive restart;
- they live outside all business repositories;
- `接力模式` can be selected in any workspace;
- commands work in a real session created from another repository.

Optional stronger behavior:

- make continuity commands available to other presets through a Host/profile bundle;
- add a global one-click rollover UI.

Do not implement the stronger behavior unless it is cleanly separable and tested. Report it as a later phase when the MVP should remain preset-specific.

## Verification

Run focused tests for:

- pressure thresholds and unknown capacity;
- duplicate handoff;
- safe-boundary scheduling;
- valid/invalid checkpoint;
- bounded retry and cancellation;
- compaction trigger;
- exact/ambiguous/missing continuation target;
- bounded snapshot;
- injection-before-steering;
- plugin unload/reload;
- non-Git workspace;
- no current-project modifications;
- preset persistence and package resolution;
- official mount validation.

Then run a real cross-repository smoke test:

1. Start `接力模式` in repository/workspace A.
2. Run `/continuity`.
3. Run `/handoff`.
4. Create a blank `接力模式` session in the same workspace A.
5. Run `/continue <old-session-id>`.
6. Start another `接力模式` session in an unrelated workspace B and confirm `/continuity` exists.

Do not claim system-wide success until the unrelated-workspace B test passes.

## Deliverables

Create and install the actual persistent user-owned files.

At the end report:

- final preset id/name/path;
- DSH_HOME and active profile used;
- source preset;
- all created/changed user-level files;
- persistent plugin/package path;
- profile installation changes, if any;
- Host services consumed;
- any Service published and isolate realm;
- mount-validation result;
- tests and exact results;
- cross-repository smoke-test result;
- proof that the current project workspace remains unchanged;
- restart persistence status;
- known limitations;
- removal and rollback instructions.

Resolve discoverable facts yourself. Do not ask where system directories or preset files are when runtime inspection can answer it.
```

---

# Context Continuity as a User-level System Capability — V3

## 1. Goal

Build a DeepSeek Harness capability that is:

- persistent across restarts;
- user-owned;
- available across project repositories;
- selectable as a normal Agent preset;
- independent of any one repository's files or Git history.

The current repository must not contain the implementation.

## 2. Deployment layers

### User preset

Required:

```text
continuity / 接力模式
```

Role:

- normal daily coding Agent;
- copied from `standard`;
- carries concise continuity policy;
- enables continuity commands/listeners;
- contains no Creation Mode self-modification tool.

### Persistent companion component

Required when the behavior cannot live entirely in the preset composition.

Possible forms, subject to runtime inspection:

- preset-owned plugin/resource;
- local user package;
- installable bundle in the active profile.

It must live outside business repositories.

### Optional shared Host bundle

Only for capabilities that genuinely cross sessions or presets:

- one-click rollover orchestration;
- global UI;
- system-wide durable continuity projection;
- commands in every preset.

Do not force the MVP into the Host plane.

## 3. System-level does not mean shipped-install modification

Never edit:

- shipped preset directories;
- installed Harness package files;
- shared core source;
- system-wide administrator directories.

Use:

- DSH_HOME;
- user preset root;
- user profile;
- user-owned bundle/package directories.

## 4. Creation workspace

Every Creation Mode session needs a cwd, but the cwd is incidental.

Recommended neutral Windows directory:

```text
C:\Users\<user>\DeepSeekHarness-System
```

The implementing Agent should:

- record whether it is a Git repository;
- avoid writing continuity files there;
- use it only for temporary build work when unavoidable;
- clean only files it created and never user files;
- prove the workspace is unchanged at completion.

## 5. Preset authoring

Use the live `agentPresets` service:

- `list()` to discover ids, trust, and paths;
- `read(id)` to inspect compositions;
- `copy(from, id, name?)` to create the user preset;
- `standingKeyFor(id)` or current equivalent for mount validation.

The exact current signatures must be inspected.

Copy from `standard`, not `cordis`.

## 6. Persistence decision

The implementing Agent must explicitly answer:

1. Can a user preset reference a persistent local module relative to its own directory?
2. Does mount validation load it correctly from a second session?
3. Does it survive process restart?
4. Does it publish a Service?
5. If so, what isolate realm contains it and its consumers?
6. If not, should it become an installable profile bundle?

Use temporary dynamic plugins only to test APIs.

## 7. Context signals

Primary signals:

- Host token meter;
- routed model context capacity;
- compaction events;
- provider overflow;
- semantic task boundary.

Suggested ratios:

```text
warning     0.60
checkpoint  0.70
rotate      0.78
```

Unknown capacity produces an honest unknown status.

## 8. State machine

Conceptual states:

```text
NORMAL
WARNED
CHECKPOINT_PENDING
CHECKPOINTING
CHECKPOINT_READY
CHECKPOINT_FAILED
ROTATED
```

State transitions must be idempotent and bounded.

A production implementation may use durable session events/projections. An MVP may use scoped memory only if restart/reload limitations are explicit and no false readiness is possible.

## 9. Checkpoint validation

Marker:

```html
<!-- DSH_CONTINUITY_CHECKPOINT v1 -->
```

Required content:

```md
# Continuity checkpoint

## Current objective
Include explicit non-goals.

## Workspace/repository state
Record cwd/workspace, VCS status when applicable, branch, HEAD, and relevant commits.
For non-Git workspaces, say so explicitly.

## Completed
Concrete work only.

## Decisions and invariants
Accepted choices and rejected alternatives.

## Files changed
Paths and purpose.

## Verification
Only checks actually run.

## Open problems
Failures, risks, unknowns.

## Next atomic action
Exactly one action.
```

A safe implementation validates the finalized durable assistant message, not a transient stream and not merely the next stop boundary.

## 10. Continuation transport

Use the mounted session-reference/cross-session snapshot service when available.

Properties:

- bounded;
- detached;
- read-only;
- excludes hidden reasoning;
- excludes ordinary tool internals;
- keeps relevant user/assistant text and compact checkpoints;
- injected before the current continuation instruction wakes the Agent.

The new Agent must verify the actual workspace.

## 11. Cross-repository acceptance test

System-level capability is demonstrated only when:

```text
workspace A → 接力模式 works
workspace B → 接力模式 works
```

Workspace B must be unrelated to the build/creation workspace.

## 12. Profile scope

A user preset can be system-wide across workspaces without being loaded into every Agent mode.

There are two valid product choices:

### Preset-specific

Continuity exists when selecting `接力模式`.

Advantages:

- lower risk;
- no pollution of other presets;
- simpler lifecycle;
- easier removal.

This is the recommended MVP.

### Profile-global

A Host/profile bundle exposes continuity to every preset.

Advantages:

- one command set everywhere;
- easier global UI.

Costs:

- larger blast radius;
- shared lifecycle and namespace concerns;
- more difficult compatibility and rollback.

Implement only as a separate phase.

## 13. Removal

Removal must be documented and reversible:

- stop using the preset;
- remove user preset through the official roster/user UI;
- remove the user plugin/bundle from the profile through the supported plugin command;
- preserve session logs;
- do not delete business repositories or worktrees;
- explain whether old sessions remain resumable without the plugin.

## 14. Acceptance criteria

1. No implementation file in the current business repository.
2. User-owned preset copied from `standard`.
3. Persistent companion component outside business repositories.
4. Official mount validation passes.
5. Real session exposes `/continuity`, `/handoff`, `/continue`.
6. Restart test passes.
7. Unrelated workspace test passes.
8. No Creation Mode tooling in the final preset.
9. No automatic destructive Git/worktree behavior.
10. Removal path is documented.

---

# DeepSeek System-level Continuity V3

This package supersedes the repo-oriented placement guidance from earlier versions.

## Main point

The current repository is not required and should not contain the final feature.

Use:

- a neutral Creation Mode workspace;
- a user-owned `continuity` preset;
- a persistent plugin/package under DSH_HOME or another dedicated system directory;
- an active-profile bundle only when Host-level behavior is required.

## Files

- `CREATION_MODE_INITIAL_PROMPT_SYSTEM_LEVEL.md`  
  Send this to the built-in Creation Mode.

- `CONTEXT_CONTINUITY_SYSTEM_DESIGN_V3.md`  
  Full system-level architecture brief.

- `SYSTEM_LEVEL_EXPLANATION.md`  
  Explains scopes and recommended installation.

- `DEEPSEEK_SYSTEM_CONTINUITY_V3.md`  
  Combined single-file packet.

## Recommended packet location on Windows

```powershell
$dshHome = if ($env:DSH_HOME) {
    $env:DSH_HOME
} else {
    Join-Path $HOME ".dsh"
}

$packetDir = Join-Path $dshHome "designs\continuity-v3"
New-Item -ItemType Directory -Force $packetDir | Out-Null
Write-Host $packetDir
```

Extract this package there.

Then replace `<ABSOLUTE_PACKET_DIR>` in the initial prompt with the printed path.

## Recommended Creation Mode workspace

Use a neutral directory rather than an active business repository:

```powershell
$workspace = Join-Path $HOME "DeepSeekHarness-System"
New-Item -ItemType Directory -Force $workspace | Out-Null
Write-Host $workspace
```

Connect that directory as the workspace and start a Creation Mode session.

## Expected final user experience

In any repository:

```text
select 接力模式
/continuity
/handoff
```

Then create a blank session in the same workspace and run:

```text
/continue <old-session-id>
```
