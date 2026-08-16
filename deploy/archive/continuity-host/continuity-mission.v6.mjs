/**
 * continuity-mission — host-plane mission orchestration driver (V4 design, Phase C).
 *
 * v6 (this file): `/mission status` opens with a plain-language "where are we"
 * line (`missionSummary`), e.g. "已派 2 个任务给 worker，正在干活、等报告".
 *
 * v5 (this file): fix `/mission status` elapsed on idle — fresh state keeps
 * `startedAt: null` and the guard requires `> 0`, so an idle mission shows
 * `n/a` instead of a bogus epoch-scale duration.
 *
 * v4 (this file): human-readable output — plan/review prompts now require a
 * short Markdown summary before the machine block / verdict line; `/mission
 * status` reports elapsed time and settled-task progress.
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
 * v2 changes (vs v1):
 *   P0 — collectWorker is incremental: it keeps a per-worker seq cursor so each
 *        poll only scans events newer than the cursor instead of re-scanning the
 *        whole surface every poll. Result semantics are unchanged (the latest
 *        assistant message still decides the report). Rework re-collect now
 *        resumes from the last report seq, so a rework collect cannot re-read the
 *        previous report.
 *   P0 — waits table: timeouts are always armed (timer service OR a native
 *        setTimeout fallback, so a missing timer service can never leave a waiter
 *        hanging forever), and a timed-out waiter is removed from the table
 *        immediately instead of leaking until the next event.
 *   P0 — concurrent batch isolation: each batch task runs inside its own try/catch
 *        and reviews run sequentially (the coordinator produces one verdict per
 *        model turn), so one task failure or a shared-marker cross-match can no
 *        longer abort or corrupt sibling tasks.
 *   P0 — worker not-live recovery: a non-live worker's durable report is still
 *        collected via the corpus; when a rework message cannot be delivered
 *        because the worker is not live, the outcome records `reworkError`
 *        instead of silently swallowing and timing out.
 *   P0 — report truncation is code-point safe: capTextSafe never cuts inside a
 *        UTF-16 surrogate pair, so a multi-byte character is never split.
 *   P2 — /mission resume: an explicit command (never automatic) that rebuilds the
 *        state machine from the last durable mission checkpoint and re-runs the
 *        bounded loop from the recovered goal.
 *
 * Durable recovery: the mission checkpoint (and each plan/review turn) live in
 * the coordinator's ordinary assistant/message events, so a restarted process
 * can still read them.
 */
import {
  userMessage,
  textOfMessage,
  sectionBody,
  MARKER,
} from 'file:///C:/Users/<USER>/.dsh/continuity-host/continuity-shared.v1.mjs'
import { MISSION_MARKER } from 'file:///C:/Users/<USER>/.dsh/continuity-host/continuity-shared.v1.mjs'

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

/**
 * Plain-language "where are we" summary for /mission status (pure, testable).
 * `state` is the mission state object; `elapsed` is an optional human string.
 */
export function missionSummary(state, elapsed) {
  const tasks = Array.isArray(state.tasks) ? state.tasks.length : 0
  const results = Array.isArray(state.results) ? state.results : []
  const settled = results.filter((r) => r.verdict !== null && r.verdict !== undefined
    || r.timedOut || r.spawnError || r.taskError || r.reviewError).length
  const when = elapsed !== undefined && elapsed !== null ? '，已进行 ' + elapsed : ''
  switch (state.phase) {
    case 'idle':
      return '还没有 mission——想让它自动拆任务、派 worker、收报告，就发 /mission <目标>。'
    case 'planning':
      return '正在拆解目标、规划任务（第 1 步）' + when + '，规划好就自动派 worker。'
    case 'dispatching':
      return '已派 ' + tasks + ' 个任务给 worker，正在干活、等报告' + when + '（' + settled + '/' + tasks + ' 已定）。'
    case 'closing':
      return '任务都收口了，正在写最终 checkpoint' + when + '（' + settled + '/' + tasks + ' 完成）。'
    case 'done':
      return '全部完成 ✅' + when + '（' + settled + '/' + tasks + ' 通过审查）。'
    case 'failed':
      return '卡住了 ❌' + when + '：' + (state.error ? String(state.error) : '未知原因')
        + '。可以 /mission resume 重试。'
    default:
      return '阶段：' + String(state.phase)
  }
}

/** Parse a mission plan block (pure). */
export function parsePlan(text, maxTasks) {  if (typeof text !== 'string' || !text.includes(PLAN_MARKER)) {
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

/** True when `code` is a UTF-16 low surrogate (second half of a surrogate pair). */
function isLowSurrogate(code) {
  return (code & 0xfc00) === 0xdc00
}

/**
 * Bound a long text with a head/tail character cap, never splitting a UTF-16
 * surrogate pair (so a UTF-8 multi-byte character is never cut in half). The
 * budget is measured in UTF-16 code units, matching the previous `capText`
 * semantics; boundary positions are nudged by at most one code unit when they
 * would otherwise land on a low surrogate.
 */
export function capTextSafe(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  const head = Math.ceil(maxChars / 2)
  const tail = Math.floor(maxChars / 2)
  let headEnd = head
  while (headEnd > 0 && headEnd < text.length && isLowSurrogate(text.charCodeAt(headEnd))) headEnd -= 1
  let tailStart = text.length - tail
  while (tailStart > 0 && tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  const omitted = text.length - (headEnd + (text.length - tailStart))
  return text.slice(0, headEnd)
    + '\n…[continuity: omitted ' + String(omitted) + ' chars]…\n'
    + text.slice(tailStart)
}

/**
 * Incremental worker-surface scan (pure): fold only events with `seq > afterSeq`
 * onto a carried state. Returns the latest assistant-message text, whether a
 * checkpoint marker was seen, and the latest assistant seq. This is the cursor
 * primitive that makes collectWorker O(new events) per poll instead of O(n).
 */
export function scanWorkerEvents(events, afterSeq, state) {
  const prev = state !== null && state !== undefined ? state : {}
  let tail = prev.tail === undefined ? null : prev.tail
  let hasCheckpoint = prev.hasCheckpoint === true
  let lastSeq = prev.lastSeq === undefined ? null : prev.lastSeq
  for (const event of events) {
    if (event === null || event === undefined) continue
    if (typeof event.seq === 'number' && event.seq <= afterSeq) continue
    if (event.type !== 'assistant/message') continue
    const text = textOfMessage(event.data && event.data.message)
    if (text === '') continue
    tail = text
    lastSeq = event.seq
    if (text.includes(MARKER)) hasCheckpoint = true
  }
  return { tail, hasCheckpoint, lastSeq }
}

/** Last durable mission checkpoint in a session log, or null (pure). */
export function findMissionCheckpoint(session) {
  const events = session && Array.isArray(session.events) ? session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || event === undefined) continue
    if (event.type !== 'assistant/message') continue
    const text = textOfMessage(event.data && event.data.message)
    if (text.includes(MISSION_MARKER)) {
      return { seq: event.seq, text }
    }
  }
  return null
}

/** Goal from a mission checkpoint's `## Goal` section, or null (pure). */
export function missionGoalFromCheckpoint(text) {
  if (typeof text !== 'string' || !text.includes(MISSION_MARKER)) return null
  const body = sectionBody(text, 'Goal')
  if (body === null) return null
  const goal = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (/^#{2,4}\s+/.test(trimmed)) break // next section heading
    if (trimmed !== '') goal.push(trimmed)
  }
  return goal.length === 0 ? null : goal.join(' ')
}

function planPrompt(goal, maxTasks) {
  return [
    'Mission planning step (continuity mission loop).',
    'Goal from the user:',
    goal,
    '',
    'First write a SHORT human-readable Markdown summary of the plan: one status line (goal + number of tasks), then a few bullet points covering the task order and what each task will verify. After the summary, reply with the EXACT machine plan block (nothing between the summary and the block):',
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
    'Decide whether the report satisfies the task with concrete verification. Reply with a SHORT Markdown rationale (2-3 bullet points), then END with exactly one line:',
    'VERDICT: approve',
    'or',
    'VERDICT: rework <short instruction for the worker>',
  ].join('\n')
}

function closeoutPrompt(goal, results) {
  const lines = ['Mission closeout step (continuity mission loop).', 'Goal:', goal, '', 'Results:']
  for (const result of results) {
    lines.push('- ' + result.task.title + ': ' + (result.verdict ? result.verdict.decision : 'unresolved')
      + (result.spawn != null ? ' (worker ' + result.spawn.workerId + ', ' + result.spawn.path + ')' : ''))
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
      startedAt: null, // Date.now() once a mission starts; null while idle
      error: null,
      checkpointSeq: null, // seq of the last closeout checkpoint this generation wrote
      resumedFromSeq: null, // seq of the durable checkpoint a resume rebuilt from
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

  function removeWaiter(sessionId, waiter) {
    const entry = waits.get(sessionId)
    if (entry === undefined) return
    const index = entry.indexOf(waiter)
    if (index === -1) return
    entry.splice(index, 1)
    if (entry.length === 0) waits.delete(sessionId)
  }

  /**
   * Arm a timeout with the timer service when available, otherwise a native
   * setTimeout fallback, otherwise fire immediately — a waiter can never hang
   * forever even when the timer service is missing.
   * Returns a cancel function (no-op for the timer-service path).
   */
  function scheduleTimeout(ms, fn) {
    const timer = get('timer')
    if (timer !== undefined && typeof timer.timeout === 'function') {
      void timer.timeout(ms).then(fn)
      return () => {}
    }
    if (typeof setTimeout === 'function') {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    }
    fn()
    return () => {}
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
      let settled = false
      const waiter = { afterSeq, marker, done: false, cancel: null, settle: null }
      waiter.settle = (value) => {
        if (settled) return
        settled = true
        if (waiter.cancel !== null) waiter.cancel()
        resolve(value)
      }
      const entry = waits.get(sessionId)
      if (entry === undefined) waits.set(sessionId, [waiter])
      else entry.push(waiter)
      waiter.cancel = scheduleTimeout(timeoutMs, () => {
        if (waiter.done) return
        waiter.done = true
        removeWaiter(sessionId, waiter)
        resolve(null)
      })
    })
  }

  function clearWaiters(sessionId) {
    waits.delete(sessionId)
  }

  const sleep = (ms) => {
    const timer = get('timer')
    if (timer !== undefined && typeof timer.timeout === 'function') return timer.timeout(ms)
    if (typeof setTimeout === 'function') return new Promise((resolve) => setTimeout(resolve, ms))
    return Promise.resolve()
  }

  function steer(agent, text) {
    agent.steer(userMessage(text, 'continuity-mission'))
  }

  async function steerAndWait(coordinator, promptText, marker, timeoutMs) {
    const session = coordinator.session
    const events = Array.isArray(session.events) ? session.events : []
    let afterSeq = 0
    if (events.length > 0) {
      const last = events[events.length - 1]
      afterSeq = typeof last.seq === 'number' ? last.seq : events.length
    }
    steer(coordinator, promptText)
    return await waitForAssistant(session.id, afterSeq, marker, timeoutMs)
  }

  /**
   * Incremental worker collection: poll the worker's surface until the latest
   * assistant message is a `## Worker report`, scanning only events newer than
   * the cursor each poll. `afterSeq` lets a rework collect ignore the report it
   * already saw.
   */
  async function collectWorker(workerId, timeoutMs, afterSeq) {
    const sessionQuery = get('sessionQuery')
    const agents = get('agents')
    const deadline = Date.now() + timeoutMs
    let cursor = typeof afterSeq === 'number' ? afterSeq : 0
    let scan = { tail: null, hasCheckpoint: false, lastSeq: null }
    while (Date.now() < deadline) {
      const worker = agents !== undefined ? agents.get(workerId) : undefined
      if (worker === undefined || worker.status === 'idle') {
        try {
          const surface = await sessionQuery.readSurface(workerId)
          const events = Array.isArray(surface.events) ? surface.events : []
          scan = scanWorkerEvents(events, cursor, scan)
          if (typeof surface.capturedThroughSeq === 'number' && surface.capturedThroughSeq > cursor) {
            cursor = surface.capturedThroughSeq
          }
          if (scan.tail !== null && scan.tail.includes('## Worker report')) {
            return { tail: capTextSafe(scan.tail, cfg.reportCapChars), hasCheckpoint: scan.hasCheckpoint, lastSeq: scan.lastSeq }
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

  /**
   * Review one collected outcome (sequentially, one coordinator verdict per
   * model turn) with bounded verdict retries and bounded rework rounds.
   */
  async function reviewOutcome(coordinator, outcome) {
    if (outcome.spawnError !== undefined || outcome.timedOut === true || outcome.taskError !== undefined) {
      return outcome
    }
    const task = outcome.task
    const spawn = outcome.spawn
    let report = outcome.report
    let rounds = 0
    while (true) {
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
      if (verdict === null) {
        return { task, spawn, report, verdict: null, reviewError: 'no parseable verdict', rounds }
      }
      if (verdict.decision === 'rework' && rounds < cfg.workerRounds) {
        rounds += 1
        let delivered = false
        try {
          const worktree = get('continuityWorktree')
          if (worktree !== undefined && typeof worktree.send === 'function') {
            const sent = worktree.send(coordinator, spawn.workerId,
              'Rework requested by the coordinator: ' + verdict.note + '. Address it, then end with "## Worker report" again.')
            delivered = sent !== undefined && sent.kind === 'success'
          }
        } catch {
          delivered = false
        }
        if (!delivered) {
          return { task, spawn, report, verdict, rounds, reworkError: 'worker not live (rework message not delivered)' }
        }
        const nextReport = await collectWorker(spawn.workerId, cfg.workerTimeoutMs, report.lastSeq === null ? 0 : report.lastSeq)
        if (nextReport === null) return { task, spawn, report, verdict, rounds, timedOut: true }
        report = nextReport
        continue
      }
      return { task, spawn, report, verdict, rounds }
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

      // 2. dispatch + collect (concurrent, isolated) → review (sequential)
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
        const collected = await Promise.all(batch.map(async (task) => {
          try {
            const spawn = await worktree.spawnWorker(coordinator, { brief: task.title + ': ' + task.brief })
            if (!spawn.ok) return { task, spawnError: spawn.error, spawn: null, report: null, verdict: null }
            const report = await collectWorker(spawn.workerId, cfg.workerTimeoutMs, 0)
            if (report === null) return { task, spawn, report: null, timedOut: true, verdict: null }
            return { task, spawn, report }
          } catch (taskError) {
            return { task, spawn: null, report: null, verdict: null, taskError: fail(taskError) }
          }
        }))
        for (const outcome of collected) {
          state.results.push(await reviewOutcome(coordinator, outcome))
        }
        index += cfg.maxConcurrent
      }

      // 3. closeout (durable mission checkpoint)
      state.phase = 'closing'
      const closeout = await steerAndWait(coordinator, closeoutPrompt(state.goal, state.results), MISSION_MARKER, cfg.reviewTimeoutMs)
      if (closeout === null) {
        return await escalate(coordinator, state, 'closeout checkpoint not produced in time')
      }
      state.phase = 'done'
      state.checkpointSeq = closeout.seq
      state.error = null
    } catch (runError) {
      state.phase = 'failed'
      state.error = fail(runError)
    }
  }

  /**
   * Explicit resume (P2): rebuild the state machine from the last durable
   * mission checkpoint and re-run the bounded loop from the recovered goal.
   * Never automatic — only reached via an explicit /mission resume (or the
   * reserved `resume` goal token routed through start).
   */
  async function resume(coordinator) {
    const state = getState(coordinator.id)
    if (state.phase === 'planning' || state.phase === 'dispatching' || state.phase === 'closing') {
      return error('A mission is already running (phase ' + state.phase + '); inspect it with /mission status.')
    }
    const checkpoint = findMissionCheckpoint(coordinator.session)
    if (checkpoint === null) {
      return error('No durable mission checkpoint found in this session; nothing to resume. Start one with /mission <goal>.')
    }
    if (state.phase === 'done' && state.checkpointSeq === checkpoint.seq) {
      return success('Mission already converged at checkpoint seq ' + String(checkpoint.seq) + '; nothing to resume.')
    }
    const goal = missionGoalFromCheckpoint(checkpoint.text)
    if (goal === null) {
      return error('The durable mission checkpoint (seq ' + String(checkpoint.seq) + ') has no ## Goal section; cannot reconstruct the mission.')
    }
    clearWaiters(coordinator.id)
    Object.assign(state, freshState())
    state.phase = 'planning'
    state.goal = goal
    state.startedAt = Date.now()
    state.resumedFromSeq = checkpoint.seq
    void runMission(coordinator).catch(() => {})
    return success('Mission resumed from durable checkpoint at seq ' + String(checkpoint.seq) + ' (phase planning): "' + goal + '". Track it with /mission status.')
  }

  async function start(coordinator, goal) {
    const trimmed = (typeof goal === 'string' ? goal : '').trim()
    if (trimmed === '') return error('Usage: /mission <goal> — or /mission resume, or /mission status')
    if (trimmed.toLowerCase() === 'resume') return await resume(coordinator)
    const state = getState(coordinator.id)
    if (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'failed') {
      return error('A mission is already running (phase ' + state.phase + '); inspect it with /mission status.')
    }
    clearWaiters(coordinator.id)
    Object.assign(state, freshState())
    state.phase = 'planning'
    state.goal = trimmed
    state.startedAt = Date.now()
    void runMission(coordinator).catch(() => {})
    return success('Mission started (phase planning): "' + trimmed + '". Track it with /mission status.')
  }

  function status(coordinator) {
    const state = getState(coordinator.id)
    const elapsed = state.startedAt !== null && state.startedAt > 0
      ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) + 's'
      : 'n/a'
    const lines = [
      'Mission of coordinator ' + coordinator.id + ':',
      '- 进度: ' + missionSummary(state, state.startedAt !== null && state.startedAt > 0 ? elapsed : undefined),
      '- phase: ' + state.phase + (state.error !== null && state.error !== undefined ? ' (last error: ' + String(state.error) + ')' : ''),
      '- goal: ' + (state.goal === '' ? '(none)' : state.goal),
      '- tasks: ' + String(state.tasks.length) + (state.startedAt !== null && state.startedAt > 0 ? ', elapsed ' + elapsed : ''),
    ]
    if (state.resumedFromSeq !== null) lines.push('- resumed from durable checkpoint seq ' + String(state.resumedFromSeq))
    const settled = state.results.filter((result) => result.verdict !== null
      || result.timedOut || result.spawnError || result.taskError || result.reviewError).length
    if (state.tasks.length > 0) {
      lines.push('- progress: ' + String(settled) + '/' + String(state.tasks.length) + ' tasks settled'
        + (state.phase === 'dispatching' ? ' (workers running; collecting reports…)' : ''))
    }
    for (const result of state.results) {
      const verdict = result.verdict !== null && result.verdict !== undefined
        ? result.verdict.decision + (result.verdict.note !== '' ? ' (' + result.verdict.note.slice(0, 80) + ')' : '')
        : result.timedOut ? 'timed out'
          : result.spawnError ? 'spawn failed'
            : result.taskError ? 'task failed'
              : result.reviewError ? 'review failed'
                : 'unresolved'
      lines.push('- ' + result.task.title + ' → ' + verdict
        + (result.reworkError !== undefined ? ' [' + result.reworkError + ']' : '')
        + (result.spawn != null ? ' [worker ' + result.spawn.workerId + ', ' + result.spawn.path + ']' : ''))
    }
    if (state.phase === 'idle') lines.push('(no mission yet — start one with /mission <goal>)')
    return success(lines.join('\n'))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') settleWaiters(session.id, event)
  })

  ctx.provide(SERVICE, {
    start,
    resume,
    status,
    get config() { return cfg },
    // Test-only diagnostic (not part of the command surface): exposes the
    // size of the internal waits/states tables so unit tests can assert that
    // timed-out waiters are cleaned up instead of leaking.
    __diagnostics() {
      let waiters = 0
      for (const entry of waits.values()) waiters += entry.length
      return { waiterSessions: waits.size, waiters, states: states.size }
    },
  })
  return undefined
}
