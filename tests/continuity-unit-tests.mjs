/**
 * Focused unit tests for the continuity preset companion plugin
 * (C:\Users\wangy\.dsh\.agent-presets\continuity\continuity-plugin.v5.mjs).
 *
 * Run with: node continuity-unit-tests.mjs
 * Exit code 0 = all tests passed.
 */
import { strict as assert } from 'node:assert'
import {
  MARKER,
  REQUIRED_SECTIONS,
  sanitizeConfig,
  freshState,
  validateCheckpoint,
  capText,
  computeStatus,
  resolveTarget,
  transition,
  textOfMessage,
  userMessage,
  findLastCheckpoint,
  lastUserSeq,
  latestAttempt,
  classifyAttempt,
  freshCache,
  foldEvent,
  foldIncremental,
} from 'file:///C:/Users/wangy/.dsh/.agent-presets/continuity/continuity-plugin.v5.mjs'
import continuityPlugin from 'file:///C:/Users/wangy/.dsh/.agent-presets/continuity/continuity-plugin.v5.mjs'

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

const CFG = sanitizeConfig({})

function validCheckpoint() {
  return [
    MARKER,
    '# Continuity checkpoint',
    '## Current objective',
    'Ship feature A; non-goals: refactor B, touch config C.',
    '## Workspace/repository state',
    'cwd C:\\work\\repo; git status clean; branch main; HEAD 0abc123. (Git facts recorded — repository present.)',
    '## Completed',
    'Feature A implemented and tested.',
    '## Decisions and invariants',
    'Pattern P accepted; alternative Q rejected.',
    '## Files changed',
    'src/a.ts — feature A implementation.',
    '## Verification',
    'npm test — all green (actually run).',
    '## Open problems',
    'None known.',
    '## Next atomic action',
    'Run `npm run build` and fix any errors.',
  ].join('\n')
}

function sessionWith(events) {
  return { id: 'session-a', events, header: { cwd: 'C:\\work\\repo' } }
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    data: { message: { id: 'm' + seq, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } },
  }
}

function toolCallEvent(seq) {
  return {
    type: 'assistant/message',
    seq,
    data: { message: { id: 'm' + seq, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool_use', name: 'pwsh', input: {} }] } },
  }
}

// ── checkpoint validation ────────────────────────────────────────────────────
test('valid checkpoint passes', () => {
  const verdict = validateCheckpoint(validCheckpoint())
  assert.deepEqual(verdict, { ok: true, missing: [] })
})

test('checkpoint without marker fails', () => {
  const verdict = validateCheckpoint(validCheckpoint().replace(MARKER, '<!-- other -->'))
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /marker missing/)
})

test('checkpoint missing one section fails and names it', () => {
  const broken = validCheckpoint().replace('## Verification\n', '')
  const verdict = validateCheckpoint(broken)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.missing, ['Verification'])
  assert.match(verdict.reason, /Verification/)
})

test('checkpoint with empty next atomic action fails', () => {
  const broken = validCheckpoint().replace("Run `npm run build` and fix any errors.", '')
  const verdict = validateCheckpoint(broken)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /Next atomic action/)
})

test('all eight required sections are present in the steer contract', () => {
  assert.equal(REQUIRED_SECTIONS.length, 8)
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(validCheckpoint().includes('## ' + section), 'section ' + section)
  }
})

// ── pressure thresholds and unknown capacity ─────────────────────────────────
test('unknown capacity reports unknown ratio and honest recommendation', () => {
  const status = computeStatus(12000, null, 0, null, CFG)
  assert.equal(status.capacity, null)
  assert.equal(status.ratio, null)
  assert.match(status.recommendation, /unknown/)
})

test('ratio bands: low / warning / checkpoint / rotate', () => {
  assert.match(computeStatus(1000, 10000, 0, null, CFG).recommendation, /low/)
  assert.match(computeStatus(6100, 10000, 0, null, CFG).recommendation, /warning band/)
  assert.match(computeStatus(7100, 10000, 0, null, CFG).recommendation, /checkpoint band/)
  assert.match(computeStatus(7900, 10000, 0, null, CFG).recommendation, /rotate band/)
  assert.equal(computeStatus(7000, 10000, 0, null, CFG).ratio, 0.7)
})

// ── state machine: handoff scheduling, idempotency, boundaries ───────────────
test('handoff schedules pending; duplicate handoff is idempotent', () => {
  const s1 = transition(freshState(), { type: 'handoff' }, CFG)
  assert.equal(s1.mode, 'pending')
  assert.equal(s1.action, null)
  const s2 = transition(s1, { type: 'handoff' }, CFG)
  assert.equal(s2.mode, 'pending')
  assert.equal(s2.action, null)
})

test('safe boundary steers exactly once; no duplicate steering loop', () => {
  let state = transition(freshState(), { type: 'handoff' }, CFG)
  state = transition(state, { type: 'boundary', seq: 10, latest: null }, CFG)
  assert.equal(state.mode, 'checkpointing')
  assert.equal(state.action, 'steer-initial')
  // another boundary before any assistant message arrives: no re-steer
  state = transition(state, { type: 'boundary', seq: 11, latest: null }, CFG)
  assert.equal(state.action, null)
  assert.equal(state.mode, 'checkpointing')
})

test('durable valid checkpoint arrives post-commit: ready', () => {
  let state = transition(transition(freshState(), { type: 'handoff' }, CFG), { type: 'boundary', seq: 10, latest: null }, CFG)
  state = transition(state, { type: 'message', seq: 12, valid: true }, CFG)
  assert.equal(state.mode, 'ready')
  assert.equal(state.checkpointSeq, 12)
  // boundary after ready: nothing
  state = transition(state, { type: 'boundary', seq: 13, latest: null }, CFG)
  assert.equal(state.mode, 'ready')
  assert.equal(state.action, null)
})

test('bounded retry: one retry then failed; never a third steer', () => {
  let state = transition(transition(freshState(), { type: 'handoff' }, CFG), { type: 'boundary', seq: 10, latest: null }, CFG)
  const invalidAttempt = { seq: 12, valid: false, isAttempt: true, reason: 'missing sections' }
  state = transition(state, { type: 'boundary', seq: 13, latest: invalidAttempt }, CFG)
  assert.equal(state.action, 'steer-retry')
  assert.equal(state.retriesLeft, 0)
  state = transition(state, { type: 'boundary', seq: 15, latest: { seq: 14, valid: false, isAttempt: true, reason: 'marker missing' } }, CFG)
  assert.equal(state.mode, 'failed')
  assert.equal(state.action, null)
  assert.match(state.invalidReason, /marker missing/)
})

test('tool-call-only assistant messages are intermediate work, not attempts', () => {
  let state = transition(transition(freshState(), { type: 'handoff' }, CFG), { type: 'boundary', seq: 10, latest: null }, CFG)
  const toolWork = { seq: 12, valid: false, isAttempt: false, reason: null }
  state = transition(state, { type: 'boundary', seq: 13, latest: toolWork }, CFG)
  assert.equal(state.mode, 'checkpointing')
  assert.equal(state.retriesLeft, CFG.maxCheckpointRetries)
  assert.equal(state.action, null)
})

test('failed handoff can be re-requested (fresh retries)', () => {
  let state = transition(freshState(), { type: 'handoff' }, CFG)
  state = transition(state, { type: 'boundary', seq: 10, latest: null }, CFG)
  state = transition(state, { type: 'boundary', seq: 13, latest: { seq: 12, valid: false, isAttempt: true, reason: 'x' } }, CFG)
  state = transition(state, { type: 'boundary', seq: 15, latest: { seq: 14, valid: false, isAttempt: true, reason: 'y' } }, CFG)
  assert.equal(state.mode, 'failed')
  state = transition(state, { type: 'handoff' }, CFG)
  assert.equal(state.mode, 'pending')
  state = transition(state, { type: 'boundary', seq: 20, latest: null }, CFG)
  assert.equal(state.action, 'steer-initial')
  assert.equal(state.retriesLeft, CFG.maxCheckpointRetries)
})

test('compaction trigger schedules pending only when enabled and idle-modes', () => {
  let state = transition(freshState(), { type: 'compaction' }, CFG)
  assert.equal(state.mode, 'pending')
  assert.equal(state.auto, true)
  // while checkpointing, a compaction must not reschedule
  state = transition(state, { type: 'boundary', seq: 10, latest: null }, CFG)
  state = transition(state, { type: 'compaction' }, CFG)
  assert.equal(state.mode, 'checkpointing')
  // disabled config: no auto prepare
  const off = sanitizeConfig({ prepareAfterCompaction: false })
  assert.equal(transition(freshState(), { type: 'compaction' }, off).mode, 'normal')
})

test('cancellation drops a pending request', () => {
  const state = transition(transition(freshState(), { type: 'handoff' }, CFG), { type: 'cancel' }, CFG)
  assert.equal(state.mode, 'normal')
})

// ── continuation target resolution ───────────────────────────────────────────
const CANDIDATES = [
  { sessionId: 'session-1', label: 'Build auth', cwd: 'C:\\a', createdAt: 1 },
  { sessionId: 'session-2', label: 'Fix auth bug', cwd: 'C:\\a', createdAt: 2 },
  { sessionId: 'session-3', label: 'Docs pass', cwd: 'C:\\b', createdAt: 3 },
]

test('exact id resolves first', () => {
  const r = resolveTarget(CANDIDATES, 'session-1', 'session-new')
  assert.equal(r.kind, 'target')
  assert.equal(r.match, 'id')
  assert.equal(r.candidate.sessionId, 'session-1')
})

test('exact title resolves second', () => {
  const r = resolveTarget(CANDIDATES, 'Docs pass', 'session-new')
  assert.equal(r.kind, 'target')
  assert.equal(r.match, 'title')
  assert.equal(r.candidate.sessionId, 'session-3')
})

test('unique substring match resolves third', () => {
  const r = resolveTarget(CANDIDATES, 'auth bug', 'session-new')
  assert.equal(r.kind, 'target')
  assert.equal(r.match, 'unique')
  assert.equal(r.candidate.sessionId, 'session-2')
})

test('ambiguous and missing targets are rejected', () => {
  assert.equal(resolveTarget(CANDIDATES, 'auth', 'session-new').reason, 'ambiguous')
  assert.equal(resolveTarget(CANDIDATES, 'zzz', 'session-new').reason, 'none')
  assert.equal(resolveTarget(CANDIDATES, '', 'session-new').reason, 'usage')
})

test('self-reference is rejected', () => {
  assert.equal(resolveTarget(CANDIDATES, 'session-1', 'session-1').reason, 'self')
})

// ── log-derived durable facts ────────────────────────────────────────────────
test('findLastCheckpoint finds the newest valid checkpoint in the log', () => {
  const session = sessionWith([
    assistantEvent(1, 'older work'),
    assistantEvent(2, validCheckpoint()),
    assistantEvent(3, 'later work'),
  ])
  const found = findLastCheckpoint(session)
  assert.equal(found.seq, 2)
  assert.equal(found.valid, true)
})

test('findLastCheckpoint reports an invalid marker message honestly', () => {
  const session = sessionWith([assistantEvent(4, MARKER + '\n## Completed\npartial')])
  const found = findLastCheckpoint(session)
  assert.equal(found.valid, false)
  assert.match(found.reason, /missing required section/)
})

test('lastUserSeq and latestAttempt classify attempts correctly', () => {
  const session = sessionWith([
    assistantEvent(1, 'work'),
    toolCallEvent(2),
    assistantEvent(3, 'text answer without marker'),
  ])
  assert.equal(lastUserSeq(session), null)
  const attempt = latestAttempt(session, 0)
  assert.equal(attempt.seq, 3)
  assert.equal(attempt.isAttempt, true)
  assert.equal(attempt.valid, false)
  // scan from seq 3: nothing newer
  assert.equal(latestAttempt(session, 3), null)
})

// ── bounded snapshot helpers ─────────────────────────────────────────────────
test('capText bounds long text with a notice', () => {
  const long = 'x'.repeat(5000)
  const capped = capText(long, 200)
  assert.ok(capped.length <= 200 + 60)
  assert.match(capped, /omitted 4800 chars/)
})

test('textOfMessage joins only text blocks', () => {
  const text = textOfMessage({ content: [
    { type: 'thinking', text: 'secret' },
    { type: 'text', text: 'visible' },
    { type: 'tool_use', name: 'pwsh', input: {} },
    { type: 'text', text: 'more' },
  ] })
  assert.equal(text, 'visible\nmore\n')
})

// ── plugin wiring: registration, unload/reload, injection-before-steering ────
test('wiring: commands registered, listeners attached, effects reversible', () => {
  const defs = []
  const commands = {
    register(def) {
      defs.push(def)
      return () => { const i = defs.indexOf(def); if (i >= 0) defs.splice(i, 1) }
    },
  }
  const listeners = []
  const disposers = []
  const ctx = {
    get(name) { return name === 'commands' ? commands : undefined },
    on(event, listener) { listeners.push([event, listener]) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) },
  }
  continuityPlugin(ctx, {})
  assert.deepEqual(defs.map((d) => d.name).sort(),
    ['continue', 'continuity', 'handoff', 'mission', 'rotate', 'worker-report', 'worker-send', 'worker-stop', 'worker-successor', 'workers', 'worktree', 'worktree-cleanup'])
  const events = listeners.map(([event]) => event).sort()
  assert.deepEqual(events, ['agent/status', 'agent/turn-stopping', 'session/event'])
  // unload: every registration is removed through its disposer
  for (const dispose of disposers) dispose()
  assert.equal(defs.length, 0)
})

test('wiring: /mission delegates start/status to the host mission service', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const mission = {
    async start(agent, goal) { calls.push(['start', goal]); return { kind: 'success', text: 'started' } },
    status(agent) { calls.push(['status']); return { kind: 'success', text: 'phase: idle' } },
  }
  const session = sessionWith([])
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'continuityMission') return mission
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'mission')
  const started = await cmd.handler({ agent, rawInput: ' build the thing ', commandId: 'c18', signal: undefined })
  assert.equal(started.kind, 'success')
  const status = await cmd.handler({ agent, rawInput: ' status ', commandId: 'c19', signal: undefined })
  assert.equal(status.kind, 'success')
  const usage = await cmd.handler({ agent, rawInput: '', commandId: 'c20', signal: undefined })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /Usage/)
  assert.deepEqual(calls, [['start', 'build the thing'], ['status']])
})

test('wiring: worktree commands delegate to the host service and register the roles section', async () => {
  const defs = []
  const sections = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const systemPrompt = { section(entry) { sections.push(entry); return () => {} } }
  const calls = []
  const worktree = {
    async spawn(agent, spec) { calls.push(['spawn', spec.brief]); return { kind: 'success', text: 'spawned' } },
    async list(agent) { calls.push(['list']); return { kind: 'success', text: 'none' } },
    send(agent, id, text) { calls.push(['send', id, text]); return { kind: 'success', text: 'sent' } },
    stop(agent, id) { calls.push(['stop', id]); return { kind: 'success', text: 'stopped' } },
    async report(agent, id) { calls.push(['report', id]); return { kind: 'success', text: 'report' } },
  }
  const session = sessionWith([])
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'continuityWorktree') return worktree
      return undefined
    },
    on() {},
    effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'continuity-roles')
  assert.equal(sections[0].order, 150)
  const byName = (name) => defs.find((d) => d.name === name)
  await byName('worktree').handler({ agent, rawInput: ' build the api ', commandId: 'c11', signal: undefined })
  await byName('workers').handler({ agent, rawInput: '', commandId: 'c12', signal: undefined })
  await byName('worker-send').handler({ agent, rawInput: 'worker-1 fix the test', commandId: 'c13', signal: undefined })
  await byName('worker-stop').handler({ agent, rawInput: 'worker-1', commandId: 'c14', signal: undefined })
  await byName('worker-report').handler({ agent, rawInput: 'worker-1', commandId: 'c15', signal: undefined })
  assert.deepEqual(calls, [
    ['spawn', 'build the api'],
    ['list'],
    ['send', 'worker-1', 'fix the test'],
    ['stop', 'worker-1'],
    ['report', 'worker-1'],
  ])
  // usage errors
  const empty = await byName('worktree').handler({ agent, rawInput: '  ', commandId: 'c16', signal: undefined })
  assert.equal(empty.kind, 'error')
  assert.match(empty.text, /Usage/)
  // absent driver: honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx2, {})
  const missing = await defs2.find((d) => d.name === 'workers').handler({ agent, rawInput: '', commandId: 'c17', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /not installed/)
})

test('wiring: /rotate delegates to the host rotation service and reports its absence', async () => {
  const defs = []
  const commands = {
    register(def) {
      defs.push(def)
      return () => {}
    },
  }
  const calls = []
  const rotation = {
    async rotate(agent, signal) {
      calls.push(agent.id)
      return { kind: 'success', text: 'rollover done' }
    },
  }
  const session = sessionWith([])
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'continuityRotation') return rotation
      return undefined
    },
    on() {},
    effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'rotate')
  const result = await cmd.handler({ agent, rawInput: '', commandId: 'c9', signal: undefined })
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls, [session.id])
  // absent driver: honest error (fresh registrations so the first handler is not shadowing)
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = {
    get(name) { return name === 'commands' ? commands2 : undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx2, {})
  const cmd2 = defs2.find((d) => d.name === 'rotate')
  const missing = await cmd2.handler({ agent, rawInput: '', commandId: 'c10', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /not installed/)
})

test('wiring: /handoff on an idle agent steers immediately and stays idempotent', async () => {
  const defs = []
  const commands = {
    register(def) {
      defs.push(def)
      return () => {}
    },
  }
  const steered = []
  const injected = []
  const followed = []
  const session = sessionWith([])
  const agent = {
    id: session.id,
    status: 'idle',
    session,
    options: {},
    steer(message) { steered.push(message) },
    inject(message) { injected.push(message) },
    followup(message) { followed.push(message) },
  }
  const ctx = {
    get(name) { return name === 'commands' ? commands : undefined },
    on() {},
    effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const handoff = defs.find((d) => d.name === 'handoff')
  const first = handoff.handler({ agent, rawInput: '', commandId: 'c1', signal: undefined })
  assert.equal(first.kind, 'success')
  assert.match(first.text, /steered now/)
  assert.equal(steered.length, 1)
  const second = handoff.handler({ agent, rawInput: '', commandId: 'c2', signal: undefined })
  assert.equal(second.kind, 'success')
  assert.match(second.text, /Already scheduled/)
  assert.equal(steered.length, 1)
})

test('wiring: /continue injects source context BEFORE the waking instruction', async () => {
  const defs = []
  const commands = {
    register(def) {
      defs.push(def)
      return () => {}
    },
  }
  const order = []
  const session = sessionWith([])
  const agent = {
    id: session.id,
    status: 'idle',
    session,
    options: {},
    inject(message) { order.push('inject:' + message.source.kind) },
    followup(message) { order.push('followup:' + message.source.kind) },
  }
  const resolver = {
    async listCandidates(_agent, query, limit) {
      return [{ sessionId: 'session-old', label: 'Old work', cwd: 'C:\\work\\repo', createdAt: 1 }]
    },
    async prepare(_agent, content, references, signal) {
      return {
        content,
        additionalContext: {
          id: 'snap',
          role: 'user',
          source: { kind: 'session-reference', version: 1 },
          content: [{ type: 'text', text: 'snapshot text without the checkpoint marker' }],
        },
      }
    },
  }
  const sessionQuery = {
    async readSession(id) {
      return {
        session: { id, cwd: 'C:\\work\\repo' },
        events: [assistantEvent(7, validCheckpoint())],
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionReferenceResolver') return resolver
      if (name === 'sessionQuery') return sessionQuery
      return undefined
    },
    on() {},
    effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'continue')
  const result = await cmd.handler({ agent, rawInput: ' session-old ', commandId: 'c3', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /matched by id/)
  assert.deepEqual(order, [
    'inject:session-reference',
    'inject:continuity-checkpoint-recall',
    'followup:continuity-continue',
  ])
})

test('wiring: /continue rejects a non-blank session and a second use', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const session = sessionWith([assistantEvent(1, 'previous content')])
  const agent = {
    id: session.id, status: 'idle', session, options: {},
    inject() {}, followup() {},
  }
  const resolver = {
    async listCandidates() { return [{ sessionId: 'session-old', label: 'Old', cwd: 'C:\\a', createdAt: 1 }] },
    async prepare() { return { content: [{ type: 'text', text: 'i' }], additionalContext: undefined } },
  }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionReferenceResolver') return resolver
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'continue')
  const result = await cmd.handler({ agent, rawInput: 'session-old', commandId: 'c4', signal: undefined })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /blank session/)
})

// ── config sanitization ──────────────────────────────────────────────────────
test('config defaults and clamps', () => {
  const cfg = sanitizeConfig({ warningRatio: 0.6, checkpointRatio: 0.7, rotateRatio: 0.78, prepareAfterCompaction: true, maxCheckpointRetries: 1 })
  assert.equal(cfg.warningRatio, 0.6)
  assert.equal(cfg.checkpointRatio, 0.7)
  assert.equal(cfg.rotateRatio, 0.78)
  assert.equal(cfg.maxCheckpointRetries, 1)
  const clamped = sanitizeConfig({ warningRatio: 2, checkpointRatio: -1, rotateRatio: 0.5, maxCheckpointRetries: 99 })
  assert.equal(clamped.warningRatio, 0.6)
  assert.ok(clamped.checkpointRatio >= clamped.warningRatio)
  assert.ok(clamped.rotateRatio >= clamped.checkpointRatio)
  assert.equal(clamped.maxCheckpointRetries, 3)
})

test('userMessage builds a JSON-safe identified message', () => {
  const message = userMessage('hello', 'continuity-steer')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.deepEqual(message.source, { kind: 'continuity-steer', version: 1 })
  assert.ok(JSON.stringify(message).includes('hello'))
})

// ── incremental event cache: identical semantics to the v4 full scans ───────
function contextEvent(seq, window) {
  return { type: 'request/context', seq, data: { contextWindow: window } }
}

function compactionEvent(seq, error) {
  return { type: 'compaction/end', seq, data: error === undefined ? {} : { error } }
}

function userEvent(seq) {
  return { type: 'user/message', seq, data: { message: { role: 'user', content: [{ type: 'text', text: 'u' }] } } }
}

test('incremental cache matches full-fold semantics for all derived facts', () => {
  const events = [
    assistantEvent(1, 'work'),
    userEvent(2),
    contextEvent(3, 20000),
    compactionEvent(4),
    assistantEvent(5, validCheckpoint()),
    contextEvent(6, 0), // invalid window → last-wins null
    compactionEvent(7, 'boom'), // failed compaction not counted
    assistantEvent(8, 'later text'),
  ]
  // baseline: full fold
  const baseline = freshCache()
  for (const event of events) foldEvent(baseline, event)
  // incremental: fold one at a time
  const incremental = freshCache()
  for (const event of events) {
    foldIncremental(incremental, [event])
  }
  assert.equal(incremental.compactionCount, 1)
  assert.equal(incremental.surfaceMessages, 4) // 3 assistant + 1 user
  assert.equal(incremental.lastUserSeq, 2)
  assert.equal(incremental.lastAssistantSeq, 8)
  assert.equal(incremental.lastContextWindow, null)
  assert.equal(incremental.lastCheckpoint.seq, 5)
  assert.equal(incremental.lastCheckpoint.valid, true)
  assert.deepEqual(incremental, baseline)
})

test('incremental cache cursor skips already-folded events (no double count)', () => {
  const cache = freshCache()
  foldIncremental(cache, [assistantEvent(1, 'a'), assistantEvent(2, 'b')])
  assert.equal(cache.surfaceMessages, 2)
  assert.equal(cache.lastScanSeq, 2)
  // Re-offering the same two events plus one new one must not double-count.
  foldIncremental(cache, [assistantEvent(1, 'a'), assistantEvent(2, 'b'), assistantEvent(3, 'c')])
  assert.equal(cache.surfaceMessages, 3)
  assert.equal(cache.lastAssistantSeq, 3)
  assert.equal(cache.lastScanSeq, 3)
})

test('classifyAttempt matches latestAttempt classification exactly', () => {
  const marker = { content: [{ type: 'text', text: validCheckpoint() }] }
  const plain = { content: [{ type: 'text', text: 'nope' }] }
  const tool = { content: [{ type: 'tool_use', name: 'pwsh', input: {} }] }
  const a1 = classifyAttempt(marker, 10)
  assert.equal(a1.valid, true)
  assert.equal(a1.isAttempt, true)
  const a2 = classifyAttempt(plain, 11)
  assert.equal(a2.valid, false)
  assert.equal(a2.isAttempt, true)
  assert.match(a2.reason, /marker missing/)
  assert.equal(classifyAttempt(tool, 12), null)
})

test('wiring: /worker-successor delegates to the rotation driver and reports absence', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const rotation = {
    async rotateSuccessor(agent, workerId, instruction, signal) {
      calls.push([workerId, instruction])
      return { kind: 'success', text: 'successor spawned' }
    },
  }
  const session = sessionWith([])
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'continuityRotation') return rotation
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'worker-successor')
  assert.ok(cmd, 'worker-successor command registered')
  const result = await cmd.handler({ agent, rawInput: ' worker-1 finish the rest ', commandId: 'c21', signal: undefined })
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls, [['worker-1', 'finish the rest']])
  // absent driver: honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx2, {})
  const missing = await defs2.find((d) => d.name === 'worker-successor').handler({ agent, rawInput: 'worker-1', commandId: 'c22', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unavailable/)
})

test('wiring: /continuity shows the worker successor hint instead of /rotate', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const rotation = {
    suggest() {
      return { ratio: 0.9, capacity: 10000, threshold: 0.78, mode: 'suggest', recommendation: 'suggest', rotating: false, failure: null, worker: true, successor: true }
    },
  }
  const session = sessionWith([contextEvent(1, 10000), assistantEvent(2, 'work')])
  session.header = { cwd: 'C:\\work\\repo', parentSession: 'coordinator-1' }
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'continuityRotation') return rotation
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const result = await defs.find((d) => d.name === 'continuity').handler({ agent, rawInput: '', commandId: 'c23', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /worker successor/)
  assert.doesNotMatch(result.text, /run \/rotate/)
})

// ── child-session workspace reconcile (GUI visibility) ───────────────────────
function mockWorkspace(initialSessionIds) {
  const ids = Array.isArray(initialSessionIds) ? initialSessionIds.slice() : []
  return {
    path: 'C:\\work\\repo',
    get sessionIds() { return ids.slice() },
    attachSession(id) { if (!ids.includes(id)) ids.push(id); return Promise.resolve() },
    detachSession(id) { const i = ids.indexOf(id); if (i >= 0) ids.splice(i, 1); return Promise.resolve() },
  }
}

function childHeader(id, parentSession, cwd) {
  return { id, parentSession, cwd, createdAt: 1 }
}

function reconcileHarness(config, children, workspace, agentsMap) {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessionQuery = { async listSessions() { return children.map((header) => ({ header })) } }
  const workspaceRegistry = { async resolveByPath() { return workspace } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'agents') return agentsMap
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, config)
  return { defs }
}

function coordinatorAgent() {
  const session = sessionWith([])
  return { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
}

test('reconcile: /continuity attaches an unattached child and skips already-attached (idempotent)', async () => {
  const workspace = mockWorkspace([])
  const attachCalls = []
  const original = workspace.attachSession
  workspace.attachSession = (id) => { attachCalls.push(id); return original(id) }
  const children = [childHeader('child-1', 'session-a', 'C:\\work\\repo')]
  const { defs } = reconcileHarness({}, children, workspace, undefined)
  const agent = coordinatorAgent()
  const cmd = defs.find((d) => d.name === 'continuity')
  const r1 = await cmd.handler({ agent, rawInput: '', commandId: 'c30', signal: undefined })
  assert.equal(r1.kind, 'success', r1.text)
  assert.match(r1.text, /1 child session\(s\), 1 attached/)
  assert.deepEqual(attachCalls, ['child-1'])
  const r2 = await cmd.handler({ agent, rawInput: '', commandId: 'c31', signal: undefined })
  assert.match(r2.text, /1 child session\(s\), 1 attached/)
  assert.deepEqual(attachCalls, ['child-1']) // idempotent: not re-attached
})

test('reconcile: cleanupSettledWorkers detaches a settled (non-live) child', async () => {
  const workspace = mockWorkspace(['child-1'])
  const children = [childHeader('child-1', 'session-a', 'C:\\work\\repo')]
  const agentsMap = { get: () => undefined } // not live → settled
  const { defs } = reconcileHarness({ cleanupSettledWorkers: true }, children, workspace, agentsMap)
  const agent = coordinatorAgent()
  const result = await defs.find((d) => d.name === 'continuity').handler({ agent, rawInput: '', commandId: 'c32', signal: undefined })
  assert.match(result.text, /1 child session\(s\), 0 attached/)
  assert.equal(workspace.sessionIds.length, 0)
})

test('reconcile: cleanupSettledWorkers keeps a running child attached', async () => {
  const workspace = mockWorkspace(['child-1'])
  const children = [childHeader('child-1', 'session-a', 'C:\\work\\repo')]
  const agentsMap = { get: (id) => (id === 'child-1' ? { status: 'running' } : undefined) }
  const { defs } = reconcileHarness({ cleanupSettledWorkers: true }, children, workspace, agentsMap)
  const agent = coordinatorAgent()
  const result = await defs.find((d) => d.name === 'continuity').handler({ agent, rawInput: '', commandId: 'c33', signal: undefined })
  assert.match(result.text, /1 attached/)
  assert.deepEqual(workspace.sessionIds, ['child-1'])
})

test('reconcile: workerVisibility=false leaves children unattached and reports disabled', async () => {
  const workspace = mockWorkspace([])
  const children = [childHeader('child-1', 'session-a', 'C:\\work\\repo')]
  const { defs } = reconcileHarness({ workerVisibility: false }, children, workspace, undefined)
  const agent = coordinatorAgent()
  const result = await defs.find((d) => d.name === 'continuity').handler({ agent, rawInput: '', commandId: 'c34', signal: undefined })
  assert.match(result.text, /worker visibility: disabled/)
  assert.equal(workspace.sessionIds.length, 0)
})

test('wiring: /worktree-cleanup delegates --dry-run/--confirm to the host service', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const worktree = {
    async cleanup(agent, mode) { calls.push(mode); return { kind: 'success', text: 'cleaned' } },
  }
  const session = sessionWith([])
  const agent = { id: session.id, status: 'idle', session, options: {}, inject() {}, followup() {} }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'continuityWorktree') return worktree
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'worktree-cleanup')
  assert.ok(cmd, 'worktree-cleanup command registered')
  await cmd.handler({ agent, rawInput: ' --dry-run ', commandId: 'c35', signal: undefined })
  await cmd.handler({ agent, rawInput: '--confirm', commandId: 'c36', signal: undefined })
  assert.deepEqual(calls, ['--dry-run', '--confirm'])
  // usage: empty input
  const usage = await cmd.handler({ agent, rawInput: '  ', commandId: 'c37', signal: undefined })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /Usage/)
  // absent driver: honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx2, {})
  const missing = await defs2.find((d) => d.name === 'worktree-cleanup').handler({ agent, rawInput: '--dry-run', commandId: 'c38', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /not installed/)
})

console.log('')
console.log('passed: ' + passed + ', failed: ' + failed)
if (failed > 0) process.exitCode = 1
