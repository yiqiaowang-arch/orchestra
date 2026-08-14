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
