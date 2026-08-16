/**
 * continuity-mission — host-plane mission orchestration driver (V4 design, Phase C).
 *
 * Bounded automatic mission loop over the coordinator session:
 *   plan → dispatch (bounded batches of worktree workers) → collect
 *   (worker ## Worker report) → review (coordinator VERDICT) → rework
 *   (bounded) → closeout (durable mission checkpoint) | escalate.
 *
 * The DRIVER owns the loop mechanics, budgets and escalation; the MODEL owns
 * judgment (decomposition, review, closeout), driven through steering prompts
 * with strict marker formats. Every phase is bounded by timeouts and round
 * caps; failure escalates with an explicit blocking report — the loop never
 * silently expands.
 *
 * Durable recovery: the mission checkpoint (and each plan/review turn) live
 * in the coordinator's ordinary assistant/message events, so a restarted
 * process can still read them; the live loop itself restarts from /mission
 * status (phase machine is per-generation memory, honestly reported).
 */
import {
  userMessage,
  textOfMessage,
  capText,
} from 'file:///C:/Users/<USER>/.dsh/.agent-presets/continuity/continuity-plugin.v3.mjs'
import { extractWorkerReport, MISSION_MARKER } from 'file:///C:/Users/<USER>/.dsh/continuity-host/continuity-worktree.v2.mjs'

export const SERVICE = 'continuityMission'
export const PLAN_MARKER = '<!-- DSH_MISSION_PLAN v1 -->'

const DEFAULTS = Object.freeze({
  maxTasks: 4,
  maxConcurrent: 2,
  planTimeoutMs: 240000,
  reviewTimeoutMs: 240000,
  workerTimeoutMs: 600000,
  workerRounds: 1,
  missionTimeoutMs: 1800000,
  reportCapChars: 6000,
  pollIntervalMs: 5000,
})

export function sanitizeMissionConfig(raw) {
  const src = (raw !== null && typeof raw === 'object') ? raw : {}
  const intInRange = (value, fallback, lo, hi) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(hi, Math.max(lo, Math.trunc(value)))
  }
  return {
    maxTasks: intInRange(src.maxTasks, DEFAULTS.maxTasks, 1, 8),
    maxConcurrent: intInRange(src.maxConcurrent, DEFAULTS.maxConcurrent, 1, 4),
    planTimeoutMs: intInRange(src.planTimeoutMs, DEFAULTS.planTimeoutMs, 10000, 3600000),
    reviewTimeoutMs: intInRange(src.reviewTimeoutMs, DEFAULTS.reviewTimeoutMs, 10000, 3600000),
    workerTimeoutMs: intInRange(src.workerTimeoutMs, DEFAULTS.workerTimeoutMs, 30000, 3600000),
    workerRounds: intInRange(src.workerRounds, DEFAULTS.workerRounds, 0, 3),
    missionTimeoutMs: intInRange(src.missionTimeoutMs, DEFAULTS.missionTimeoutMs, 60000, 7200000),
    reportCapChars: intInRange(src.reportCapChars, DEFAULTS.reportCapChars, 1000, 64000),
    pollIntervalMs: intInRange(src.pollIntervalMs, DEFAULTS.pollIntervalMs, 1000, 60000),
  }
}

/** Parse a mission plan block (pure). */
export function parsePlan(text, maxTasks) {
  if (typeof text !== 'string' || !text.includes(PLAN_MARKER)) {
    return { error: 'plan marker missing', tasks: [] }
  }
  const tasks = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('TASK|')) continue
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 3 || parts[1] === '' || parts[2] === '') {
      return { error: 'malformed task line: ' + rawLine, tasks: [] }
    }
    tasks.push({ title: parts[1].slice(0, 80), brief: parts[2].slice(0, 400) })
  }
  if (tasks.length === 0) return { error: 'no TASK lines found', tasks: [] }
  if (maxTasks !== undefined && tasks.length > maxTasks) {
    return { error: 'too many tasks (' + tasks.length + ' > ' + maxTasks + ')', tasks: [] }
  }
  return { error: null, tasks }
}

/** Parse a coordinator verdict line (pure). */
export function parseVerdict(text) {
  if (typeof text !== 'string') return null
  const match = /VERDICT:\s*(approve|rework)\b([\s\S]*)?/i.exec(text)
  if (match === null) return null
  return { decision: match[1].toLowerCase(), note: (match[2] || '').trim().slice(0, 400) }
}

function planPrompt(goal, maxTasks) {
  return [
    'Mission planning step (continuity mission loop).',
    'Goal from the user:',
    goal,
    '',
    'Decompose the goal into independent, verifiable tasks for workers. Reply with EXACTLY this block and nothing before it:',
    PLAN_MARKER,
    'TASK|<short title>|<one-line task brief, independent and verifiable>',
    'TASK|...',
    '',
    'Rules: at most ' + String(maxTasks) + ' tasks; each task must be verifiable by a worker alone in its own workspace; no task may depend on another task branch; use no tools while planning.',
  ].join('\n')
}

function reviewPrompt(task, workerId, path, report) {
  return [
    'Coordinator review step (continuity mission loop).',
    'Task: ' + task.title + ' — ' + task.brief,
    'Worker: ' + workerId + ', workspace: ' + path,
    '',
    'Worker report:',
    report,
    '',
    'Decide whether the report satisfies the task with concrete verification. Reply with EXACTLY one line and nothing else:',
    'VERDICT: approve',
    'or',
    'VERDICT: rework <short instruction for the worker>',
  ].join('\n')
}

function closeoutPrompt(goal, results) {
  const lines = ['Mission closeout step (continuity mission loop).', 'Goal:', goal, '', 'Results:']
  for (const result of results) {
    lines.push('- ' + result.task.title + ': ' + (result.verdict ? result.verdict.decision : 'unresolved')
      + (result.spawn !== undefined ? ' (worker ' + result.spawn.workerId + ', ' + result.spawn.path + ')' : ''))
  }
  lines.push('', 'Write the final mission checkpoint. Reply starting EXACTLY with the marker line:', MISSION_MARKER)
  lines.push('then a markdown document with sections: ## Goal / ## Workspaces / ## Progress / ## Decisions / ## Open problems / ## Next actions.')
  lines.push('Record only verified outcomes; be honest about failures. End the reply after Next actions.')
  return lines.join('\n')
}

function escalatePrompt(goal, phase, reason) {
  return [
    'Mission escalation (continuity mission loop stopped).',
    'Goal: ' + goal,
    'Phase when it stopped: ' + phase + '; reason: ' + reason,
    'Summarize the blocking condition for the human and suggest concrete manual next steps. Do not spawn new workers.',
  ].join('\n')
}

export default function continuityMission(ctx, config) {
  const cfg = sanitizeMissionConfig(config)
  const fail = (error) => (error instanceof Error ? error.message : String(error))
  const get = (name) => ctx.get(name)
  const error = (text) => ({ kind: 'error', text })
  const success = (text) => ({ kind: 'success', text })

  // coordinatorId -> mission state
  const states = new Map()
  // coordinatorId -> waiters [{ afterSeq, marker, settle }]
  const waits = new Map()

  function freshState() {
    return {
      phase: 'idle', // idle | planning | dispatching | closing | done | failed
      goal: '',
      tasks: [],
      results: [],
      startedAt: 0,
      error: null,
    }
  }

  function getState(id) {
    let state = states.get(id)
    if (state === undefined) {
      state = freshState()
      states.set(id, state)
      if (states.size > 128) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
    }
    return state
  }

  function settleWaiters(sessionId, event) {
    const entry = waits.get(sessionId)
    if (entry === undefined || entry.length === 0) return
    const text = textOfMessage(event.data && event.data.message)
    const remaining = []
    for (const waiter of entry) {
      if (waiter.done) continue
      if (event.seq > waiter.afterSeq && text.includes(waiter.marker)) {
        waiter.done = true
        waiter.settle({ seq: event.seq, text })
      } else {
        remaining.push(waiter)
      }
    }
    if (remaining.length === 0) waits.delete(sessionId)
    else waits.set(sessionId, remaining)
  }

  function waitForAssistant(sessionId, afterSeq, marker, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { afterSeq, marker, done: false, settle: resolve }
      const entry = waits.get(sessionId)
      if (entry === undefined) waits.set(sessionId, [waiter])
      else entry.push(waiter)
      const timer = get('timer')
      if (timer !== undefined) {
        void timer.timeout(timeoutMs).then(() => {
          if (waiter.done) return
          waiter.done = true
          resolve(null)
        })
      }
    })
  }

  const sleep = (ms) => {
    const timer = get('timer')
    return timer !== undefined ? timer.timeout(ms) : Promise.resolve()
  }

  function steer(agent, text) {
    agent.steer(userMessage(text, 'continuity-mission'))
  }

  async function steerAndWait(coordinator, promptText, marker, timeoutMs) {
    const session = coordinator.session
    const afterSeq = session.events.length
    steer(coordinator, promptText)
    return await waitForAssistant(session.id, afterSeq, marker, timeoutMs)
  }

  async function collectWorker(workerId, timeoutMs) {
    const sessionQuery = get('sessionQuery')
    const agents = get('agents')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const worker = agents !== undefined ? agents.get(workerId) : undefined
      if (worker === undefined || worker.status === 'idle') {
        try {
          const surface = await sessionQuery.readSurface(workerId)
          const extracted = extractWorkerReport(surface, cfg.reportCapChars)
          if (extracted.tail !== null && extracted.tail.includes('## Worker report')) {
            return { tail: extracted.tail, hasCheckpoint: extracted.hasCheckpoint }
          }
        } catch {
          // corpus not ready yet; keep polling
        }
      }
      await sleep(cfg.pollIntervalMs)
    }
    return null
  }

  async function escalate(coordinator, state, reason) {
    state.phase = 'failed'
    state.error = reason
    try {
      steer(coordinator, escalatePrompt(state.goal, 'loop', reason))
    } catch {
      // the coordinator session is already the failure surface
    }
  }

  async function runMission(coordinator) {
    const state = getState(coordinator.id)
    const session = coordinator.session
    try {
      // 1. plan (one format retry)
      let planned = null
      for (let attempt = 0; attempt < 2 && planned === null; attempt += 1) {
        const prompt = attempt === 0
          ? planPrompt(state.goal, cfg.maxTasks)
          : 'The previous plan was invalid. Reply with the corrected plan block:\n' + PLAN_MARKER + '\nTASK|<title>|<brief>\nTASK|...'
        const response = await steerAndWait(coordinator, prompt, PLAN_MARKER, cfg.planTimeoutMs)
        if (response === null) continue
        const parsed = parsePlan(response.text, cfg.maxTasks)
        if (parsed.error === null) planned = parsed.tasks
        else state.error = parsed.error
      }
      if (planned === null) {
        return await escalate(coordinator, state, 'plan step failed: ' + String(state.error || 'no plan produced in time'))
      }
      state.tasks = planned
      state.phase = 'dispatching'

      // 2. dispatch + collect + review (bounded batches, bounded rounds)
      const worktree = get('continuityWorktree')
      if (worktree === undefined || typeof worktree.spawnWorker !== 'function') {
        return await escalate(coordinator, state, 'worktree driver unavailable')
      }
      const missionDeadline = state.startedAt + cfg.missionTimeoutMs
      let index = 0
      while (index < state.tasks.length) {
        if (Date.now() > missionDeadline) {
          return await escalate(coordinator, state, 'mission budget exhausted')
        }
        const batch = state.tasks.slice(index, index + cfg.maxConcurrent)
        const outcomes = await Promise.all(batch.map(async (task) => {
          const spawn = await worktree.spawnWorker(coordinator, { brief: task.title + ': ' + task.brief })
          if (!spawn.ok) return { task, spawnError: spawn.error, verdict: null }
          let report = await collectWorker(spawn.workerId, cfg.workerTimeoutMs)
          let rounds = 0
          while (true) {
            if (report === null) return { task, spawn, report: null, timedOut: true, verdict: null }
            let verdict = null
            let verdictAttempts = 0
            while (verdict === null && verdictAttempts < 2) {
              const review = await steerAndWait(
                coordinator,
                reviewPrompt(task, spawn.workerId, spawn.path, report.tail),
                'VERDICT:',
                cfg.reviewTimeoutMs,
              )
              if (review === null) {
                verdictAttempts += 1
                continue
              }
              verdict = parseVerdict(review.text)
              if (verdict === null) verdictAttempts += 1
            }
            if (verdict === null) return { task, spawn, report, verdict: null, reviewError: 'no parseable verdict' }
            if (verdict.decision === 'rework' && rounds < cfg.workerRounds) {
              rounds += 1
              try {
                worktree.send(coordinator, spawn.workerId,
                  'Rework requested by the coordinator: ' + verdict.note + '. Address it, then end with "## Worker report" again.')
              } catch {
                // worker not live: rework impossible; treat as unresolved
              }
              report = await collectWorker(spawn.workerId, cfg.workerTimeoutMs)
              continue
            }
            return { task, spawn, report, verdict, rounds }
          }
        }))
        for (const outcome of outcomes) state.results.push(outcome)
        index += cfg.maxConcurrent
      }

      // 3. closeout (durable mission checkpoint)
      state.phase = 'closing'
      const closeout = await steerAndWait(coordinator, closeoutPrompt(state.goal, state.results), MISSION_MARKER, cfg.reviewTimeoutMs)
      if (closeout === null) {
        return await escalate(coordinator, state, 'closeout checkpoint not produced in time')
      }
      state.phase = 'done'
      state.error = null
    } catch (runError) {
      state.phase = 'failed'
      state.error = fail(runError)
    }
  }

  async function start(coordinator, goal) {
    const trimmed = (typeof goal === 'string' ? goal : '').trim()
    if (trimmed === '') return error('Usage: /mission <goal> — or /mission status to inspect the current mission')
    const state = getState(coordinator.id)
    if (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'failed') {
      return error('A mission is already running (phase ' + state.phase + '); inspect it with /mission status.')
    }
    Object.assign(state, freshState())
    state.phase = 'planning'
    state.goal = trimmed
    state.startedAt = Date.now()
    void runMission(coordinator).catch(() => {})
    return success('Mission started (phase planning): "' + trimmed + '". Track it with /mission status.')
  }

  function status(coordinator) {
    const state = getState(coordinator.id)
    const lines = [
      'Mission of coordinator ' + coordinator.id + ':',
      '- phase: ' + state.phase + (state.error !== null && state.error !== undefined ? ' (last error: ' + String(state.error) + ')' : ''),
      '- goal: ' + (state.goal === '' ? '(none)' : state.goal),
      '- tasks: ' + String(state.tasks.length),
    ]
    for (const result of state.results) {
      const verdict = result.verdict !== null && result.verdict !== undefined
        ? result.verdict.decision + (result.verdict.note !== '' ? ' (' + result.verdict.note.slice(0, 80) + ')' : '')
        : result.timedOut ? 'timed out' : result.spawnError ? 'spawn failed' : result.reviewError ? 'review failed' : 'unresolved'
      lines.push('- ' + result.task.title + ' → ' + verdict
        + (result.spawn !== undefined ? ' [worker ' + result.spawn.workerId + ', ' + result.spawn.path + ']' : ''))
    }
    if (state.phase === 'idle') lines.push('(no mission yet — start one with /mission <goal>)')
    return success(lines.join('\n'))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') settleWaiters(session.id, event)
  })

  ctx.provide(SERVICE, {
    start,
    status,
    get config() { return cfg },
  })
  return undefined
}
