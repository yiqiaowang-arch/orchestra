/**
 * Unit tests for the host-side continuity-mission driver
 * (C:\Users\wangy\.dsh\continuity-host\continuity-mission.v6.mjs).
 * Run with: node continuity-mission-tests.mjs
 */
import { strict as assert } from 'node:assert'
import {
  SERVICE,
  PLAN_MARKER,
  sanitizeMissionConfig,
  parsePlan,
  parseVerdict,
  capTextSafe,
  scanWorkerEvents,
  findMissionCheckpoint,
  missionGoalFromCheckpoint,
  missionSummary,
} from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-mission.v6.mjs'
import continuityMission from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-mission.v6.mjs'
import { MISSION_MARKER } from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-shared.v1.mjs'

let passed = 0
let failed = 0
const pending = []
function test(name, fn) {
  const ok = () => { passed += 1; console.log('ok  - ' + name) }
  const bad = (error) => {
    failed += 1
    console.error('FAIL- ' + name)
    console.error('      ' + ((error && error.message) || String(error)))
  }
  try {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      pending.push(Promise.resolve(result).then(ok, bad))
    } else {
      ok()
    }
  } catch (error) {
    bad(error)
  }
}

function finish() {
  Promise.all(pending).then(() => {
    console.log('')
    console.log('passed: ' + passed + ', failed: ' + failed)
    if (failed > 0) process.exitCode = 1
  })
}

const CFG = sanitizeMissionConfig({})

test('config defaults and clamping', () => {
  assert.equal(CFG.maxTasks, 4)
  assert.equal(CFG.maxConcurrent, 2)
  assert.equal(CFG.workerRounds, 1)
  assert.equal(CFG.planTimeoutMs, 240000)
  const clamped = sanitizeMissionConfig({ maxTasks: 99, maxConcurrent: 0, workerRounds: 9, pollIntervalMs: 1 })
  assert.equal(clamped.maxTasks, 8)
  assert.equal(clamped.maxConcurrent, 1)
  assert.equal(clamped.workerRounds, 3)
  assert.equal(clamped.pollIntervalMs, 1000)
})

test('parsePlan accepts a valid block', () => {
  const text = PLAN_MARKER + '\nTASK|build api|implement the rest api\nTASK|fix tests|repair the failing tests\n'
  const parsed = parsePlan(text, 4)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.tasks, [
    { title: 'build api', brief: 'implement the rest api' },
    { title: 'fix tests', brief: 'repair the failing tests' },
  ])
})

test('parsePlan rejects missing marker, malformed lines, empty and oversized plans', () => {
  assert.match(parsePlan('no marker here\nTASK|a|b', 4).error, /marker missing/)
  assert.match(parsePlan(PLAN_MARKER + '\nTASK|onlytitle', 4).error, /malformed/)
  assert.match(parsePlan(PLAN_MARKER + '\nrandom text', 4).error, /no TASK lines/)
  const many = PLAN_MARKER + '\n' + 'TASK|t|b\n'.repeat(5)
  assert.match(parsePlan(many, 4).error, /too many tasks/)
})

test('parseVerdict reads approve and rework with notes', () => {
  assert.deepEqual(parseVerdict('VERDICT: approve'), { decision: 'approve', note: '' })
  assert.deepEqual(parseVerdict('some text\nVERDICT: REWORK fix the edge case now'), { decision: 'rework', note: 'fix the edge case now' })
  assert.equal(parseVerdict('no verdict here'), null)
  assert.equal(parseVerdict(undefined), null)
})

test('wiring: publishes the service and listens for assistant messages', () => {
  const provided = {}
  const listeners = []
  const ctx = {
    get() { return undefined },
    on(event, listener) { listeners.push([event, listener]) },
    provide(name, value) { provided[name] = value },
  }
  continuityMission(ctx, {})
  assert.equal(typeof provided[SERVICE], 'object')
  assert.equal(typeof provided[SERVICE].start, 'function')
  assert.equal(typeof provided[SERVICE].status, 'function')
  assert.equal(typeof provided[SERVICE].resume, 'function')
  assert.deepEqual(listeners.map(([event]) => event), ['session/event'])
})

test('start: usage errors and running-mission idempotency', async () => {
  const provided = {}
  // A never-resolving fake timer keeps the armed plan waiter pending (mission
  // stays in `planning`) without creating a real setTimeout handle that would
  // keep the node process alive.
  const ctx = {
    get(name) { return name === 'timer' ? { timeout() { return new Promise(() => {}) } } : undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityMission(ctx, {})
  const agent = { id: 'c1', session: { id: 'c1', header: {}, events: [] }, steer() {} }
  const empty = await provided[SERVICE].start(agent, '   ')
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /Usage/)
  const started = await provided[SERVICE].start(agent, 'goal text')
  assert.equal(started.kind, 'success')
  assert.match(started.text, /planning/)
  const second = await provided[SERVICE].start(agent, 'another goal')
  assert.equal(second.kind, 'error')
  assert.match(second.text, /already running/)
  const status = provided[SERVICE].status(agent)
  assert.equal(status.kind, 'success')
  assert.match(status.text, /phase: planning/)
  assert.match(status.text, /goal text/)
})

test('start rejects when the goal is whitespace and reports status when idle', async () => {
  const provided = {}
  const ctx = { get() { return undefined }, on() {}, provide(name, value) { provided[name] = value } }
  continuityMission(ctx, {})
  const agent = { id: 'c2', session: { id: 'c2', header: {}, events: [] }, steer() {} }
  const status = provided[SERVICE].status(agent)
  assert.match(status.text, /phase: idle/)
  assert.match(status.text, /no mission yet/)
  // v5 regression: an idle mission must not print a bogus epoch-scale elapsed.
  assert.doesNotMatch(status.text, /elapsed \d+s/)
})

test('status: elapsed appears only after a mission actually starts (v5)', async () => {
  const provided = {}
  // Fake never-resolving timer: keeps the armed plan waiter pending without a
  // real setTimeout handle that would keep the node process alive.
  const ctx = {
    get(name) { return name === 'timer' ? { timeout() { return new Promise(() => {}) } } : undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityMission(ctx, {})
  const agent = { id: 'c3', session: { id: 'c3', header: {}, events: [] }, steer() {} }
  const idleText = provided[SERVICE].status(agent).text
  assert.doesNotMatch(idleText, /elapsed \d+s/, 'idle must not show elapsed')
  const started = await provided[SERVICE].start(agent, 'rebuild the api')
  assert.equal(started.kind, 'success')
  const runningText = provided[SERVICE].status(agent).text
  assert.match(runningText, /phase: planning/)
  assert.match(runningText, /elapsed \d+s/)
})

test('missionSummary: plain-language progress for every phase', () => {
  const idle = missionSummary({ phase: 'idle', tasks: [], results: [], error: null }, undefined)
  assert.match(idle, /还没有 mission/)
  const planning = missionSummary({ phase: 'planning', tasks: [], results: [], error: null }, '3s')
  assert.match(planning, /正在拆解目标/)
  assert.match(planning, /3s/)
  const dispatching = missionSummary({ phase: 'dispatching', tasks: [{}, {}], results: [{ verdict: { decision: 'approve' } }], error: null }, undefined)
  assert.match(dispatching, /已派 2 个任务/)
  assert.match(dispatching, /1\/2 已定/)
  const closing = missionSummary({ phase: 'closing', tasks: [{}, {}], results: [{ verdict: { decision: 'approve' } }], error: null }, undefined)
  assert.match(closing, /正在写最终 checkpoint/)
  const done = missionSummary({ phase: 'done', tasks: [{}, {}], results: [{ verdict: { decision: 'approve' } }], error: null }, undefined)
  assert.match(done, /全部完成/)
  const failed = missionSummary({ phase: 'failed', tasks: [], results: [], error: 'plan step failed' }, undefined)
  assert.match(failed, /卡住了/)
  assert.match(failed, /plan step failed/)
})

// ── new P0/P2 coverage ────────────────────────────────────────────────────────

test('capTextSafe: leaves short text intact and never splits surrogate pairs', () => {
  assert.equal(capTextSafe('short', 100), 'short')
  assert.equal(capTextSafe(undefined, 100), '')
  const truncated = capTextSafe('a😀bcd', 4)
  assert.match(truncated, /omitted \d+ chars/)
  // no lone surrogate may appear anywhere in the output
  for (let i = 0; i < truncated.length; i += 1) {
    const code = truncated.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      assert.notEqual(truncated.charCodeAt(i + 1) & 0xfc00, 0xdc00, 'high surrogate must be followed by low surrogate')
    }
  }
})

test('scanWorkerEvents: incremental cursor only folds events past afterSeq', () => {
  const events = [
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'first' }] } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '## Worker report\nsecond' }] } } },
  ]
  const first = scanWorkerEvents(events, 0, { tail: null, hasCheckpoint: false, lastSeq: null })
  assert.match(first.tail, /## Worker report/)
  assert.equal(first.lastSeq, 2)
  // rescanning with the same cursor yields no change (incremental, not full rescan)
  const again = scanWorkerEvents(events, 2, first)
  assert.equal(again.tail, first.tail)
  assert.equal(again.lastSeq, 2)
})

test('findMissionCheckpoint + missionGoalFromCheckpoint recover the goal', () => {
  const ckText = MISSION_MARKER + '\n# Mission checkpoint\n\n## Goal\nbuild the thing\n\n## Workspaces\nnone\n\n## Next actions\nnone\n'
  const session = { events: [{ type: 'assistant/message', seq: 7, data: { message: { content: [{ type: 'text', text: ckText }] } } }] }
  const found = findMissionCheckpoint(session)
  assert.equal(found.seq, 7)
  assert.equal(missionGoalFromCheckpoint(found.text), 'build the thing')
  assert.equal(findMissionCheckpoint({ events: [] }), null)
  assert.equal(missionGoalFromCheckpoint('no marker'), null)
})

// ── integration harness ──────────────────────────────────────────────────────

function makeFakeTimer() {
  const pending = []
  return {
    pending,
    timeout(ms) { return new Promise((resolve) => pending.push({ ms, resolve })) },
    fireNext() { const p = pending.shift(); if (p) p.resolve() },
    fireAll() { for (const p of pending.splice(0)) p.resolve() },
  }
}

function makeHarness(config = {}) {
  const timer = makeFakeTimer()
  const provided = {}
  const listeners = {}
  const surfaces = new Map()
  const liveAgents = new Map()
  const spawned = []
  const steers = []
  let seq = 0

  const agent = {
    id: 'c1',
    session: { id: 'c1', header: { cwd: 'C:/tmp/coordinator' }, events: [] },
    steer(message) { steers.push(message) },
  }

  const sessionQuery = {
    async readSurface(id) {
      const surface = surfaces.get(id)
      if (surface === undefined) throw new Error('no surface for ' + id)
      return surface
    },
  }
  const agents = {
    get(id) { return liveAgents.get(id) },
  }
  const worktree = {
    async spawnWorker(coordinator, spec) {
      const workerId = 'w' + spawned.length
      spawned.push({ workerId, spec })
      return { ok: true, workerId, path: 'C:/tmp/wt-' + workerId }
    },
    send(coordinator, workerId, text) { return { kind: 'success', text } },
  }

  const ctx = {
    get(name) {
      if (name === 'timer') return timer
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'agents') return agents
      if (name === 'continuityWorktree') return worktree
      return undefined
    },
    on(event, listener) { listeners[event] = listener },
    provide(name, value) { provided[name] = value },
  }

  continuityMission(ctx, config)
  const service = provided[SERVICE]

  function assistantEvent(workerId, eventSeq, text) {
    return { type: 'assistant/message', seq: eventSeq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
  }

  function setSurface(workerId, events) {
    surfaces.set(workerId, {
      session: { cwd: 'C:/tmp/wt-' + workerId },
      capturedThroughSeq: events.length > 0 ? events[events.length - 1].seq : null,
      events,
    })
  }

  function respond(text) {
    seq += 1
    const event = assistantEvent('c1', seq, text)
    agent.session.events.push(event)
    const listener = listeners['session/event']
    if (listener) listener(agent.session, event)
  }

  // Route a steered prompt to the appropriate assistant response, queued on the
  // next macrotask so the waiter is registered before the response lands.
  function autoRespond(overrides = {}) {
    agent.steer = (message) => {
      steers.push(message)
      const text = Array.isArray(message.content) ? String(message.content[0].text) : ''
      setImmediate(() => respond(route(text, overrides)))
    }
  }

  function route(text, overrides) {
    if (text.includes(PLAN_MARKER) || text.includes('corrected plan block')) {
      return PLAN_MARKER + '\nTASK|alpha|do alpha\nTASK|beta|do beta\n'
    }
    if (text.includes('VERDICT:')) {
      return 'VERDICT: ' + (overrides.verdict || 'approve') + '\n'
    }
    if (text.includes('Mission closeout')) {
      return MISSION_MARKER + '\n# Mission checkpoint\n\n## Goal\nbuild the thing\n\n## Workspaces\nnone\n\n## Progress\ndone\n\n## Decisions\nnone\n\n## Open problems\nnone\n\n## Next actions\nnone\n'
    }
    return ''
  }

  return { timer, service, agent, listeners, surfaces, liveAgents, spawned, steers, setSurface, respond, autoRespond, assistantEvent, sessionQuery, agents, worktree }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function waitForPhase(harness, phase, timeoutMs = 3000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      const status = harness.service.status(harness.agent)
      if (status.text.includes('phase: ' + phase)) return resolve(status.text)
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for phase ' + phase + '; got: ' + status.text))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test('timeout path: plan step times out and the mission escalates (no hang)', async () => {
  const h = makeHarness({ planTimeoutMs: 10000, reviewTimeoutMs: 10000 })
  await h.service.start(h.agent, 'build something')
  // arm + fire the two plan attempts
  h.timer.fireNext(); await flush()
  h.timer.fireNext(); await flush()
  const status = h.service.status(h.agent)
  assert.match(status.text, /phase: failed/)
  assert.match(status.text, /plan step failed/)
  // the waiter table was cleaned up — no dangling waiters remain
  assert.equal(h.service.__diagnostics().waiters, 0)
  assert.equal(h.service.__diagnostics().waiterSessions, 0)
})

test('waits cleanup: timed-out waiter is removed and cannot leak across missions', async () => {
  const h = makeHarness({ planTimeoutMs: 10000, reviewTimeoutMs: 10000 })
  await h.service.start(h.agent, 'first mission')
  h.timer.fireNext(); await flush()
  h.timer.fireNext(); await flush()
  assert.match(h.service.status(h.agent).text, /phase: failed/)
  assert.equal(h.service.__diagnostics().waiters, 0)
  // a fresh mission arms fresh waiters, independent of the cleaned-up ones
  await h.service.start(h.agent, 'second mission')
  assert.equal(h.service.__diagnostics().waiterSessions, 1)
  h.timer.fireNext(); await flush()
  h.timer.fireNext(); await flush()
  assert.match(h.service.status(h.agent).text, /phase: failed/)
  assert.equal(h.service.__diagnostics().waiters, 0)
})

test('worker non-live recovery: durable report is collected even when the worker is not live', async () => {
  const h = makeHarness({ workerTimeoutMs: 10000, pollIntervalMs: 1000 })
  // two durable reports exist for the two workers the fake worktree will spawn,
  // but neither worker is registered in `agents` (non-live).
  h.setSurface('w0', [h.assistantEvent('w0', 1, '## Worker report\n\nalpha done.')])
  h.setSurface('w1', [h.assistantEvent('w1', 1, '## Worker report\n\nbeta done.')])
  h.autoRespond()
  await h.service.start(h.agent, 'build the thing')
  const status = await waitForPhase(h, 'done')
  assert.match(status, /phase: done/)
  assert.equal(h.spawned.length, 2)
  // both tasks approved and the workers were never live
  assert.equal(h.liveAgents.size, 0)
  assert.match(status, /alpha → approve/)
  assert.match(status, /beta → approve/)
})

test('worker non-live recovery: rework to a non-live worker records reworkError instead of hanging', async () => {
  const h = makeHarness({ workerTimeoutMs: 10000, pollIntervalMs: 1000, workerRounds: 1 })
  h.setSurface('w0', [h.assistantEvent('w0', 1, '## Worker report\n\nhalf done.')])
  h.setSurface('w1', [h.assistantEvent('w1', 1, '## Worker report\n\nbeta done.')])
  h.autoRespond({ verdict: 'rework fix the rest' })
  // worker is not live, so the rework message cannot be delivered
  h.worktree.send = () => ({ kind: 'error', text: 'Worker w0 is not live' })
  await h.service.start(h.agent, 'build the thing')
  const status = await waitForPhase(h, 'done')
  assert.match(status, /phase: done/)
  assert.match(status, /worker not live \(rework message not delivered\)/)
})

test('concurrent batch isolation: one task throwing does not abort sibling tasks', async () => {
  const h = makeHarness({ workerTimeoutMs: 10000, pollIntervalMs: 1000 })
  h.setSurface('w0', [h.assistantEvent('w0', 1, '## Worker report\n\nalpha done.')])
  h.setSurface('w1', [h.assistantEvent('w1', 1, '## Worker report\n\nbeta done.')])
  // the alpha spawn throws; beta still completes and is reviewed
  const original = h.worktree.spawnWorker
  h.worktree.spawnWorker = async (coordinator, spec) => {
    if (spec.brief.includes('alpha')) throw new Error('spawn exploded for alpha')
    return original(coordinator, spec)
  }
  h.autoRespond()
  await h.service.start(h.agent, 'build the thing')
  const status = await waitForPhase(h, 'done')
  assert.match(status, /phase: done/)
  assert.match(status, /alpha → task failed/)
  assert.match(status, /beta → approve/)
})

test('resume: no checkpoint, running mission, and already-converged idempotency', async () => {
  const h = makeHarness({ planTimeoutMs: 10000, reviewTimeoutMs: 10000 })
  // no checkpoint yet
  const none = await h.service.resume(h.agent)
  assert.equal(none.kind, 'error')
  assert.match(none.text, /No durable mission checkpoint/)
  // start routes the reserved token `resume` to the same resume path
  const viaStart = await h.service.start(h.agent, 'resume')
  assert.equal(viaStart.kind, 'error')
  assert.match(viaStart.text, /No durable mission checkpoint/)
})

test('resume: while a mission is running it is rejected', async () => {
  const h = makeHarness({ planTimeoutMs: 10000, reviewTimeoutMs: 10000 })
  await h.service.start(h.agent, 'in flight')
  const blocked = await h.service.resume(h.agent)
  assert.equal(blocked.kind, 'error')
  assert.match(blocked.text, /already running/)
})

test('resume: rebuilds the state machine from the durable checkpoint (restart replay)', async () => {
  // durable log from a prior generation: a mission checkpoint assistant event
  const ckText = MISSION_MARKER + '\n# Mission checkpoint\n\n## Goal\nrebuild the api\n\n## Workspaces\nnone\n\n## Progress\npartial\n\n## Decisions\nnone\n\n## Open problems\nnone\n\n## Next actions\nfinish it\n'
  const h = makeHarness({ planTimeoutMs: 10000, reviewTimeoutMs: 10000 })
  h.agent.session.events = [{ type: 'assistant/message', seq: 2101, data: { message: { content: [{ type: 'text', text: ckText }] } } }]
  h.autoRespond()
  const resumed = await h.service.resume(h.agent)
  assert.equal(resumed.kind, 'success')
  assert.match(resumed.text, /resumed from durable checkpoint at seq 2101/)
  assert.match(resumed.text, /rebuild the api/)
  const status = h.service.status(h.agent)
  assert.match(status.text, /phase: planning/)
  assert.match(status.text, /goal: rebuild the api/)
  assert.match(status.text, /resumed from durable checkpoint seq 2101/)
})

test('resume: after a converged mission the resume is a no-op (idempotent)', async () => {
  const h = makeHarness({ workerTimeoutMs: 10000, pollIntervalMs: 1000 })
  h.setSurface('w0', [h.assistantEvent('w0', 1, '## Worker report\n\nalpha done.')])
  h.setSurface('w1', [h.assistantEvent('w1', 1, '## Worker report\n\nbeta done.')])
  h.autoRespond()
  await h.service.start(h.agent, 'build the thing')
  await waitForPhase(h, 'done')
  const again = await h.service.resume(h.agent)
  assert.equal(again.kind, 'success')
  assert.match(again.text, /already converged/)
  // still done, not re-run
  assert.match(h.service.status(h.agent).text, /phase: done/)
})

finish()
