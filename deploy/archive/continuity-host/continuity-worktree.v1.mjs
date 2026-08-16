/**
 * continuity-worktree — host-plane worktree/worker driver (V4 design, Phase B).
 *
 * User-owned host component installed through the active profile's user patch
 * layer. Publishes the plain service `continuityWorktree` consumed by the
 * `continuity` preset's /worktree, /workers, /worker-send, /worker-stop and
 * /worker-report commands.
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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  MARKER,
  validateCheckpoint,
  userMessage,
  capText,
  textOfMessage,
} from 'file:///C:/Users/wangy/.dsh/.agent-presets/continuity/continuity-plugin.v2.mjs'

export const SERVICE = 'continuityWorktree'
export const MISSION_MARKER = '<!-- DSH_MISSION v1 -->'

const DEFAULTS = Object.freeze({
  askApproval: true,
  worktreeParent: null, // null = sibling of the coordinator workspace
  reportCapChars: 8000,
  missionCapChars: 8000,
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

  async function isGitRepo(workspace) {
    const result = await runCommand(['git', '-C', workspace, 'rev-parse', '--is-inside-work-tree'], workspace)
    return result.ok && result.out === 'true'
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

  /** Create one worker workspace + session for the coordinator. */
  async function spawn(coordinator, spec) {
    try {
      const brief = (spec && typeof spec.brief === 'string' ? spec.brief : '').trim()
      const title = (spec && typeof spec.title === 'string' ? spec.title : '').trim()
      if (brief === '') return error('Usage: /worktree <task brief> (one line describing the worker task)')
      const session = coordinator.session
      const workspace = session.header && session.header.cwd
      if (workspace === undefined || workspace === '') {
        return error('The coordinator session has no workspace cwd; /worktree needs one.')
      }
      const slug = slugify(title !== '' ? title : brief) || ('worker-' + Date.now().toString(36))
      const plan = worktreePlan(workspace, slug, cfg.worktreeParent)
      // Authorization gate (writes outside the coordinator workspace).
      const decision = authorizationDecision(cfg.askApproval, (() => {
        const approval = get('approval')
        if (approval === undefined) return undefined
        try { return approval.overrideOf(session) } catch { return undefined }
      })())
      if (decision === 'ask') {
        const approval = get('approval')
        if (approval === undefined) {
          return error('Worktree creation requires authorization, but the approval service is unavailable; set askApproval: false in the continuity-worktree row config to allow it explicitly.')
        }
        const outcome = await approval.request({
          agent: coordinator,
          toolName: 'continuity-worktree',
          reason: 'create worker workspace at ' + plan.path,
        })
        if (outcome !== 'allowed-once') {
          return error('Worktree creation not authorized (approval outcome: ' + String(outcome) + ').')
        }
      }
      // Create the worktree (git) or a plain sibling directory (non-Git).
      let gitWorktree = false
      try {
        gitWorktree = await isGitRepo(workspace)
      } catch {
        gitWorktree = false
      }
      if (gitWorktree) {
        const result = await runCommand(
          ['git', '-C', workspace, 'worktree', 'add', plan.path, '-b', plan.branch],
          workspace,
        )
        if (!result.ok) {
          return error('git worktree add failed: ' + (result.err || result.out || 'unknown error'))
        }
      } else {
        if (existsSync(plan.path)) {
          return error('Worker directory already exists: ' + plan.path)
        }
        try {
          mkdirSync(plan.path, { recursive: true })
          writeFileSync(join(plan.path, 'README.md'),
            '# Worker workspace\n\nCreated by /worktree from coordinator session ' + session.id
            + '.\nCoordinator workspace is not a Git repository — Git facts are not applicable here.\n')
        } catch (fsError) {
          return error('failed to create worker directory: ' + fail(fsError))
        }
      }
      // Register the workspace.
      const workspaces = get('workspaceRegistry')
      if (workspaces !== undefined) {
        try {
          const existing = await workspaces.resolveByPath(plan.path)
          if (existing === undefined) await workspaces.create(plan.path, title !== '' ? title : slug)
        } catch {
          // registration is advisory; the durable facts below still hold
        }
      }
      // Spawn the worker session.
      const agents = get('agents')
      if (agents === undefined) return error('agent registry unavailable')
      const selection = modelSelectionFor(session)
      if (selection === undefined) return error('no model route for the worker session')
      const workerId = 'session-cont-worker-' + Date.now().toString(36)
      const ref = { current: selection, assembled: undefined }
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
      if (worker === undefined) return error('worker session was created but not found in the registry')
      worker.session.append('agent-preset/selected', { agentPreset: 'continuity' })
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
      return success(
        'Worker ' + workerId + ' started in ' + plan.path
        + (gitWorktree ? ' (git worktree, branch ' + plan.branch + ')' : ' (plain directory; coordinator workspace is not a Git repository)')
        + '. Track it with /workers and read its report with /worker-report ' + workerId + '.',
      )
    } catch (spawnError) {
      return error('/worktree failed: ' + fail(spawnError))
    }
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

  /** Cancel a live worker. */
  function stop(coordinator, workerId) {
    try {
      if (workerId === undefined || workerId === '') return error('Usage: /worker-stop <worker-id>')
      const agents = get('agents')
      const worker = agents !== undefined ? agents.get(workerId) : undefined
      if (worker === undefined) return success('Worker ' + workerId + ' is not live; nothing to stop.')
      worker.cancel({ kind: 'parent' })
      return success('Stop requested for worker ' + workerId + '.')
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

  ctx.provide(SERVICE, {
    spawn,
    list,
    send,
    stop,
    report,
    mission: scanMission,
    get config() { return cfg },
  })
  return undefined
}
