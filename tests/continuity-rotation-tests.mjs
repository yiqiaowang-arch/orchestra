/**
 * Unit tests for the host-side continuity-rotation driver
 * (C:\Users\wangy\.dsh\continuity-host\continuity-rotation.v7.mjs).
 * Run with: node continuity-rotation-tests.mjs
 */
import { strict as assert } from 'node:assert'
import {
  SERVICE,
  sanitizeRotationConfig,
  decide,
  freshRotationCache,
  foldRotationEvent,
  foldRotationIncremental,
} from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-rotation.v7.mjs'
import continuityRotation from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-rotation.v7.mjs'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok  - ' + name)
  } catch (error) {
    failed += 1
    console.error('FAIL- ' + name)
    console.error('      ' + ((error && error.message) || String(error)))
  }
}

const CFG = sanitizeRotationConfig({})

test('config defaults and clamping', () => {
  assert.equal(CFG.rotateRatio, 0.78)
  assert.equal(CFG.autoRollover, 'suggest')
  assert.equal(CFG.maxWaitMs, 300000)
  assert.equal(CFG.cooldownMs, 300000)
  assert.equal(CFG.oldSession, 'keep')
  const auto = sanitizeRotationConfig({ autoRollover: 'auto', rotateRatio: 0.6, maxWaitMs: 999, cooldownMs: -5, oldSession: 'archive' })
  assert.equal(auto.autoRollover, 'auto')
  assert.equal(auto.rotateRatio, 0.6)
  assert.equal(auto.maxWaitMs, 1000)
  assert.equal(auto.cooldownMs, 0)
  assert.equal(auto.oldSession, 'archive')
  const bad = sanitizeRotationConfig({ autoRollover: 'nonsense', rotateRatio: 9 })
  assert.equal(bad.autoRollover, 'suggest')
  assert.equal(bad.rotateRatio, 0.78)
})

test('decide: below threshold and unknown capacity never act', () => {
  const facts = { ratio: 0.5, capacityKnown: true, rotating: false, cooldownElapsed: true, hasHistory: true, mode: 'auto' }
  assert.equal(decide(CFG, facts), 'none')
  const unknown = { ratio: null, capacityKnown: false, rotating: false, cooldownElapsed: true, hasHistory: true, mode: 'auto' }
  assert.equal(decide(CFG, unknown), 'none')
})

test('decide: suggest mode suggests at threshold but never auto-executes', () => {
  const facts = { ratio: 0.9, capacityKnown: true, rotating: false, cooldownElapsed: true, hasHistory: true, mode: 'suggest' }
  assert.equal(decide(CFG, facts), 'suggest')
})

test('decide: off mode only suggests (explicit /rotate is the confirmation)', () => {
  const facts = { ratio: 0.9, capacityKnown: true, rotating: false, cooldownElapsed: true, hasHistory: true, mode: 'off' }
  assert.equal(decide(CFG, facts), 'suggest')
})

test('decide: auto mode guards cooldown and history, and busy wins', () => {
  const ready = { ratio: 0.9, capacityKnown: true, rotating: false, cooldownElapsed: true, hasHistory: true, mode: 'auto' }
  assert.equal(decide(CFG, ready), 'auto')
  const cooling = { ratio: 0.9, capacityKnown: true, rotating: false, cooldownElapsed: false, hasHistory: true, mode: 'auto' }
  assert.equal(decide(CFG, cooling), 'suggest')
  const noHistory = { ratio: 0.9, capacityKnown: true, rotating: false, cooldownElapsed: true, hasHistory: false, mode: 'auto' }
  assert.equal(decide(CFG, noHistory), 'suggest')
  const busy = { ratio: 0.9, capacityKnown: true, rotating: true, cooldownElapsed: true, hasHistory: true, mode: 'auto' }
  assert.equal(decide(CFG, busy), 'busy')
})

test('rotate: chain guard rejects rollover continuations without touching services', async () => {
  const provided = {}
  const ctx = {
    get() { return undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, {})
  const agent = {
    id: 's-child',
    session: {
      id: 's-child',
      header: { parentSession: 's-parent' },
      events: [],
    },
  }
  const result = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /itself a rollover continuation/)
})

test('wiring: publishes the service, registers listeners, tolerates absent optional services', () => {
  const provided = {}
  const listeners = []
  const agents = { create: async () => { throw new Error('not called') } }
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) },
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, {})
  assert.equal(typeof provided[SERVICE], 'object')
  assert.equal(typeof provided[SERVICE].rotate, 'function')
  assert.equal(typeof provided[SERVICE].suggest, 'function')
  const events = listeners.map(([event]) => event).sort()
  assert.deepEqual(events, ['agent/status', 'agent/turn-stopping', 'session/event'])
})

test('suggest: reports no action when the preset guard or capacity is absent', () => {
  const provided = {}
  const ctx = {
    get() { return undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, {})
  const view = provided[SERVICE].suggest({
    id: 's1',
    session: { id: 's1', header: {}, events: [] },
    ctx: {},
  })
  assert.equal(view.recommendation, 'none')
  assert.equal(view.ratio, null)
  assert.equal(view.threshold, 0.78)
})

// ── incremental rotation cache ───────────────────────────────────────────────
const MARKER = '<!-- DSH_CONTINUITY_CHECKPOINT v1 -->'

function validCheckpoint() {
  return [
    MARKER,
    '# Continuity checkpoint',
    '## Current objective', 'Ship it.',
    '## Workspace/repository state', 'cwd C:\\wt.',
    '## Completed', 'Done.',
    '## Decisions and invariants', 'None.',
    '## Files changed', 'a.txt.',
    '## Verification', 'node test.',
    '## Open problems', 'None.',
    '## Next atomic action', 'Run `npm test`.',
  ].join('\n')
}

function assistantEvent(seq, text) {
  return { type: 'assistant/message', seq, data: { message: { id: 'm' + seq, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } } }
}

function userEvent(seq) {
  return { type: 'user/message', seq, data: { message: { role: 'user', content: [{ type: 'text', text: 'u' }] } } }
}

function contextEvent(seq, window) {
  return { type: 'request/context', seq, data: { contextWindow: window } }
}

function headerEvent(seq, config) {
  return { type: 'request/header', seq, data: { header: { config } } }
}

test('rotation cache matches full-fold semantics for all derived facts', () => {
  const events = [
    assistantEvent(1, 'work'),
    userEvent(2),
    contextEvent(3, 20000),
    assistantEvent(4, validCheckpoint()),
    contextEvent(5, 0),
    assistantEvent(6, MARKER + '\n## Completed\npartial'),
  ]
  const baseline = freshRotationCache()
  for (const event of events) foldRotationEvent(baseline, event)
  const incremental = freshRotationCache()
  for (const event of events) foldRotationIncremental(incremental, [event])
  assert.equal(incremental.assistantCount, 3)
  assert.equal(incremental.lastUserSeq, 2)
  assert.equal(incremental.lastContextWindow, null)
  assert.equal(incremental.lastMarkerCheckpoint.seq, 6)
  assert.equal(incremental.lastMarkerCheckpoint.valid, false)
  assert.deepEqual(incremental, baseline)
})

test('rotation cache cursor does not double-count on re-offered events', () => {
  const cache = freshRotationCache()
  foldRotationIncremental(cache, [assistantEvent(1, 'a'), assistantEvent(2, 'b')])
  assert.equal(cache.assistantCount, 2)
  foldRotationIncremental(cache, [assistantEvent(1, 'a'), assistantEvent(2, 'b'), assistantEvent(3, 'c')])
  assert.equal(cache.assistantCount, 3)
  assert.equal(cache.lastScanSeq, 3)
})

test('suggest: flags worker + successor at threshold (never auto for workers)', () => {
  const provided = {}
  const ctx = {
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 9000 }) }
      return undefined
    },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, { autoRollover: 'auto' })
  const view = provided[SERVICE].suggest({
    id: 'w1',
    session: {
      id: 'w1',
      header: { parentSession: 'coord-1', cwd: 'C:\\wt' },
      events: [contextEvent(1, 10000), assistantEvent(2, 'work')],
    },
    ctx: {},
  })
  assert.equal(view.worker, true)
  assert.equal(view.successor, true)
  assert.equal(view.recommendation, 'suggest') // downgraded from auto
})

// ── rotate: idempotent restart, timeout, abort ───────────────────────────────
function rotateCtx(overrides) {
  const created = []
  const agents = {
    create: async (spec) => {
      created.push(spec.sessionId)
      return { agent: { session: { append() {} }, inject() {}, followup() {} } }
    },
  }
  const provided = {}
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      if (overrides !== undefined && overrides[name] !== undefined) return overrides[name]
      return undefined
    },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  return { ctx, provided, created }
}

function rootSession() {
  return {
    id: 'root-1',
    header: { cwd: 'C:\\work\\repo' },
    events: [
      headerEvent(1, { provider: 'p', model: 'm' }),
      userEvent(2),
      assistantEvent(3, validCheckpoint()),
    ],
  }
}

test('rotate: repeated /rotate with no new work is idempotent (no duplicate session)', async () => {
  const { ctx, provided, created } = rotateCtx()
  continuityRotation(ctx, {})
  const agent = { id: 'root-1', session: rootSession(), ctx: {} }
  const first = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(first.kind, 'success', first.text)
  assert.equal(created.length, 1)
  const second = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(second.kind, 'success', second.text)
  assert.match(second.text, /idempotent/)
  assert.equal(created.length, 1) // no second continuation session
})

test('rotate: successor is attached to the source workspace (v7)', async () => {
  const attached = []
  const workspaceRegistry = {
    resolveByPath: async (path) => ({ path, attachSession: async (sid) => { attached.push(sid) } }),
  }
  const { ctx, provided, created } = rotateCtx({ workspaceRegistry })
  continuityRotation(ctx, {})
  const agent = { id: 'root-1', session: rootSession(), ctx: {} }
  const result = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(created.length, 1)
  assert.equal(attached.length, 1)
  assert.equal(attached[0], created[0], 'the successor session is attached to the workspace')
})

test('rotate: timeout path aborts cleanly and leaves the old session unchanged', async () => {
  const timer = { timeout: () => Promise.resolve() }
  const commands = { execute: async () => {} }
  const { ctx, provided, created } = rotateCtx({ timer, commands })
  continuityRotation(ctx, {})
  const session = rootSession()
  session.events = [headerEvent(1, { provider: 'p', model: 'm' })] // no checkpoint
  const agent = { id: 'root-1', session, ctx: {} }
  const result = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /did not become durable in time/)
  assert.equal(created.length, 0)
})

test('rotate: already-aborted signal aborts before creating a session', async () => {
  const commands = { execute: async () => {} }
  const { ctx, provided, created } = rotateCtx({ commands })
  continuityRotation(ctx, {})
  const session = rootSession()
  session.events = [headerEvent(1, { provider: 'p', model: 'm' })] // no checkpoint
  const agent = { id: 'root-1', session, ctx: {} }
  const controller = new AbortController()
  controller.abort()
  const result = await provided[SERVICE].rotate(agent, controller.signal)
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /did not become durable in time \(aborted\)/)
  assert.equal(created.length, 0)
})

test('rotate: an invalid checkpoint attempt does NOT abort; a valid one settles (v6)', async () => {
  const listeners = []
  const created = []
  const agents = {
    create: async (spec) => {
      created.push(spec.sessionId)
      return { agent: { session: { append() {} }, inject() {}, followup() {} } }
    },
  }
  const commands = { execute: async () => {} }
  const timer = { timeout: () => new Promise(() => {}) } // never resolves: waiter stays pending until a valid checkpoint
  const provided = {}
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      if (name === 'commands') return commands
      if (name === 'timer') return timer
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) },
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, {})
  const session = { id: 'root-1', header: { cwd: 'C:\\work\\repo' }, events: [headerEvent(1, { provider: 'p', model: 'm' })] }
  const agent = { id: 'root-1', session, ctx: {} }
  const pending = provided[SERVICE].rotate(agent, undefined)
  const onEvent = listeners.find(([e]) => e === 'session/event')[1]
  // 1. an invalid marker-bearing attempt must NOT settle the waiter
  onEvent(session, {
    type: 'assistant/message', seq: 100,
    data: { message: { content: [{ type: 'text', text: '<!-- DSH_CONTINUITY_CHECKPOINT v1 -->\n# broken\nmissing sections' }] } },
  })
  let settled = false
  pending.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 15))
  assert.equal(settled, false, 'invalid checkpoint attempt must not abort the rollover')
  // 2. a valid checkpoint settles it and the successor is created
  onEvent(session, {
    type: 'assistant/message', seq: 101,
    data: { message: { content: [{ type: 'text', text: validCheckpoint() }] } },
  })
  const result = await pending
  assert.equal(result.kind, 'success', result.text)
  assert.equal(created.length, 1)
})

test('rotate: partial success (new session created, wake failed) is reported honestly', async () => {
  const created = []
  const agents = {
    create: async (spec) => {
      created.push(spec.sessionId)
      return {
        agent: {
          session: { append() { throw new Error('append blew up') } },
          inject() {},
          followup() {},
        },
      }
    },
  }
  const provided = {}
  const ctx = {
    get(name) { return name === 'agents' ? agents : undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityRotation(ctx, {})
  const agent = { id: 'root-1', session: rootSession(), ctx: {} }
  const result = await provided[SERVICE].rotate(agent, undefined)
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /partially completed/)
  assert.equal(created.length, 1)
})

// ── rotateSuccessor (P2) ─────────────────────────────────────────────────────
function successorCtx(overrides) {
  const created = []
  const agents = {
    create: async (spec) => {
      created.push(spec)
      return { agent: { session: { append() {} }, inject() {}, followup() {} } }
    },
  }
  const provided = {}
  const ctx = {
    get(name) {
      if (name === 'agents') return agents
      if (overrides !== undefined && overrides[name] !== undefined) return overrides[name]
      return undefined
    },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  return { ctx, provided, created }
}

function workerLog() {
  return {
    session: { id: 'worker-1', cwd: 'C:\\wt', parentSession: 'coord-1', delegationDepth: 1, createdAt: 1 },
    events: [
      headerEvent(1, { provider: 'p', model: 'm' }),
      assistantEvent(2, validCheckpoint()),
    ],
  }
}

const coordinator = { id: 'coord-1', session: { id: 'coord-1', header: {}, events: [] } }

test('rotateSuccessor: rejects a non-worker session', async () => {
  const sessionQuery = {
    async readSession() {
      return { session: { id: 'root-1', cwd: 'C:\\wt', createdAt: 1 }, events: [] }
    },
  }
  const { ctx, provided } = successorCtx({ sessionQuery })
  continuityRotation(ctx, {})
  const result = await provided[SERVICE].rotateSuccessor(coordinator, 'root-1', '', undefined)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not a worker/)
})

test('rotateSuccessor: requires a durable valid checkpoint', async () => {
  const sessionQuery = {
    async readSession() {
      return {
        session: { id: 'worker-1', cwd: 'C:\\wt', parentSession: 'coord-1', createdAt: 1 },
        events: [headerEvent(1, { provider: 'p', model: 'm' })],
      }
    },
  }
  const { ctx, provided } = successorCtx({ sessionQuery })
  continuityRotation(ctx, {})
  const result = await provided[SERVICE].rotateSuccessor(coordinator, 'worker-1', '', undefined)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no durable valid checkpoint/)
})

test('rotateSuccessor: spawns a successor inheriting the worker checkpoint and is idempotent', async () => {
  const sessionQuery = { async readSession() { return workerLog() } }
  const { ctx, provided, created } = successorCtx({ sessionQuery })
  continuityRotation(ctx, {})
  const result = await provided[SERVICE].rotateSuccessor(coordinator, 'worker-1', 'finish the rest', undefined)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(created.length, 1)
  assert.equal(created[0].meta.parentSession, 'coord-1')
  assert.equal(created[0].meta.cwd, 'C:\\wt')
  assert.equal(created[0].meta.delegationDepth, 1)
  assert.equal(created[0].meta.successorOf, 'worker-1')
  const second = await provided[SERVICE].rotateSuccessor(coordinator, 'worker-1', 'again', undefined)
  assert.equal(second.kind, 'error')
  assert.match(second.text, /idempotent/)
  assert.equal(created.length, 1)
})

console.log('')
console.log('passed: ' + passed + ', failed: ' + failed)
if (failed > 0) process.exitCode = 1
