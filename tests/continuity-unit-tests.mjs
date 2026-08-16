/**
 * Focused unit tests for the continuity preset companion plugin
 * (C:\Users\<USER>\.dsh\.agent-presets\continuity\continuity-plugin.v32.mjs).
 *
 * Run with: node continuity-unit-tests.mjs
 * Exit code 0 = all tests passed.
 *
 * The plugin is imported dynamically from $DSH_HOME (default ~/.dsh) so the
 * repository carries no personal absolute paths.
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
const DSH = (process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')).replace(/\\/g, '/')
const pluginModule = await import('file:///' + DSH + '/.agent-presets/continuity/continuity-plugin.v32.mjs')
const {
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
  paceDue,
  paceCheckPrompt,
  COORD_LINK_MARKER,
  parseLinkRecord,
  hubCheckDue,
  hubCheckPrompt,
  WORKER_REPORT_MARKER,
  spokePressureAlert,
} = pluginModule
const continuityPlugin = pluginModule.default

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
    ['continue', 'continuity', 'coordinate', 'coordinate-hub', 'coordinate-intake', 'current_session', 'handoff', 'mission', 'mission_status', 'pace', 'relay', 'rotate', 'session-peek', 'sessions', 'sessions_active', 'status', 'steer', 'uncoordinate', 'worker-report', 'worker-send', 'worker-stop', 'worker-successor', 'workers', 'worktree', 'worktree-cleanup'])
  const events = listeners.map(([event]) => event).sort()
  assert.deepEqual(events, ['agent/status', 'agent/turn-stopping', 'session/event', 'session/event'])
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

test('wiring: /mission_status delegates to the host mission service (space-free alias)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const mission = {
    async start() { return { kind: 'success', text: 'started' } },
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
  const cmd = defs.find((d) => d.name === 'mission_status')
  assert.ok(cmd, 'mission_status command registered')
  const status = await cmd.handler({ agent, rawInput: '', commandId: 'c40', signal: undefined })
  assert.equal(status.kind, 'success')
  assert.deepEqual(calls, [['status']])
  // driver absent → honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx3 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx3, {})
  const missing = await defs2.find((d) => d.name === 'mission_status').handler({ agent, rawInput: '', commandId: 'c41', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unavailable/)
})

test('wiring: /mission stop delegates to the host mission service (v26)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const mission = {
    async start() { return { kind: 'success', text: 'started' } },
    status() { return { kind: 'success', text: 'phase: idle' } },
    stop(agent) { calls.push(['stop', agent.id]); return { kind: 'success', text: 'cancelled' } },
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
  const stopped = await cmd.handler({ agent, rawInput: ' stop ', commandId: 'c99', signal: undefined })
  assert.equal(stopped.kind, 'success', stopped.text)
  assert.match(stopped.text, /cancelled/)
  assert.deepEqual(calls, [['stop', agent.id]])
  // driver without stop → honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const mission2 = { start() { return { kind: 'success', text: 'started' } }, status() { return { kind: 'success', text: 'phase: idle' } } }
  const ctx2 = {
    get(name) {
      if (name === 'commands') return commands2
      if (name === 'continuityMission') return mission2
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx2, {})
  const unsupported = await defs2.find((d) => d.name === 'mission').handler({ agent, rawInput: ' stop ', commandId: 'c100', signal: undefined })
  assert.equal(unsupported.kind, 'error')
  assert.match(unsupported.text, /does not support/)
})

test('wiring: /status is a bare alias of /mission status (v26)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const calls = []
  const mission = {
    async start() { return { kind: 'success', text: 'started' } },
    status(agent) { calls.push(['status', agent.id]); return { kind: 'success', text: 'phase: idle' } },
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
  const cmd = defs.find((d) => d.name === 'status')
  assert.ok(cmd, 'status command registered')
  const out = await cmd.handler({ agent, rawInput: '', commandId: 'c101', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.deepEqual(calls, [['status', agent.id]])
})

test('coordination: /coordinate links two sessions and /uncoordinate breaks the link (v10)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup() {} },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup() {} },
  }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const byName = (n) => defs.find((d) => d.name === n)
  const coord = byName('coordinate')
  assert.ok(coord, 'coordinate command registered')
  const front = sessions['s-front']
  const linked = await coord.handler({ agent: front, rawInput: 's-back', commandId: 'c50', signal: undefined })
  assert.equal(linked.kind, 'success', linked.text)
  assert.match(linked.text, /Linked/)
  const status = await coord.handler({ agent: front, rawInput: 'status', commandId: 'c51', signal: undefined })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /s-back/)
  const self = await coord.handler({ agent: front, rawInput: 's-front', commandId: 'c52', signal: undefined })
  assert.equal(self.kind, 'error')
  const missingTarget = await coord.handler({ agent: front, rawInput: 'nope', commandId: 'c53', signal: undefined })
  assert.equal(missingTarget.kind, 'error')
  const un = byName('uncoordinate')
  const broke = await un.handler({ agent: front, rawInput: 's-back', commandId: 'c54', signal: undefined })
  assert.equal(broke.kind, 'success')
  const statusAfter = await coord.handler({ agent: front, rawInput: 'status', commandId: 'c55', signal: undefined })
  assert.match(statusAfter.text, /No coordination links/)
})

test('coordination: /relay pushes a one-shot message into the target session (v10)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const received = []
  const target = { id: 's-back', session: { id: 's-back', events: [] }, followup(msg) { received.push(msg) } }
  const agents = { get(id) { return id === 's-back' ? target : undefined } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-front', session: { id: 's-front', events: [] }, followup() {} }
  const cmd = defs.find((d) => d.name === 'relay')
  const ok = await cmd.handler({ agent, rawInput: 's-back 帮我跑一下后端测试', commandId: 'c56', signal: undefined })
  assert.equal(ok.kind, 'success', ok.text)
  assert.equal(received.length, 1)
  const text = received[0].content[0].text
  assert.match(text, /帮我跑一下后端测试/)
  assert.equal(received[0].source.kind, 'continuity-coord')
  const missing = await cmd.handler({ agent, rawInput: 'nope hi', commandId: 'c57', signal: undefined })
  assert.equal(missing.kind, 'error')
  const usage = await cmd.handler({ agent, rawInput: 's-back', commandId: 'c58', signal: undefined })
  assert.equal(usage.kind, 'error')
})

test('coordination: auto-forward relays linked replies, loop-protected by the source tag (v10)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-front', text: msg.content[0].text }) } },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-back', text: msg.content[0].text }) } },
  }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  // link via the command
  const coord = defs.find((d) => d.name === 'coordinate')
  await coord.handler({ agent: sessions['s-front'], rawInput: 's-back', commandId: 'c60', signal: undefined })
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // original reply from s-front → forwarded to s-back
  for (const l of evListeners) l(sessions['s-front'].session, {
    type: 'assistant/message', seq: 1,
    data: { message: { content: [{ type: 'text', text: '前端搞定了接口' }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.equal(received[0].to, 's-back')
  assert.match(received[0].text, /前端搞定了接口/)
  // a message that IS a relay (source continuity-coord) must not be re-forwarded
  received.length = 0
  for (const l of evListeners) l(sessions['s-back'].session, {
    type: 'assistant/message', seq: 2,
    data: { message: { content: [{ type: 'text', text: '已转发内容' }], source: { kind: 'continuity-coord', version: 1 } } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 0, 'relayed message must not be re-forwarded')
})

test('coordination: auto-forward relays FINAL replies only, never intermediate tool-call steps (v22)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-front', text: msg.content[0].text }) } },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-back', text: msg.content[0].text }) } },
  }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const coord = defs.find((d) => d.name === 'coordinate')
  await coord.handler({ agent: sessions['s-front'], rawInput: 's-back', commandId: 'c88', signal: undefined })
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // intermediate step 1: lead-in text BEFORE a tool call — must NOT be forwarded
  for (const l of evListeners) l(sessions['s-front'].session, {
    type: 'assistant/message', seq: 1,
    data: { message: { content: [{ type: 'text', text: '我先查一下接口文档' }, { type: 'tool_use', name: 'pwsh', input: {} }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 0, 'lead-in text before a tool call must not be forwarded')
  // intermediate step 2: progress text BETWEEN tool calls — must NOT be forwarded
  for (const l of evListeners) l(sessions['s-front'].session, {
    type: 'assistant/message', seq: 2,
    data: { message: { content: [{ type: 'text', text: '结果出来了，继续看第二处' }, { type: 'tool_use', name: 'glob', input: {} }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 0, 'progress text between tool calls must not be forwarded')
  // final reply of the turn (no pending tool call) — forwarded once
  for (const l of evListeners) l(sessions['s-front'].session, {
    type: 'assistant/message', seq: 3,
    data: { message: { content: [{ type: 'text', text: '查完了：接口契约没问题' }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.equal(received[0].to, 's-back')
  assert.match(received[0].text, /查完了：接口契约没问题/)
})

test('coordination: peek skips messages already auto-forwarded to the hub; --full forces re-read (v23)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) }, steer() {} }
  const spoke = { id: 's-front', session: { id: 's-front', events: [] }, followup() {} }
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const sessionQuery = {
    readSurface: async () => ({
      session: { cwd: 'C:\\work' },
      events: [
        { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: '任务：重构接口' }] } } },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '我先看看' }, { type: 'tool_use', name: 'pwsh', input: {} }] } } },
        { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '重构完成' }] } } },
        { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '补充：测试也过了' }] } } },
      ],
    }),
  }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'agents') return agents
      if (name === 'sessionQuery') return sessionQuery
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  await hubCmd.handler({ agent: hub, rawInput: 's-front', commandId: 'c89', signal: undefined })
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // seq 3 and seq 4 are final replies → auto-forwarded to the hub (and recorded)
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '重构完成' }] } } })
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '补充：测试也过了' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 2, JSON.stringify(received))
  // peek by the hub: seq 3/4 skipped (already forwarded), seq 1/2 shown
  const peek = defs.find((d) => d.name === 'session-peek')
  const out = await peek.handler({ agent: hub, rawInput: 's-front 10', commandId: 'c90', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /任务：重构接口/)
  assert.match(out.text, /我先看看/)
  assert.doesNotMatch(out.text, /重构完成/)
  assert.doesNotMatch(out.text, /补充：测试也过了/)
  assert.match(out.text, /already auto-forwarded were skipped/)
  // --full forces a re-read of everything
  const outFull = await peek.handler({ agent: hub, rawInput: 's-front 10 --full', commandId: 'c91', signal: undefined })
  assert.equal(outFull.kind, 'success', outFull.text)
  assert.match(outFull.text, /重构完成/)
  assert.match(outFull.text, /补充：测试也过了/)
  assert.doesNotMatch(outFull.text, /already auto-forwarded were skipped/)
  // a NON-linked session peeking s-front sees everything (no dedupe applies)
  const outsider = { id: 's-out', session: { id: 's-out', events: [] }, followup() {} }
  const out2 = await peek.handler({ agent: outsider, rawInput: 's-front 10', commandId: 'c92', signal: undefined })
  assert.equal(out2.kind, 'success', out2.text)
  assert.match(out2.text, /重构完成/)
})

test('coordination: /steer pushes a marked IMPORTANT message, refuses busy targets (v24)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const received = []
  const coord = { id: 's-hub', session: { id: 's-hub', events: [] }, status: 'idle', followup() {} }
  const main = { id: 's-main', session: { id: 's-main', events: [] }, status: 'idle', followup(msg) { if (msg.source && msg.source.kind === 'continuity-steer') received.push({ to: 's-main', text: msg.content[0].text }) } }
  const busy = { id: 's-busy', session: { id: 's-busy', events: [] }, status: 'running', followup(msg) { if (msg.source && msg.source.kind === 'continuity-steer') received.push({ to: 's-busy', text: msg.content[0].text }) } }
  const sessions = { 's-hub': coord, 's-main': main, 's-busy': busy }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'steer')
  assert.ok(cmd, 'steer command registered')
  // idle target → steered with an important mark
  const out = await cmd.handler({ agent: coord, rawInput: 's-main 后端接口契约已冻结，请知悉', commandId: 'c93', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.match(received[0].text, /【重要/)
  assert.match(received[0].text, /s-hub/)
  assert.match(received[0].text, /后端接口契约已冻结，请知悉/)
  // busy target → refused without --force (steering would break its thinking chain)
  const refused = await cmd.handler({ agent: coord, rawInput: 's-busy 紧急', commandId: 'c94', signal: undefined })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /mid-turn/)
  assert.equal(received.length, 1, 'busy target must not receive the steer')
  // --force bypasses on a genuine emergency
  const forced = await cmd.handler({ agent: coord, rawInput: 's-busy 紧急：服务宕了 --force', commandId: 'c95', signal: undefined })
  assert.equal(forced.kind, 'success', forced.text)
  assert.equal(received.length, 2, JSON.stringify(received))
  assert.match(received[1].text, /服务宕了/)
  // self-target and unknown target rejected; usage required
  const self = await cmd.handler({ agent: coord, rawInput: 's-hub 不要', commandId: 'c96', signal: undefined })
  assert.equal(self.kind, 'error')
  assert.match(self.text, /own session/)
  const ghost = await cmd.handler({ agent: coord, rawInput: 's-ghost 你好', commandId: 'c97', signal: undefined })
  assert.equal(ghost.kind, 'error')
  assert.match(ghost.text, /not found/)
  const usage = await cmd.handler({ agent: coord, rawInput: '', commandId: 'c98', signal: undefined })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /Usage/)
})

test('coordination: parseLinkRecord reads durable hub/spoke/peer records (v27)', () => {
  const hub = parseLinkRecord(COORD_LINK_MARKER + ' hub=s-hub spokes=s-a,s-b')
  assert.deepEqual(hub, { hub: 's-hub', spokes: ['s-a', 's-b'] })
  const spoke = parseLinkRecord('prefix\n' + COORD_LINK_MARKER + ' hub=s-hub\nsuffix')
  assert.deepEqual(spoke, { hub: 's-hub' })
  const peer = parseLinkRecord(COORD_LINK_MARKER + ' peers=s-back')
  assert.deepEqual(peer, { peers: 's-back' })
  const cleared = parseLinkRecord(COORD_LINK_MARKER + ' hub=')
  assert.deepEqual(cleared, { hub: '' })
  assert.equal(parseLinkRecord('no marker here'), null)
  assert.equal(parseLinkRecord(''), null)
  assert.equal(parseLinkRecord(undefined), null)
  assert.match(hubCheckPrompt(20, 's-hub'), /Coordinator check-in/)
})

test('coordination: hubCheckDue gate + hubCheckMinutes clamp (v27)', () => {
  assert.equal(hubCheckDue(null, { hubCheckMinutes: 15 }, Date.now()), false)
  assert.equal(hubCheckDue({ lastCheckAt: Date.now() }, { hubCheckMinutes: 15 }, Date.now()), false)
  assert.equal(hubCheckDue({ lastCheckAt: Date.now() - 5 * 60000 }, { hubCheckMinutes: 15 }, Date.now()), false)
  assert.equal(hubCheckDue({ lastCheckAt: Date.now() - 16 * 60000 }, { hubCheckMinutes: 15 }, Date.now()), true)
  assert.equal(sanitizeConfig({}).hubCheckMinutes, 15)
  assert.equal(sanitizeConfig({ hubCheckMinutes: 9999 }).hubCheckMinutes, 120)
  assert.equal(sanitizeConfig({ hubCheckMinutes: 0 }).hubCheckMinutes, 1)
})

test('coordination: links survive restart — restored from the durable log (v27)', async () => {
  const sessionOf = (id) => ({ id, header: { cwd: 'C:\\w' }, events: [] })
  const agentOf = (session) => ({
    id: session.id,
    session,
    status: 'idle',
    followup() {},
    steer() {},
    inject(message) { session.events.push({ type: 'user/message', seq: session.events.length + 1, data: { message } }) },
  })
  const hub = agentOf(sessionOf('s-hub'))
  const spoke = agentOf(sessionOf('s-front'))
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const makeCtx = (commandsSvc, listeners) => ({
    get(name) {
      if (name === 'commands') return commandsSvc
      if (name === 'agents') return agents
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  })
  // process generation A: link hub <-> spoke; durable records land in both logs
  const defsA = []
  const commandsA = { register(def) { defsA.push(def); return () => {} } }
  continuityPlugin(makeCtx(commandsA, []), {})
  const hubCmd = defsA.find((d) => d.name === 'coordinate-hub')
  const linked = await hubCmd.handler({ agent: hub, rawInput: 's-front', commandId: 'c102', signal: undefined })
  assert.equal(linked.kind, 'success', linked.text)
  assert.ok(spoke.session.events.length >= 1, 'spoke log must carry a durable link record')
  assert.ok(hub.session.events.length >= 1, 'hub log must carry a durable link record')
  // process generation B: a restart — fresh plugin, same logs
  const defsB = []
  const commandsB = { register(def) { defsB.push(def); return () => {} } }
  const listenersB = []
  const received = []
  hub.followup = (msg) => { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) }
  continuityPlugin(makeCtx(commandsB, listenersB), {})
  // spoke replies after the restart → auto-forwarded to the hub again
  const evListenersB = listenersB.filter(([e]) => e === 'session/event').map(([, l]) => l)
  for (const l of evListenersB) l(spoke.session, { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '重启后完成的活' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.match(received[0].text, /重启后完成的活/)
  // hub side restored too: intake reaches the spoke
  const spokeGot = []
  spoke.followup = (msg) => { spokeGot.push(msg) }
  const intake = defsB.find((d) => d.name === 'coordinate-intake')
  const intakeOut = await intake.handler({ agent: hub, rawInput: '', commandId: 'c103', signal: undefined })
  assert.equal(intakeOut.kind, 'success', intakeOut.text)
  assert.equal(spokeGot.length, 1, 'intake must reach the spoke after restart')
})

test('coordination: idle hub arming — no premature check-in before the window (v27)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, status: 'idle', steer(msg) { steered.push(msg) }, followup() {}, inject() {} }
  const spoke = { id: 's-front', session: { id: 's-front', events: [] }, status: 'idle', followup() {}, inject() {} }
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const listeners = []
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'agents') return agents
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  await hubCmd.handler({ agent: hub, rawInput: 's-front', commandId: 'c104', signal: undefined })
  // the hub command steered the onboarding once; reset the counter
  steered.length = 0
  // the first idle transition only arms the window; nothing steered yet
  for (const [event, listener] of listeners) {
    if (event === 'agent/status') listener({ agent: hub, status: 'idle' })
  }
  assert.equal(steered.length, 0, 'no check-in before the silence window elapses')
})

test('coordination: forward marker gate — only flagged final messages forward (v28)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, status: 'idle', followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) }, steer() {}, inject() {} }
  const spoke = { id: 's-front', session: { id: 's-front', events: [] }, status: 'idle', followup() {}, inject() {} }
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'agents') return agents
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, { coordinateForwardMarker: '请coordinate以下消息' })
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  await hubCmd.handler({ agent: hub, rawInput: 's-front', commandId: 'c105', signal: undefined })
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // an unmarked turn-final message stays silent
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '进度：接口写了一半' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 0, 'unmarked messages must not be forwarded')
  // a flagged message reaches the hub
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '请coordinate以下消息：接口契约有分歧，需要你定' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.match(received[0].text, /接口契约有分歧/)
  // intermediate step with the marker still does NOT forward (v22 wins)
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '请coordinate以下消息：我先查一下' }, { type: 'tool_use', name: 'pwsh', input: {} }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, 'intermediate steps never forward, marker or not')
  // config clamp: non-string marker falls back to ''
  assert.equal(sanitizeConfig({ coordinateForwardMarker: 42 }).coordinateForwardMarker, '')
  assert.equal(sanitizeConfig({}).coordinateForwardMarker, '')
})

test('coordination: completion reports forward even without the marker (v30)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, status: 'idle', followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) }, steer() {}, inject() {} }
  const spoke = { id: 's-front', session: { id: 's-front', events: [] }, status: 'idle', followup() {}, inject() {} }
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'agents') return agents
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, { coordinateForwardMarker: '请coordinate以下消息' })
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  await hubCmd.handler({ agent: hub, rawInput: 's-front', commandId: 'c106', signal: undefined })
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // a finished spoke that sees nothing to coordinate still reports completion
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '## Worker report\ndone: 完成了\nfiles: 无\nverification: 通过' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.match(received[0].text, /完成了/)
  assert.equal(WORKER_REPORT_MARKER, '## Worker report')
})

test('spokePressureAlert: over-threshold alerts, under/unknown skip (v31)', () => {
  const alert = spokePressureAlert('s-front', 90000, 100000, 0.78)
  assert.ok(alert !== null)
  assert.match(alert, /s-front/)
  assert.match(alert, /90%/)
  assert.match(alert, /worker-successor/)
  assert.equal(spokePressureAlert('s-front', 70000, 100000, 0.78), null)
  assert.equal(spokePressureAlert('s-front', null, 100000, 0.78), null)
  assert.equal(spokePressureAlert('s-front', 90000, null, 0.78), null)
  assert.equal(spokePressureAlert('s-front', 90000, 0, 0.78), null)
})

test('hubCheckPrompt: appends CONTEXT PRESSURE ALERTS when present (v31)', () => {
  const plain = hubCheckPrompt(20, 's-hub')
  assert.doesNotMatch(plain, /CONTEXT PRESSURE ALERTS/)
  const withAlerts = hubCheckPrompt(20, 's-hub', ['s-front: context at 90% (past the rotate threshold 78%) — alert body'])
  assert.match(withAlerts, /CONTEXT PRESSURE ALERTS/)
  assert.match(withAlerts, /s-front: context at 90%/)
})

test('coordination: full-log restore fallback via readSession (v28)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, status: 'idle', followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) }, steer() {}, inject() {} }
  // the spoke's in-memory events were compacted away — the record lives only in the durable store
  const spoke = { id: 's-front', session: { id: 's-front', events: [] }, status: 'idle', followup() {}, inject() {} }
  const sessions = { 's-hub': hub, 's-front': spoke }
  const agents = { get(id) { return sessions[id] } }
  const sessionQuery = {
    readSession: async () => ({
      events: [{ type: 'user/message', seq: 1, data: { message: userMessage(COORD_LINK_MARKER + ' peers=s-hub', 'continuity-links') } }],
    }),
  }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'agents') return agents
      if (name === 'sessionQuery') return sessionQuery
      return undefined
    },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // first event: sync restore finds nothing, the readSession fallback kicks in
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '第一波' }] } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(received.length, 0, 'the first event predates the async restore')
  // second event: links are restored from the durable store → forwarded
  for (const l of evListeners) l(spoke.session, { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '第二波' }] } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.match(received[0].text, /第二波/)
})

test('coordination-hub: hub coordinates EXISTING sessions — spokes forward to hub, hub replies do not broadcast (v11)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const listeners = []
  const received = []
  const sessions = {
    's-hub': { id: 's-hub', session: { id: 's-hub', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-hub', text: msg.content[0].text }) } },
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-front', text: msg.content[0].text }) } },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-back', text: msg.content[0].text }) } },
  }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on(event, listener) { listeners.push([event, listener]) }, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  assert.ok(hubCmd, 'coordinate-hub command registered')
  const hub = sessions['s-hub']
  const result = await hubCmd.handler({ agent: hub, rawInput: 's-front s-back', commandId: 'c70', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /s-front, s-back/)
  const evListeners = listeners.filter(([e]) => e === 'session/event').map(([, l]) => l)
  // spoke (s-front) reply → forwarded to hub only
  for (const l of evListeners) l(sessions['s-front'].session, {
    type: 'assistant/message', seq: 1,
    data: { message: { content: [{ type: 'text', text: '前端：接口写好了' }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 1, JSON.stringify(received))
  assert.equal(received[0].to, 's-hub')
  assert.match(received[0].text, /前端：接口写好了/)
  // hub reply → NOT broadcast to spokes (hub has no peer entries for spokes)
  received.length = 0
  for (const l of evListeners) l(sessions['s-hub'].session, {
    type: 'assistant/message', seq: 2,
    data: { message: { content: [{ type: 'text', text: '协调者：很好，后端继续' }] } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(received.length, 0, 'hub reply must not auto-broadcast to spokes')
})

test('session-peek: reads the latest messages of an existing session (v11)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessionQuery = {
    readSurface: async (id) => ({
      session: { cwd: 'C:\\work\\frontend' },
      events: [
        { type: 'user/message', seq: 10, data: { message: { content: [{ type: 'text', text: '帮我看下接口' }] } } },
        { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '接口在 api.ts，已跑通' }] } } },
      ],
    }),
  }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'sessionQuery') return sessionQuery; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-hub', session: { id: 's-hub', events: [] }, followup() {} }
  const cmd = defs.find((d) => d.name === 'session-peek')
  assert.ok(cmd, 'session-peek command registered')
  const peek = await cmd.handler({ agent, rawInput: 's-front 3', commandId: 'c71', signal: undefined })
  assert.equal(peek.kind, 'success', peek.text)
  assert.match(peek.text, /C:\\work\\frontend/)
  assert.match(peek.text, /接口在 api.ts/)
  const usage = await cmd.handler({ agent, rawInput: '', commandId: 'c72', signal: undefined })
  assert.equal(usage.kind, 'error')
  // sessionQuery absent → honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx2, {})
  const missing = await defs2.find((d) => d.name === 'session-peek').handler({ agent, rawInput: 's-front', commandId: 'c73', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unavailable/)
})

test('sessions: lists every session with its id for copy (v12)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 'session-aaa', cwd: 'C:\\work\\frontend', parentSession: undefined, createdAt: 1 },
        projection: { values: { title: '前端改造' } } },
      { header: { id: 'session-bbb', cwd: 'C:\\work\\backend', parentSession: undefined, createdAt: 2 },
        projection: { values: { title: '后端重构' } } },
    ],
  }
  const agents = { get(id) { return id === 'session-aaa' ? { id } : undefined } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'agents') return agents
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-hub', session: { id: 's-hub', events: [] }, followup() {} }
  const cmd = defs.find((d) => d.name === 'sessions')
  assert.ok(cmd, 'sessions command registered')
  const out = await cmd.handler({ agent, rawInput: '', commandId: 'c74', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /session-aaa/)
  assert.match(out.text, /前端改造/)
  assert.match(out.text, /\[live\]/)
  assert.match(out.text, /session-bbb/)
  assert.match(out.text, /后端重构/)
  // sessionQuery absent → honest error
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = { get(name) { return name === 'commands' ? commands2 : undefined }, on() {}, effect(fn) { fn() } }
  continuityPlugin(ctx2, {})
  const missing = await defs2.find((d) => d.name === 'sessions').handler({ agent, rawInput: '', commandId: 'c75', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unavailable/)
})

test('sessions_active: lists non-archived sessions inside workspace groups, archived and ungrouped hidden (v18)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessionQuery = {
    listSessions: async () => [
      { header: { id: 's-archived', cwd: 'C:\\wt\\front', parentSession: 's-coord', createdAt: 1 },
        projection: { values: { title: '归档会话' } } },
      { header: { id: 's-worker1', cwd: 'C:\\wt\\front', parentSession: 's-coord', createdAt: 2 },
        projection: { values: { title: '前端改造' } } },
      { header: { id: 's-worker2', cwd: 'C:\\wt\\front', parentSession: 's-coord', createdAt: 3 },
        projection: { values: { title: '前端测试' } } },
      { header: { id: 's-worker3', cwd: 'C:\\wt\\back', parentSession: 's-coord', createdAt: 4 },
        projection: { values: { title: '后端重构' } } },
      { header: { id: 's-loose', cwd: 'C:\\work\\elsewhere', parentSession: undefined, createdAt: 5 },
        projection: { values: { title: '未分组' } } },
    ],
  }
  const workspaceRegistry = {
    archivedSessionIds: ['s-archived'],
    list: () => [
      { id: 'w-front', title: 'worktree-前端', path: 'C:\\wt\\front', sessionIds: ['s-archived', 's-worker1', 's-worker2'] },
      { id: 'w-back', title: 'worktree-后端', path: 'C:\\wt\\back', sessionIds: ['s-worker3'] },
    ],
  }
  const agents = { get(id) { return id === 's-worker1' ? { id } : undefined } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'agents') return agents
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-coord', session: { id: 's-coord', events: [] }, followup() {} }
  const cmd = defs.find((d) => d.name === 'sessions_active')
  assert.ok(cmd, 'sessions_active command registered')
  const out = await cmd.handler({ agent, rawInput: '', commandId: 'c80', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /Active workgroup sessions \(3/)
  assert.match(out.text, /\[worktree-前端\]/)
  assert.match(out.text, /s-worker1/)
  assert.match(out.text, /s-worker2/)
  assert.match(out.text, /\[live\]/)
  assert.match(out.text, /\[worktree-后端\]/)
  assert.match(out.text, /s-worker3/)
  // archived member and ungrouped session stay hidden
  assert.doesNotMatch(out.text, /s-archived/)
  assert.doesNotMatch(out.text, /归档会话/)
  assert.doesNotMatch(out.text, /s-loose/)
  assert.doesNotMatch(out.text, /未分组/)
})

test('sessions_active: registry absent → honest error; empty registry → honest no-op (v18)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const sessionQuery = { listSessions: async () => [] }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'sessionQuery') return sessionQuery
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-coord', session: { id: 's-coord', events: [] }, followup() {} }
  const missing = await defs.find((d) => d.name === 'sessions_active').handler({ agent, rawInput: '', commandId: 'c81', signal: undefined })
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unavailable/)
  // registry present but no groups → honest no-op success
  const defs2 = []
  const commands2 = { register(def) { defs2.push(def); return () => {} } }
  const ctx2 = {
    get(name) {
      if (name === 'commands') return commands2
      if (name === 'sessionQuery') return sessionQuery
      if (name === 'workspaceRegistry') return { archivedSessionIds: [], list: () => [] }
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx2, {})
  const none = await defs2.find((d) => d.name === 'sessions_active').handler({ agent, rawInput: '', commandId: 'c82', signal: undefined })
  assert.equal(none.kind, 'success', none.text)
  assert.match(none.text, /No active workgroup sessions/)
})

test('current_session: prints only the current session id, nothing else (v19)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const agent = { id: 's-me', session: { id: 's-me', events: [] }, followup() {} }
  const cmd = defs.find((d) => d.name === 'current_session')
  assert.ok(cmd, 'current_session command registered')
  const out = await cmd.handler({ agent, rawInput: '', commandId: 'c83', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.equal(out.text, 's-me') // exactly the id, no decoration
  // session id missing → honest error
  const broken = await cmd.handler({ agent: { session: {} }, rawInput: '', commandId: 'c84', signal: undefined })
  assert.equal(broken.kind, 'error')
  assert.match(broken.text, /unavailable/)
})

test('coordinate-hub: steers the coordinator onboarding into the hub session (v13)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, steer(msg) { steered.push(msg) }, followup() {} }
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup() {} },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup() {} },
  }
  const agents = { get(id) { return sessions[id] || (id === 's-hub' ? hub : undefined) } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'coordinate-hub')
  const result = await cmd.handler({ agent: hub, rawInput: 's-front s-back', commandId: 'c76', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.equal(steered.length, 1, 'onboarding must be steered into the hub session')
  const prompt = steered[0].content ? steered[0].content.map((c) => c.text).join(' ') : String(steered[0])
  assert.match(prompt, /Coordination hub onboarding/)
  assert.match(prompt, /\/coordinate-intake ONCE/)
  assert.match(prompt, /s-front, s-back/)
  // v15: delegate-first, decline content work, role persistence
  assert.match(prompt, /DELEGATION FIRST/)
  assert.match(prompt, /DECLINE politely/)
  assert.match(prompt, /ROLE PERSISTENCE/)
  assert.match(prompt, /\/coordinate-hub <ids>/)
  // v16: one delegation mechanism per task
  assert.match(prompt, /ONE DELEGATION MECHANISM PER TASK/)
  assert.match(prompt, /\/worker-send/)
  // v17: how to delegate — subagent = context isolation without a clean workspace
  assert.match(prompt, /HOW TO DELEGATE/)
  assert.match(prompt, /CLEAN, isolated workspace/)
  assert.match(prompt, /POLLUTE this conversation context/)
  assert.match(prompt, /keeps the coordinator context clean/)
})

test('coordinate-hub: onboarding is bounded — sibling sessions, stop-and-wait for the user (v20)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, steer(msg) { steered.push(msg) }, followup() {} }
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup() {} },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup() {} },
  }
  const agents = { get(id) { return sessions[id] || (id === 's-hub' ? hub : undefined) } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'coordinate-hub')
  const result = await cmd.handler({ agent: hub, rawInput: 's-front s-back', commandId: 'c85', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.equal(steered.length, 1)
  const prompt = steered[0].content ? steered[0].content.map((c) => c.text).join(' ') : String(steered[0])
  // v20: spokes are sibling sessions — inspect with /session-peek, never the subagent registry or filesystem hunting
  assert.match(prompt, /SIBLING SESSIONS, NOT SUBAGENTS/)
  assert.match(prompt, /\/session-peek <spoke-id>/)
  assert.match(prompt, /list_agents tool/)
  assert.match(prompt, /NOT go hunting for them on the filesystem/)
  // v20: bounded onboarding then STOP and WAIT for the user's own thoughts
  assert.match(prompt, /BOUNDED ONBOARDING, THEN STOP AND WAIT FOR THE USER/)
  assert.match(prompt, /Do NOT propose a joint plan/)
  assert.match(prompt, /WAIT for their reply/)
  assert.match(prompt, /A new user message is the user's own thought/)
})

test('coordinate-hub: -- note hands the user thoughts to the coordinator in the same command (v21)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, steer(msg) { steered.push(msg) }, followup() {} }
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup() {} },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup() {} },
  }
  const agents = { get(id) { return sessions[id] || (id === 's-hub' ? hub : undefined) } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'coordinate-hub')
  const result = await cmd.handler({ agent: hub, rawInput: 's-front s-back -- 先对齐范围再动手，重点是接口契约', commandId: 'c86', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /s-front, s-back/)
  assert.match(result.text, /Your thoughts recorded/)
  const prompt = steered[0].content ? steered[0].content.map((c) => c.text).join(' ') : String(steered[0])
  assert.match(prompt, /THE USER'S THOUGHTS/)
  assert.match(prompt, /先对齐范围再动手，重点是接口契约/)
  // with a note: propose a plan folding it in, then ASK for confirmation
  assert.match(prompt, /FOLDS IN the user's thoughts/)
  assert.match(prompt, /ASK the user to confirm or adjust/)
})

test('coordinate-hub: without a note the onboarding asks the user what they want (v21)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const hub = { id: 's-hub', session: { id: 's-hub', events: [] }, steer(msg) { steered.push(msg) }, followup() {} }
  const sessions = {
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup() {} },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup() {} },
  }
  const agents = { get(id) { return sessions[id] || (id === 's-hub' ? hub : undefined) } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'coordinate-hub')
  const result = await cmd.handler({ agent: hub, rawInput: 's-front s-back', commandId: 'c87', signal: undefined })
  assert.equal(result.kind, 'success', result.text)
  const prompt = steered[0].content ? steered[0].content.map((c) => c.text).join(' ') : String(steered[0])
  assert.match(prompt, /ASK them what they want/)
  assert.match(prompt, /what to coordinate, what to prioritize/)
  assert.match(prompt, /Do NOT propose a joint plan/)
  // no USER'S THOUGHTS block when no note was given
  assert.doesNotMatch(prompt, /THE USER'S THOUGHTS/)
})

test('coordinate-intake: relays the status-sync question to every spoke (v13)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const received = []
  const sessions = {
    's-hub': { id: 's-hub', session: { id: 's-hub', events: [] }, steer() {}, followup() {} },
    's-front': { id: 's-front', session: { id: 's-front', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-front', text: msg.content[0].text }) } },
    's-back': { id: 's-back', session: { id: 's-back', events: [] }, followup(msg) { if (msg.source && msg.source.kind === 'continuity-coord') received.push({ to: 's-back', text: msg.content[0].text }) } },
  }
  const agents = { get(id) { return sessions[id] } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; if (name === 'agents') return agents; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const hubCmd = defs.find((d) => d.name === 'coordinate-hub')
  await hubCmd.handler({ agent: sessions['s-hub'], rawInput: 's-front s-back', commandId: 'c77', signal: undefined })
  const intake = defs.find((d) => d.name === 'coordinate-intake')
  assert.ok(intake, 'coordinate-intake command registered')
  const out = await intake.handler({ agent: sessions['s-hub'], rawInput: '', commandId: 'c78', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.equal(received.length, 2, JSON.stringify(received))
  assert.match(received[0].text, /协调者发起状态同步/)
  assert.match(received[0].text, /遇到的问题/)
  // not a hub → honest error
  const out2 = await intake.handler({ agent: sessions['s-front'], rawInput: '', commandId: 'c79', signal: undefined })
  assert.equal(out2.kind, 'error')
  assert.match(out2.text, /not a coordination hub/)
})

test('pace: /pace steers a pace-check reflection into the session (v14)', async () => {
  const defs = []
  const commands = { register(def) { defs.push(def); return () => {} } }
  const steered = []
  const agent = { id: 's-long', session: { id: 's-long', events: [] }, steer(msg) { steered.push(msg) } }
  const ctx = {
    get(name) { if (name === 'commands') return commands; return undefined },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, {})
  const cmd = defs.find((d) => d.name === 'pace')
  assert.ok(cmd, 'pace command registered')
  const out = cmd.handler({ agent, rawInput: '', commandId: 'c80', signal: undefined })
  assert.equal(out.kind, 'success', out.text)
  assert.equal(steered.length, 1)
  const text = steered[0].content ? steered[0].content.map((c) => c.text).join(' ') : String(steered[0])
  assert.match(text, /Pace check/)
  assert.match(text, /fastest reasonable one/)
  assert.match(text, /scope still right/)
})

test('pace: paceDue gate fires only after the first threshold and respects the interval (v14)', () => {
  const cfg = { paceCheckMinutes: 30, paceCheckIntervalMin: 20 }
  const now = 1_800_000_000_000
  // no record → never due (first sight arms the timer)
  assert.equal(paceDue(null, cfg, now), false)
  assert.equal(paceDue({ firstSeenAt: null, lastCheckAt: null }, cfg, now), false)
  // before the first threshold → not due
  assert.equal(paceDue({ firstSeenAt: now - 10 * 60000, lastCheckAt: null }, cfg, now), false)
  // after the first threshold → due
  assert.equal(paceDue({ firstSeenAt: now - 31 * 60000, lastCheckAt: null }, cfg, now), true)
  // after a recent check → not due
  assert.equal(paceDue({ firstSeenAt: now - 60 * 60000, lastCheckAt: now - 5 * 60000 }, cfg, now), false)
  // interval elapsed → due again
  assert.equal(paceDue({ firstSeenAt: now - 60 * 60000, lastCheckAt: now - 25 * 60000 }, cfg, now), true)
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
  // v25: the roles section carries the new human-facing mode name
  assert.match(sections[0].text, /## Orchestra roles（乐团模式）/)
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

test('wiring: roles section carries the forward-marker protocol when configured (v29)', async () => {
  const sections = []
  const commands = { register() { return () => {} } }
  const systemPrompt = { section(entry) { sections.push(entry); return () => {} } }
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'systemPrompt') return systemPrompt
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx, { coordinateForwardMarker: '请coordinate以下消息' })
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /forward marker protocol/)
  assert.match(sections[0].text, /请coordinate以下消息/)
  assert.match(sections[0].text, /When you FINISH a task/)
  // without the marker configured the line is absent
  const sections2 = []
  const systemPrompt2 = { section(entry) { sections2.push(entry); return () => {} } }
  const ctx2 = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'systemPrompt') return systemPrompt2
      return undefined
    },
    on() {}, effect(fn) { fn() },
  }
  continuityPlugin(ctx2, {})
  assert.equal(sections2.length, 1)
  assert.doesNotMatch(sections2[0].text, /forward marker protocol/)
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
