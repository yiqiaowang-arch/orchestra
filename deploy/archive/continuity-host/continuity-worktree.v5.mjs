/**
 * continuity-worktree — host-plane worktree/worker driver (V4 design, Phase B).
 *
 * v5 (this file): worker completion notification — when a spawned worker posts
 * "## Worker report", the coordinator session is steered a one-time notice
 * (`notifyWorkerDone`, default true). Covers plain /worktree AND mission
 * dispatches (mission spawns through this driver's spawnWorker).
 *
 * v3 (error-path hardening + GUI workspace visibility) — changes from v2,
 * without weakening any guard:
 *
 *  1. Transactional spawn: a worktree this call just created is rolled back
 *     (git worktree remove + git branch -d, both NON-force) when the worker
 *     fails to start, so a half-created workspace is never left behind. The
 *     rollback only ever touches a worktree created by THIS invocation before
 *     any worker was dispatched into it — it can never delete user work.
 *  2. Idempotent re-entry: repeated /worktree for the same task title/brief
 *     resolves to the same slug/path; a pre-check plus git conflict detection
 *     returns a clear "already exists" error instead of a second worktree or
 *     a second branch.
 *  3. Non-Git vs git-failure classification: a clean non-Git directory
 *     (git present, "not a git repository") still creates a plain sibling
 *     directory with an honest note (V4 §4.2/7c); a git *failure*
 *     (git missing / subprocess unavailable / corrupt repo) is a clear error,
 *     never a silent fallback.
 *  4. Cancel semantics: /worker-stop cancels the worker and leaves the
 *     worktree in place — merge/delete is always a human decision (no
 *     automatic merge/checkout/reset/clean, exactly as before).
 *  5. GUI workspace visibility: on a successful spawn the driver resolves the
 *     worktree's workspace record and attaches the worker session
 *     (`Workspace.attachSession`) so the GUI groups it; an attach failure is a
 *     partial success (worker running but not grouped) and never rolls the
 *     worktree back.
 *  6. Cleanup command: a two-step `cleanup` (dry-run | confirm) lists temporary
 *     worktree workspaces (path contains cfg.worktreeMarker) and their settled
 *     worker sessions; only `confirm` detaches settled workers and deletes the
 *     workspace record — directories and session logs are always kept, and no
 *     deletion ever happens without an explicit confirm.
 *  7. /worker-stop detaches the stopped worker from its workspace group.
 *
 * Plane: session/agent creation and the authorization-gated worktree mutation
 * stay on the host plane. Workers are ordinary child sessions on the
 * `continuity` preset with `meta.cwd` = the worktree and `parentSession` =
 * the coordinator, so lineage tracing (sessionQuery.traceSession) and
 * durable discovery (sessionQuery.listSessions by parent) work after restart.
 *
 * Authorization: git worktree creation writes OUTSIDE the coordinator's
 * workspace, so the driver implements its own gate — when the coordinator
 * session's approval policy is not `never`, an approval request must return
 * `allowed-once` (the web UI answers it). `askApproval: false` in the row
 * config disables the gate explicitly.
 *
 * Zero-import except node: builtins and the preset companion's pure helpers
 * (absolute file URLs resolve anywhere; versioned upgrade paths per the V4
 * design notes G7).
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  MARKER,
  validateCheckpoint,
  userMessage,
  capText,
  textOfMessage,
} from 'file:///C:/Users/<USER>/.dsh/continuity-host/continuity-shared.v1.mjs'

export const SERVICE = 'continuityWorktree'
export const MISSION_MARKER = '<!-- DSH_MISSION v1 -->'

const DEFAULTS = Object.freeze({
  askApproval: true,
  worktreeParent: null, // null = sibling of the coordinator workspace
  reportCapChars: 8000,
  missionCapChars: 8000,
  worktreeMarker: '-wt-', // substring that marks a temporary worktree workspace path
  notifyWorkerDone: true, // steer the coordinator once when a spawned worker posts "## Worker report"
})

/** Clamp and default the row config. */
export function sanitizeWorktreeConfig(raw) {
  const src = (raw !== null && typeof raw === 'object') ? raw : {}
  const intInRange = (value, fallback, lo, hi) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(hi, Math.max(lo, Math.trunc(value)))
  }
  return {
    askApproval: src.askApproval !== false,
    worktreeParent: typeof src.worktreeParent === 'string' && src.worktreeParent.trim() !== '' ? src.worktreeParent.trim() : DEFAULTS.worktreeParent,
    reportCapChars: intInRange(src.reportCapChars, DEFAULTS.reportCapChars, 1000, 64000),
    missionCapChars: intInRange(src.missionCapChars, DEFAULTS.missionCapChars, 1000, 64000),
    worktreeMarker: typeof src.worktreeMarker === 'string' && src.worktreeMarker !== '' ? src.worktreeMarker : DEFAULTS.worktreeMarker,
    notifyWorkerDone: src.notifyWorkerDone !== false,
  }
}

/** Branch/path slug from a title or brief (pure, testable). */
export function slugify(text) {
  const base = (typeof text === 'string' ? text : '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return base === '' ? null : base
}

/**
 * Pure worktree placement plan.
 * workspace = coordinator workspace path; slug = branch name basis.
 * Returns { parent, path, branch } with path a sibling of the workspace.
 */
export function worktreePlan(workspacePath, slug, parentOverride) {
  const workspace = resolve(workspacePath)
  const base = parentOverride !== null && parentOverride !== undefined
    ? resolve(parentOverride)
    : dirname(workspace)
  const stem = workspace.split(/[\\/]/).filter(Boolean).pop() || 'workspace'
  const suffix = slug === null ? 'worker' : slug
  return {
    parent: base,
    path: join(base, stem + '-wt-' + suffix),
    branch: suffix,
  }
}

/** Authorization decision for one spawn (pure, testable). */
export function authorizationDecision(askApproval, policy) {
  if (!askApproval) return 'allow'
  if (policy === 'never') return 'allow'
  return 'ask'
}

/**
 * Classify the result of `git rev-parse --is-inside-work-tree` (pure).
 *   - exit 0 + "true"        → { kind: 'git' }
 *   - exit 0 + anything else → { kind: 'nonGit' } (bare repo / .git dir)
 *   - "not a git repository" → { kind: 'nonGit' } (git present, dir is not a repo)
 *   - any other failure      → { kind: 'error', detail } (git missing / corrupt)
 * The last case must never silently become a plain-directory fallback.
 */
export function classifyGitProbe(result) {
  const r = (result !== null && typeof result === 'object') ? result : {}
  if (r.ok && r.out === 'true') return { kind: 'git' }
  if (r.ok) return { kind: 'nonGit' }
  const detail = String((r.err || '') + ' ' + (r.out || '')).trim()
  if (/not a git repository/i.test(detail)) return { kind: 'nonGit' }
  if (detail === '') return { kind: 'error', detail: 'git exited ' + String(r.exitCode ?? 'unknown') }
  return { kind: 'error', detail }
}

/** Detect idempotency/conflict text from `git worktree add` stderr (pure). */
export function isWorktreeConflict(text) {
  const t = typeof text === 'string' ? text : ''
  return /already exists|already checked out|already registered|already locked/i.test(t)
}

/** Initial worker prompt (pure, testable). */
export function buildWorkerPrompt(spec) {
  return [
    'Worker task (continuity preset, coordinator session ' + spec.coordinatorId + ').',
    'Workspace: ' + spec.worktreePath + (spec.git ? ' (git worktree, branch ' + spec.branch + ')' : ' (plain directory — the coordinator workspace is not a Git repository, so Git facts are not applicable)') + '.',
    '',
    'Task:',
    spec.brief,
    '',
    'Discipline:',
    '1. Work ONLY in this workspace; keep edits scoped to it.',
    '2. Verify the workspace state before editing; prefer existing patterns.',
    '3. Under context pressure use /continuity and /handoff. Never run /rotate (a worker never rolls over itself).',
    '4. When the task is done — or blocked — finish with a message that starts with "## Worker report" and lists: what was done, files changed (exact paths), verification actually run, open problems, and a proposed next action.',
    '5. Then stop; do not start follow-up work beyond the task.',
  ].join('\n')
}

/** Bounded worker-report extraction from a surface snapshot (pure). */
export function extractWorkerReport(snapshot, capChars) {
  const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
  let tail = ''
  let hasCheckpoint = false
  let lastSeq = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message') continue
    const message = event.data && event.data.message
    const text = textOfMessage(message)
    if (text === '') continue
    if (tail === '') {
      tail = text
      lastSeq = event.seq
    }
    if (text.includes(MARKER)) hasCheckpoint = true
  }
  return {
    tail: tail === '' ? null : capText(tail, capChars),
    hasCheckpoint,
    lastSeq,
  }
}

function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } }
  })
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const without = {}
    for (const key of Object.keys(resolved)) if (key !== 'reasoningEffort') without[key] = resolved[key]
    return {
      ...without,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
}

export default function continuityWorktree(ctx, config) {
  const cfg = sanitizeWorktreeConfig(config)
  const fail = (error) => (error instanceof Error ? error.message : String(error))
  const get = (name) => ctx.get(name)

  const error = (text) => ({ kind: 'error', text })
  const success = (text) => ({ kind: 'success', text })

  // workerId -> { coordinator, label } for the v5 completion notice.
  const workerDoneNotices = new Map()

  async function runCommand(argv, cwd) {
    const subprocess = get('subprocess')
    if (subprocess === undefined) return { ok: false, exitCode: null, out: '', err: 'subprocess service unavailable' }
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 30000,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout !== undefined ? handle.collected.stdout.readFrom(0).text : ''
    const err = handle.collected.stderr !== undefined ? handle.collected.stderr.readFrom(0).text : ''
    return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, out: out.trim(), err: err.trim() }
  }

  /** Git-vs-nonGit classification of the coordinator workspace (structured). */
  async function detectGit(workspace) {
    const result = await runCommand(['git', '-C', workspace, 'rev-parse', '--is-inside-work-tree'], workspace)
    return classifyGitProbe(result)
  }

  /**
   * Best-effort, NON-force rollback of a worktree THIS call just created and
   * into which no worker was ever dispatched. Returns a structured outcome;
   * never uses --force/-D and never touches a path it did not create here.
   */
  async function rollbackWorktree(plan, gitWorktree, workspace) {
    if (plan === null) return { rolledBack: false, reason: 'no plan to roll back' }
    if (gitWorktree) {
      const removed = await runCommand(['git', '-C', workspace, 'worktree', 'remove', plan.path], workspace)
      if (!removed.ok) {
        return { rolledBack: false, reason: 'git worktree remove failed: ' + (removed.err || removed.out || 'unknown error') }
      }
      const branchDropped = await runCommand(['git', '-C', workspace, 'branch', '-d', plan.branch], workspace)
      return { rolledBack: true, branch: branchDropped.ok ? 'removed' : 'left (git branch -d failed: ' + (branchDropped.err || 'unknown error') + ')' }
    }
    try {
      if (existsSync(plan.path)) rmSync(plan.path, { recursive: true })
      return { rolledBack: !existsSync(plan.path) }
    } catch (fsError) {
      return { rolledBack: false, reason: 'failed to remove plain directory: ' + fail(fsError) }
    }
  }

  function modelSelectionFor(session) {
    const defaultModel = get('agentDefaultModel')
    const fallback = defaultModel !== undefined ? defaultModel.currentSelection() : undefined
    const headerEvent = session.events.findLast((event) => event.type === 'request/header')
    const headerConfig = headerEvent !== undefined && headerEvent.data ? headerEvent.data.header.config : null
    const provider = (headerConfig && headerConfig.provider) || (fallback && fallback.provider) || ''
    const model = (headerConfig && headerConfig.model) || (fallback && fallback.model) || ''
    if (provider === '' || model === '') return undefined
    const selection = { provider, model }
    if (fallback !== undefined && fallback.provider === provider && fallback.model === model
      && fallback.reasoningEffort !== undefined) {
      selection.reasoningEffort = fallback.reasoningEffort
    }
    return selection
  }

  /** Create one worker workspace + session for the coordinator (structured result). */
  async function spawnWorker(coordinator, spec) {
    let worktreeCreated = false
    let gitWorktree = false
    let workerDispatched = false
    let plan = null
    let workspace = null
    try {
      const brief = (spec && typeof spec.brief === 'string' ? spec.brief : '').trim()
      const title = (spec && typeof spec.title === 'string' ? spec.title : '').trim()
      if (brief === '') return { ok: false, error: 'Usage: /worktree <task brief> (one line describing the worker task)' }
      const session = coordinator.session
      workspace = session.header && session.header.cwd
      if (workspace === undefined || workspace === '') {
        return { ok: false, error: 'The coordinator session has no workspace cwd; /worktree needs one.' }
      }
      const slug = slugify(title !== '' ? title : brief) || ('worker-' + Date.now().toString(36))
      plan = worktreePlan(workspace, slug, cfg.worktreeParent)
      // Authorization gate (writes outside the coordinator workspace).
      const decision = authorizationDecision(cfg.askApproval, (() => {
        const approval = get('approval')
        if (approval === undefined) return undefined
        try { return approval.overrideOf(session) } catch { return undefined }
      })())
      if (decision === 'ask') {
        const approval = get('approval')
        if (approval === undefined) {
          return { ok: false, error: 'Worktree creation requires authorization, but the approval service is unavailable; set askApproval: false in the continuity-worktree row config to allow it explicitly.' }
        }
        const outcome = await approval.request({
          agent: coordinator,
          toolName: 'continuity-worktree',
          reason: 'create worker workspace at ' + plan.path,
        })
        if (outcome !== 'allowed-once') {
          return { ok: false, error: 'Worktree creation not authorized (approval outcome: ' + String(outcome) + ').' }
        }
      }
      // Idempotent re-entry: a prior /worktree for the same task already left a
      // directory here — do not create a second worktree/branch.
      if (existsSync(plan.path)) {
        return {
          ok: false,
          error: 'A worker workspace already exists at ' + plan.path + ' — /worktree is idempotent per task; reuse it or choose a different task title.',
          partial: { worktreeCreated: false, existingPath: plan.path, worktreeRolledBack: false },
        }
      }
      // Git classification — a git *failure* is a clear error, never a silent
      // plain-directory fallback.
      const probe = await detectGit(workspace)
      if (probe.kind === 'error') {
        return { ok: false, error: 'Could not determine the repository state: ' + probe.detail + ' — /worktree needs a working Git repository or a plain directory.' }
      }
      gitWorktree = probe.kind === 'git'
      // Pre-flight: resolve everything fallible BEFORE creating the worktree, so
      // a missing registry or route leaves no half-created workspace.
      const agents = get('agents')
      if (agents === undefined) return { ok: false, error: 'agent registry unavailable' }
      const selection = modelSelectionFor(session)
      if (selection === undefined) return { ok: false, error: 'no model route for the worker session' }
      const workerId = 'session-cont-worker-' + Date.now().toString(36)
      const ref = { current: selection, assembled: undefined }
      // Create the worktree (git) or a plain sibling directory (non-Git).
      if (gitWorktree) {
        const result = await runCommand(
          ['git', '-C', workspace, 'worktree', 'add', plan.path, '-b', plan.branch],
          workspace,
        )
        if (!result.ok) {
          if (isWorktreeConflict(result.err) || isWorktreeConflict(result.out)) {
            return {
              ok: false,
              error: 'A worker workspace for this task already exists (git: ' + ((result.err || result.out || 'unknown').trim()) + '). Reuse it or choose a different task title.',
              partial: { worktreeCreated: false, worktreeRolledBack: false },
            }
          }
          return { ok: false, error: 'git worktree add failed: ' + (result.err || result.out || 'unknown error') }
        }
        worktreeCreated = true
      } else {
        try {
          mkdirSync(plan.path, { recursive: true })
          writeFileSync(join(plan.path, 'README.md'),
            '# Worker workspace\n\nCreated by /worktree from coordinator session ' + session.id
            + '.\nCoordinator workspace is not a Git repository — Git facts are not applicable here.\n')
        } catch (fsError) {
          return { ok: false, error: 'failed to create worker directory: ' + fail(fsError) }
        }
        worktreeCreated = true
      }
      // Register the workspace (and keep the record for session attachment).
      let workspaceRecord = undefined
      const workspaces = get('workspaceRegistry')
      if (workspaces !== undefined) {
        try {
          workspaceRecord = await workspaces.resolveByPath(plan.path)
          if (workspaceRecord === undefined) workspaceRecord = await workspaces.create(plan.path, title !== '' ? title : slug)
        } catch {
          workspaceRecord = undefined // registration is advisory; the durable facts below still hold
        }
      }
      // Spawn the worker session.
      await agents.create({
        sessionId: workerId,
        meta: {
          cwd: plan.path,
          parentSession: session.id,
          delegationDepth: 1,
          agentPreset: 'continuity',
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, ref)
          const presets = get('agentPresets')
          if (presets !== undefined) await presets.mount(agentCtx, 'continuity')
        },
      })
      const worker = agents.get(workerId)
      if (worker === undefined) throw new Error('worker session was created but not found in the registry')
      worker.session.append('agent-preset/selected', { agentPreset: 'continuity' })
      // Attach the worker session to its workspace record so the GUI groups it
      // (best-effort: an attach failure is a partial success, never a rollback).
      let attached = false
      let attachError = null
      if (workspaces !== undefined && workspaceRecord !== undefined) {
        try {
          await workspaceRecord.attachSession(workerId)
          attached = true
        } catch (attachErr) {
          attachError = fail(attachErr)
        }
      }
      const prompt = buildWorkerPrompt({
        coordinatorId: session.id,
        worktreePath: plan.path,
        git: gitWorktree,
        branch: plan.branch,
        brief,
      })
      worker.followup({
        id: userMessage('x', 'continuity-worker-task').id,
        role: 'user',
        source: { kind: 'continuity-worker-task', version: 1 },
        content: [{ type: 'text', text: prompt }],
      })
      workerDispatched = true
      // Remember the worker so a completion notice can be steered to the
      // coordinator once it posts "## Worker report" (v5: notifyWorkerDone).
      workerDoneNotices.set(workerId, { coordinator, label: title !== '' ? title : brief })
      return { ok: true, workerId, path: plan.path, branch: plan.branch, git: gitWorktree, attached, attachError }
    } catch (spawnError) {
      // Transactional rollback: undo a worktree THIS call created when the
      // worker never started. Never force; never touch a worktree this call
      // did not create.
      const rollback = (worktreeCreated && !workerDispatched && plan !== null)
        ? await rollbackWorktree(plan, gitWorktree, workspace)
        : { skipped: true, rolledBack: false }
      return {
        ok: false,
        error: '/worktree failed: ' + fail(spawnError),
        partial: {
          worktreeCreated,
          worktreeRolledBack: rollback.rolledBack === true,
          rollbackNote: rollback.reason !== undefined ? rollback.reason
            : rollback.branch !== undefined ? ('branch ' + rollback.branch)
              : rollback.skipped ? 'no worktree was created by this call' : undefined,
          worktreePath: plan !== null ? plan.path : null,
          workerDispatched,
        },
      }
    }
  }

  /** Command-facing wrapper over the structured spawn. */
  async function spawn(coordinator, spec) {
    const result = await spawnWorker(coordinator, spec)
    if (!result.ok) {
      let text = result.error
      if (result.partial && result.partial.worktreeCreated) {
        text += ' (worktree ' + result.partial.worktreePath + ' ' + (result.partial.worktreeRolledBack ? 'rolled back' : 'left in place for manual cleanup') + ')'
      }
      return error(text)
    }
    return success(
      'Worker ' + result.workerId + ' started in ' + result.path
      + (result.git ? ' (git worktree, branch ' + result.branch + ')' : ' (plain directory; coordinator workspace is not a Git repository)')
      + (result.attached === false
        ? ' WARNING: not attached to its workspace group in the GUI' + (result.attachError ? ' (' + result.attachError + ')' : '') + '.'
        : '')
      + ' Track it with /workers and read its report with /worker-report ' + result.workerId + '.',
    )
  }

  /** Durable worker discovery for one coordinator (corpus + live status). */
  async function list(coordinator) {
    try {
      const sessionQuery = get('sessionQuery')
      const agents = get('agents')
      if (sessionQuery === undefined) return error('session query unavailable')
      const sessions = await sessionQuery.listSessions()
      const rows = []
      for (const record of sessions) {
        const header = record.header
        if (header === undefined || header.parentSession !== coordinator.id) continue
        const live = agents !== undefined ? agents.get(header.id) : undefined
        rows.push({
          id: header.id,
          cwd: header.cwd || '(unset)',
          createdAt: header.createdAt,
          live: live !== undefined,
          status: live !== undefined ? live.status : 'not-live',
        })
      }
      rows.sort((a, b) => a.createdAt - b.createdAt)
      const lines = ['Workers of coordinator ' + coordinator.id + ':']
      if (rows.length === 0) lines.push('(none — spawn one with /worktree <task brief>)')
      for (const row of rows) {
        lines.push('- ' + row.id + ' [' + row.status + '] ' + row.cwd)
      }
      const mission = scanMission(coordinator)
      if (mission !== null) {
        lines.push('- mission checkpoint: last durable at seq ' + String(mission.seq))
      } else {
        lines.push('- mission checkpoint: none yet (maintain one in your replies with the marker ' + MISSION_MARKER + ')')
      }
      return success(lines.join('\n'))
    } catch (listError) {
      return error('/workers failed: ' + fail(listError))
    }
  }

  /** Coordinator -> live worker message (host-side push channel). */
  function send(coordinator, workerId, text) {
    try {
      const message = (typeof text === 'string' ? text : '').trim()
      if (workerId === undefined || workerId === '') return error('Usage: /worker-send <worker-id> <message>')
      if (message === '') return error('Usage: /worker-send <worker-id> <message>')
      const agents = get('agents')
      const worker = agents !== undefined ? agents.get(workerId) : undefined
      if (worker === undefined) {
        return error('Worker ' + workerId + ' is not live (its durable log is still readable with /worker-report).')
      }
      worker.followup({
        id: userMessage('x', 'continuity-coordinator').id,
        role: 'user',
        source: { kind: 'continuity-coordinator', version: 1 },
        content: [{ type: 'text', text: 'Coordinator message (session ' + coordinator.id + '):\n\n' + message }],
      })
      return success('Message delivered to worker ' + workerId + '.')
    } catch (sendError) {
      return error('/worker-send failed: ' + fail(sendError))
    }
  }

  /**
   * Cancel a live worker and detach it from its workspace group. The worker
   * session is stopped; its worktree is left in place — merge/delete is always
   * a human decision (no automatic merge/checkout/reset/clean).
   */
  async function stop(coordinator, workerId) {
    try {
      if (workerId === undefined || workerId === '') return error('Usage: /worker-stop <worker-id>')
      const agents = get('agents')
      const worker = agents !== undefined ? agents.get(workerId) : undefined
      if (worker === undefined) return success('Worker ' + workerId + ' is not live; nothing to stop.')
      const cwd = worker.session && worker.session.header && worker.session.header.cwd
      worker.cancel({ kind: 'parent' })
      // Detach the stopped worker from its workspace group (best-effort).
      let detached = false
      let detachNote = ''
      if (cwd !== undefined && cwd !== '') {
        const workspaces = get('workspaceRegistry')
        if (workspaces !== undefined) {
          try {
            const ws = await workspaces.resolveByPath(cwd)
            if (ws !== undefined) {
              await ws.detachSession(workerId)
              detached = true
            }
          } catch (detachError) {
            detachNote = ' (could not detach from its workspace group: ' + fail(detachError) + ')'
          }
        }
      }
      return success(
        'Stop requested for worker ' + workerId + '.'
        + (cwd !== undefined && cwd !== '' ? ' Its worktree at ' + cwd + ' is left in place — merge/delete is always a human decision.' : '')
        + (detached ? ' Detached from its workspace group.' : detachNote),
      )
    } catch (stopError) {
      return error('/worker-stop failed: ' + fail(stopError))
    }
  }

  /** Bounded pull of a worker's latest report + checkpoint facts. */
  async function report(coordinator, workerId) {
    try {
      if (workerId === undefined || workerId === '') return error('Usage: /worker-report <worker-id>')
      const sessionQuery = get('sessionQuery')
      if (sessionQuery === undefined) return error('session query unavailable')
      const agents = get('agents')
      const live = agents !== undefined ? agents.get(workerId) : undefined
      const surface = await sessionQuery.readSurface(workerId)
      const extracted = extractWorkerReport(surface, cfg.reportCapChars)
      const lines = [
        'Worker ' + workerId + ' (cwd: ' + String(surface.session.cwd || '(unset)') + ', ' + (live !== undefined ? 'live ' + live.status : 'not live') + ')',
        '- durable checkpoint: ' + (extracted.hasCheckpoint ? 'present' : 'none'),
      ]
      if (extracted.tail === null) {
        lines.push('- no assistant output yet')
      } else {
        lines.push('- latest assistant message (seq ' + String(extracted.lastSeq) + '):')
        lines.push('')
        lines.push(extracted.tail)
      }
      return success(lines.join('\n'))
    } catch (reportError) {
      return error('/worker-report failed: ' + fail(reportError))
    }
  }

  /**
   * Two-step cleanup of temporary worktree workspace records (GUI grouping).
   *   dry-run: list worktree workspaces (path contains cfg.worktreeMarker) and
   *            their settled vs live worker sessions — no mutation.
   *   confirm: for workspaces with only settled workers, detach each settled
   *            worker session and delete the workspace record. Directories and
   *            session logs are always kept; nothing is deleted without an
   *            explicit confirm, and a workspace with a live worker is skipped.
   */
  async function cleanup(coordinator, mode) {
    try {
      const raw = (typeof mode === 'string' ? mode : '').trim().replace(/^--?/, '')
      if (raw !== 'dry-run' && raw !== 'confirm') {
        return error('Usage: /worktree-cleanup --dry-run | --confirm  (no deletion happens without --confirm)')
      }
      const workspaces = get('workspaceRegistry')
      if (workspaces === undefined) return error('workspace registry unavailable')
      let all = []
      try {
        all = workspaces.list() || []
      } catch {
        return error('workspace registry list unavailable')
      }
      const agents = get('agents')
      const records = []
      for (const ws of all) {
        const path = typeof ws.path === 'string' ? ws.path : ''
        if (path === '' || !path.includes(cfg.worktreeMarker)) continue
        const sessionIds = Array.isArray(ws.sessionIds) ? [...ws.sessionIds] : []
        const settled = []
        const live = []
        for (const sid of sessionIds) {
          // Without an agents service we cannot prove a session is settled, so
          // treat it as live (conservative): confirm never deletes it.
          const agent = agents !== undefined ? agents.get(sid) : undefined
          if (agents === undefined || agent !== undefined) live.push(sid)
          else settled.push(sid)
        }
        records.push({ ws, path, title: ws.title, sessionIds, settled, live })
      }
      if (raw === 'dry-run') {
        const lines = ['Worktree workspace cleanup — dry run (no changes made):']
        if (records.length === 0) lines.push('(no temporary worktree workspaces found; marker "' + cfg.worktreeMarker + '")')
        for (const r of records) {
          lines.push('- ' + r.path + ' — ' + r.settled.length + ' settled worker(s), ' + r.live.length + ' live worker(s)')
          for (const sid of r.settled) lines.push('    settled (removable on --confirm): ' + sid)
          for (const sid of r.live) lines.push('    live (skipped): ' + sid)
        }
        lines.push('Run /worktree-cleanup --confirm to detach settled workers and remove these workspace records (directories and session logs are always kept).')
        return success(lines.join('\n'))
      }
      const report = []
      let removed = 0
      let skipped = 0
      for (const r of records) {
        if (r.live.length > 0) {
          report.push('- skipped (live worker attached): ' + r.path)
          skipped += 1
          continue
        }
        try {
          for (const sid of r.settled) {
            try { await r.ws.detachSession(sid) } catch { /* delete below still ungroups the session */ }
          }
          const ok = await workspaces.delete(r.ws.id)
          if (ok) {
            report.push('- removed workspace record: ' + r.path + ' (directory + session logs kept)')
            removed += 1
          } else {
            report.push('- no-op (already removed): ' + r.path)
          }
        } catch (cleanupError) {
          report.push('- FAILED: ' + r.path + ' (' + fail(cleanupError) + ')')
          skipped += 1
        }
      }
      return success(
        ['Worktree workspace cleanup — confirmed: removed ' + removed + ' record(s), skipped ' + skipped + ' (directories and session logs are always kept).']
          .concat(report.length > 0 ? report : ['(no temporary worktree workspaces found)'])
          .join('\n'),
      )
    } catch (cleanupError) {
      return error('/worktree-cleanup failed: ' + fail(cleanupError))
    }
  }

  /** Last durable mission checkpoint in the coordinator's own log. */
  function scanMission(coordinator) {
    const events = coordinator.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = textOfMessage(event.data && event.data.message)
      if (text.includes(MISSION_MARKER)) {
        return { seq: event.seq, text: capText(text, cfg.missionCapChars) }
      }
    }
    return null
  }

  // v5: notify the coordinator once when a spawned worker posts its report.
  if (cfg.notifyWorkerDone) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const notice = workerDoneNotices.get(session.id)
      if (notice === undefined) return
      const text = textOfMessage(event.data && event.data.message)
      if (typeof text !== 'string' || !text.includes('## Worker report')) return
      workerDoneNotices.delete(session.id)
      try {
        notice.coordinator.steer(userMessage(
          '✅ Worker ' + session.id + ' 已完成任务（' + notice.label + '）并提交了报告。\n'
          + '查看报告: /worker-report ' + session.id + '；列表: /workers。',
          'continuity-worker-done',
        ))
      } catch { /* notification is best-effort */ }
    })
  }

  ctx.provide(SERVICE, {
    spawn,
    spawnWorker,
    list,
    send,
    stop,
    cleanup,
    report,
    mission: scanMission,
    get config() { return cfg },
  })
  return undefined
}
