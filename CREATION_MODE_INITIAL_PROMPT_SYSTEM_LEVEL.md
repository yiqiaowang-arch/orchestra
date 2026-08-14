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
