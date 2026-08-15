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
continuity / Orchestra（乐团模式，曾用名：接力模式）
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

> MVP 落地为 5 态：`normal`/`pending`/`checkpointing`/`ready`/`failed`；`WARNED` 为展示带而非状态；`ROTATED` 由 host rotation 驱动器的 `rotating`/`lastRolloverAt` 表达。

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
workspace A → Orchestra（乐团模式） works
workspace B → Orchestra（乐团模式） works
```

Workspace B must be unrelated to the build/creation workspace.

## 12. Profile scope

A user preset can be system-wide across workspaces without being loaded into every Agent mode.

There are two valid product choices:

### Preset-specific

Continuity exists when selecting `Orchestra（乐团模式）`.

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
5. Real session exposes `/continuity`, `/handoff`, `/continue`（V3 MVP 三命令下限；当前 23 条命令与协调/节奏/纪律新模式见 V4 §7d/§7e）。
6. Restart test passes.
7. Unrelated workspace test passes.
8. No Creation Mode tooling in the final preset.
9. No automatic destructive Git/worktree behavior.
10. Removal path is documented.
