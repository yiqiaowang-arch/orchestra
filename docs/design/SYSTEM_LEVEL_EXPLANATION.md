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
