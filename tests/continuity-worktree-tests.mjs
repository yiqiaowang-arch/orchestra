/**
 * Unit tests for the host-side continuity-worktree driver (v3).
 * Covers the pure helpers, the command surface, and the P0 error paths:
 * idempotent re-entry, partial-success rollback, approval-reject (no
 * half-artifact), non-Git classification, and cancel semantics.
 * Run with: node continuity-worktree-tests.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { MISSION_MARKER as SHARED_MISSION_MARKER } from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-shared.v1.mjs'
import {
  SERVICE,
  MISSION_MARKER,
  sanitizeWorktreeConfig,
  slugify,
  worktreePlan,
  authorizationDecision,
  buildWorkerPrompt,
  extractWorkerReport,
  classifyGitProbe,
  isWorktreeConflict,
  approvalOutcomeOfAnswer,
} from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-worktree.v8.mjs'
import continuityWorktree from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-worktree.v8.mjs'

let passed = 0
let failed = 0
const pending = []
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => { passed += 1; console.log('ok  - ' + name) },
    (error) => { failed += 1; console.error('FAIL- ' + name); console.error('      ' + ((error && error.message) || String(error))) },
  ))
}

// ── test doubles ────────────────────────────────────────────────────────────
function mockCtx(services = {}) {
  const provided = {}
  return {
    provided,
    get(name) { return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined },
    on() {},
    provide(name, value) { provided[name] = value },
  }
}

function instantiate(services = {}, config = {}) {
  const ctx = mockCtx(services)
  continuityWorktree(ctx, config)
  return { ctx, svc: ctx.provided[SERVICE] }
}

function coordinator(cwd) {
  return { id: 'coord', session: { header: { cwd }, events: [] } }
}

function fakeSubprocess(responder) {
  const calls = []
  return {
    calls,
    spawn({ argv }) {
      const joined = argv.join(' ')
      calls.push(joined)
      const resp = (typeof responder === 'function' ? responder(joined, argv) : undefined) || { exitCode: 0, stdout: '', stderr: '' }
      return {
        done: Promise.resolve({ exitCode: resp.exitCode }),
        collected: {
          stdout: { readFrom: () => ({ text: resp.stdout || '' }) },
          stderr: { readFrom: () => ({ text: resp.stderr || '' }) },
        },
      }
    },
  }
}

function gitResponder({ revParse, worktreeAdd, worktreeRemove, branchD } = {}) {
  return (joined) => {
    if (joined.includes('rev-parse')) return revParse || { exitCode: 0, stdout: 'true', stderr: '' }
    if (joined.includes('worktree') && joined.includes('add')) return worktreeAdd || { exitCode: 0, stdout: '', stderr: '' }
    if (joined.includes('worktree') && joined.includes('remove')) return worktreeRemove || { exitCode: 0, stdout: '', stderr: '' }
    if (joined.includes('branch') && joined.includes('-d')) return branchD || { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

const NON_GIT_PROBE = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }

function fakeAgents({ createThrows } = {}) {
  const map = new Map()
  return {
    map,
    async create({ sessionId, meta, setup }) {
      if (createThrows) throw createThrows
      const worker = {
        id: sessionId,
        session: { id: sessionId, header: { cwd: meta.cwd }, events: [], append() {} },
        followup() {},
        cancel() {},
        status: 'idle',
      }
      map.set(sessionId, worker)
      if (setup) await setup({ on() {} })
      return worker
    },
    get(id) { return map.get(id) },
  }
}

function fakeWorkspace({ id, path, title, sessionIds = [], attachError, detachError } = {}) {
  const record = {
    id: id || 'ws-1',
    path,
    title: title || 't',
    sessionIds: [...sessionIds],
    async attachSession(sid) {
      if (attachError) throw attachError
      record.sessionIds = [sid, ...record.sessionIds.filter((s) => s !== sid)]
    },
    async detachSession(sid) {
      if (detachError) throw detachError
      record.sessionIds = record.sessionIds.filter((s) => s !== sid)
    },
  }
  return record
}

function fakeWorkspaceRegistry({ workspaces = [] } = {}) {
  return {
    list: () => workspaces.slice(),
    async resolveByPath(path) { return workspaces.find((w) => w.path === path) },
    async create(path, title) {
      const existing = workspaces.find((w) => w.path === path)
      if (existing) return existing
      const record = fakeWorkspace({ id: 'ws-' + (workspaces.length + 1), path, title })
      workspaces.push(record)
      return record
    },
    get(id) { return workspaces.find((w) => w.id === id) },
    async delete(id) {
      const idx = workspaces.findIndex((w) => w.id === id)
      if (idx < 0) return false
      workspaces.splice(idx, 1)
      return true
    },
  }
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'))
  const done = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(done)
}

const modelService = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
const allowApproval = { overrideOf: () => 'never' }

// ── pure helpers (existing) ─────────────────────────────────────────────────
test('MISSION_MARKER is the shared single source (v7)', () => {
  assert.equal(MISSION_MARKER, SHARED_MISSION_MARKER)
  assert.equal(MISSION_MARKER, '<!-- DSH_MISSION v1 -->')
})

test('config defaults and clamping', () => {
  const cfg = sanitizeWorktreeConfig({})
  assert.equal(cfg.askApproval, true)
  assert.equal(cfg.worktreeParent, null)
  assert.equal(cfg.reportCapChars, 8000)
  assert.equal(cfg.worktreeMarker, '-wt-')
  assert.equal(cfg.notifyWorkerDone, true)
  assert.equal(cfg.forwardWorkerApprovals, true)
  assert.equal(cfg.approvalForwardTimeoutMs, 120000)
  const off = sanitizeWorktreeConfig({ askApproval: false, reportCapChars: 10, worktreeParent: 'C:\\work', notifyWorkerDone: false, forwardWorkerApprovals: false, approvalForwardTimeoutMs: 1000 })
  assert.equal(off.askApproval, false)
  assert.equal(off.reportCapChars, 1000)
  assert.equal(off.worktreeParent, 'C:\\work')
  assert.equal(off.notifyWorkerDone, false)
  assert.equal(off.forwardWorkerApprovals, false)
  assert.equal(off.approvalForwardTimeoutMs, 5000)
})

test('approvalOutcomeOfAnswer maps the coordinator card choice', () => {
  assert.equal(approvalOutcomeOfAnswer({ answers: [{ id: 'q', selected: ['批准（allowed-once）'] }] }), 'allowed-once')
  assert.equal(approvalOutcomeOfAnswer({ answers: [{ id: 'q', selected: ['拒绝'] }] }), 'rejected')
  assert.equal(approvalOutcomeOfAnswer({ answers: [{ id: 'q', selected: [] }] }), null)
  assert.equal(approvalOutcomeOfAnswer({ answers: [] }), null)
  assert.equal(approvalOutcomeOfAnswer(null), null)
  assert.equal(approvalOutcomeOfAnswer(undefined), null)
})

test('slugify produces stable branch slugs', () => {
  assert.equal(slugify('Build the API Client'), 'build-the-api-client')
  assert.equal(slugify('  修复登录 Bug!!'), '修复登录-bug')
  assert.equal(slugify('   !!!   '), null)
  assert.ok(slugify('a-very-long-title-that-keeps-going').length <= 24)
})

test('worktreePlan places the worktree beside the workspace with a distinct name', () => {
  const plan = worktreePlan('C:\\repo\\main', 'feature-x', null)
  assert.equal(plan.parent, 'C:\\repo')
  assert.equal(plan.path, 'C:\\repo\\main-wt-feature-x')
  assert.equal(plan.branch, 'feature-x')
  const overridden = worktreePlan('C:\\repo\\main', 'f', 'D:\\trees')
  assert.equal(overridden.path, 'D:\\trees\\main-wt-f')
  const nullSlug = worktreePlan('C:\\repo\\main', null, null)
  assert.equal(nullSlug.path, 'C:\\repo\\main-wt-worker')
})

test('authorizationDecision gates on policy', () => {
  assert.equal(authorizationDecision(true, 'ask'), 'ask')
  assert.equal(authorizationDecision(true, 'never'), 'allow')
  assert.equal(authorizationDecision(true, undefined), 'ask')
  assert.equal(authorizationDecision(false, 'ask'), 'allow')
})

test('worker prompt carries role, workspace, task and discipline', () => {
  const prompt = buildWorkerPrompt({
    coordinatorId: 'session-coord',
    worktreePath: 'C:\\repo\\main-wt-x',
    git: true,
    branch: 'x',
    brief: 'write the parser',
  })
  assert.match(prompt, /session-coord/)
  assert.match(prompt, /C:\\repo\\main-wt-x/)
  assert.match(prompt, /branch x/)
  assert.match(prompt, /write the parser/)
  assert.match(prompt, /## Worker report/)
  assert.match(prompt, /Never run \/rotate/)
})

test('worker prompt states Git facts honestly for non-Git workspaces', () => {
  const prompt = buildWorkerPrompt({ coordinatorId: 'c', worktreePath: 'D:\\x', git: false, branch: 'b', brief: 't' })
  assert.match(prompt, /not a Git repository/)
  assert.match(prompt, /Git facts are not applicable/)
})

test('extractWorkerReport pulls the newest assistant text and checkpoint facts', () => {
  const snapshot = {
    session: { id: 'w' },
    events: [
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'old' }] } } },
      { type: 'user/message', seq: 2, data: { content: [] } },
      { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: '<!-- DSH_CONTINUITY_CHECKPOINT v1 -->\n## Current objective\nx\n## Workspace/repository state\nx\n## Completed\nx\n## Decisions and invariants\nx\n## Files changed\nx\n## Verification\nx\n## Open problems\nx\n## Next atomic action\nrun tests' }] } } },
      { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '## Worker report\nDone.' }] } } },
    ],
  }
  const extracted = extractWorkerReport(snapshot, 8000)
  assert.match(extracted.tail, /## Worker report/)
  assert.equal(extracted.hasCheckpoint, true)
  assert.equal(extracted.lastSeq, 4)
  const empty = extractWorkerReport({ session: {}, events: [] }, 8000)
  assert.equal(empty.tail, null)
  assert.equal(empty.hasCheckpoint, false)
})

test('wiring: publishes the service with the full command surface', () => {
  const provided = {}
  const ctx = { get() { return undefined }, on() {}, provide(name, value) { provided[name] = value } }
  continuityWorktree(ctx, {})
  assert.equal(typeof provided[SERVICE], 'object')
  for (const method of ['spawn', 'spawnWorker', 'list', 'send', 'stop', 'cleanup', 'report', 'mission']) {
    assert.equal(typeof provided[SERVICE][method], 'function', method)
  }
})

test('wiring: notifyWorkerDone (default on) registers a session/event listener; disabled does not', () => {
  const registeredOn = []
  const ctx1 = { get() { return undefined }, on(event, listener) { registeredOn.push([event, listener]) }, provide() {} }
  continuityWorktree(ctx1, {})
  assert.ok(registeredOn.some(([event]) => event === 'session/event'), 'default registers session/event')

  const registeredOff = []
  const ctx2 = { get() { return undefined }, on(event, listener) { registeredOff.push([event, listener]) }, provide() {} }
  continuityWorktree(ctx2, { notifyWorkerDone: false })
  assert.ok(!registeredOff.some(([event]) => event === 'session/event'), 'notifyWorkerDone:false registers no session/event')
})

test('spawnWorker returns structured errors for missing cwd and structured success shape is exercised', async () => {
  const provided = {}
  const ctx = { get() { return undefined }, on() {}, provide(name, value) { provided[name] = value } }
  continuityWorktree(ctx, {})
  const coordinator = { id: 'c', session: { header: {}, events: [] } }
  const result = await provided[SERVICE].spawnWorker(coordinator, { brief: 'do things' })
  assert.equal(result.ok, false)
  assert.match(result.error, /no workspace cwd/)
})

test('spawn rejects when the coordinator has no workspace cwd (no side effects)', async () => {
  const provided = {}
  const ctx = { get() { return undefined }, on() {}, provide(name, value) { provided[name] = value } }
  continuityWorktree(ctx, {})
  const coordinator = { id: 'c', session: { header: {}, events: [] } }
  const result = await provided[SERVICE].spawn(coordinator, { brief: 'do things' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /no workspace cwd/)
})

test('spawn asks approval when the session policy is not never (gate holds)', async () => {
  const requested = []
  const provided = {}
  const ctx = {
    get(name) {
      if (name === 'approval') {
        return {
          overrideOf() { return 'ask' },
          async request(req) { requested.push(req.reason); return 'rejected' },
        }
      }
      if (name === 'subprocess') return undefined
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    on() {},
    provide(name, value) { provided[name] = value },
  }
  continuityWorktree(ctx, {})
  const coordinator = { id: 'c', session: { header: { cwd: 'C:\\work\\repo' }, events: [] } }
  const result = await provided[SERVICE].spawn(coordinator, { brief: 'do things' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not authorized/)
  assert.equal(requested.length, 1)
})

// ── new pure helpers ────────────────────────────────────────────────────────
test('classifyGitProbe distinguishes git, clean non-git, and git failure', () => {
  assert.deepEqual(classifyGitProbe({ ok: true, exitCode: 0, out: 'true', err: '' }), { kind: 'git' })
  assert.equal(classifyGitProbe({ ok: true, exitCode: 0, out: 'false', err: '' }).kind, 'nonGit')
  assert.equal(classifyGitProbe({ ok: false, exitCode: 128, out: '', err: 'fatal: not a git repository (or any of the parent directories): .git' }).kind, 'nonGit')
  const unavailable = classifyGitProbe({ ok: false, exitCode: null, out: '', err: 'subprocess service unavailable' })
  assert.equal(unavailable.kind, 'error')
  assert.match(unavailable.detail, /subprocess service unavailable/)
  const missing = classifyGitProbe({ ok: false, exitCode: 127, out: '', err: 'spawn git ENOENT' })
  assert.equal(missing.kind, 'error')
})

test('isWorktreeConflict detects git idempotency/conflict text', () => {
  assert.equal(isWorktreeConflict("fatal: a branch named 'exists' already exists"), true)
  assert.equal(isWorktreeConflict("fatal: 'C:/x/y' already exists"), true)
  assert.equal(isWorktreeConflict('Preparing worktree (new branch x)'), false)
  assert.equal(isWorktreeConflict(''), false)
  assert.equal(isWorktreeConflict(undefined), false)
})

// ── error paths ─────────────────────────────────────────────────────────────
test('idempotent re-entry: pre-existing directory returns a clear error with no git call', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('same task'), null)
    mkdirSync(plan.path, { recursive: true }) // simulate a prior /worktree
    const subprocess = fakeSubprocess(gitResponder())
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'same task' })
    assert.equal(result.ok, false)
    assert.match(result.error, /already exists/)
    assert.equal(result.partial.worktreeCreated, false)
    assert.equal(subprocess.calls.length, 0, 'no git command may run once the target exists')
  })
})

test('idempotent re-entry: existing branch detected from git worktree add conflict', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const subprocess = fakeSubprocess(gitResponder({
      revParse: { exitCode: 0, stdout: 'true', stderr: '' },
      worktreeAdd: { exitCode: 255, stdout: '', stderr: "fatal: a branch named 'same-task' already exists" },
    }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'same task' })
    assert.equal(result.ok, false)
    assert.match(result.error, /already exists/)
    assert.equal(result.partial.worktreeCreated, false)
    assert.equal(subprocess.calls.filter((c) => c.includes('worktree') && c.includes('add')).length, 1)
    assert.equal(subprocess.calls.filter((c) => c.includes('worktree') && c.includes('remove')).length, 0, 'conflict must not trigger a remove')
  })
})

test('non-Git workspace spawns a plain sibling directory with an honest note', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('build api'), null)
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'build api' })
    assert.equal(result.ok, true)
    assert.equal(result.git, false)
    assert.equal(result.path, plan.path)
    assert.ok(existsSync(join(plan.path, 'README.md')))
    assert.match(readFileSync(join(plan.path, 'README.md'), 'utf8'), /not a Git repository/)
  })
})

test('git probe failure is a clear error, never a silent plain-directory fallback', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('probe fail'), null)
    const subprocess = fakeSubprocess(gitResponder({ revParse: { exitCode: 127, stdout: '', stderr: 'spawn git ENOENT' } }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'probe fail' })
    assert.equal(result.ok, false)
    assert.match(result.error, /Could not determine the repository state/)
    assert.equal(existsSync(plan.path), false, 'no workspace may be created on a git failure')
  })
})

test('partial success (non-Git): worktree rolled back when worker creation throws', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('rollback me'), null)
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents({ createThrows: new Error('boom') }) })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'rollback me' })
    assert.equal(result.ok, false)
    assert.match(result.error, /boom/)
    assert.equal(result.partial.worktreeCreated, true)
    assert.equal(result.partial.worktreeRolledBack, true)
    assert.equal(existsSync(plan.path), false, 'the plain directory must be rolled back')
  })
})

test('partial success (Git): worktree remove + branch drop on worker-creation failure', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const subprocess = fakeSubprocess(gitResponder({
      revParse: { exitCode: 0, stdout: 'true', stderr: '' },
      worktreeAdd: { exitCode: 0, stdout: '', stderr: '' },
      worktreeRemove: { exitCode: 0, stdout: '', stderr: '' },
      branchD: { exitCode: 0, stdout: '', stderr: '' },
    }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents({ createThrows: new Error('boom') }) })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'rollback git' })
    assert.equal(result.ok, false)
    assert.equal(result.partial.worktreeCreated, true)
    assert.equal(result.partial.worktreeRolledBack, true)
    assert.ok(subprocess.calls.some((c) => c.includes('worktree') && c.includes('remove')), 'git worktree remove must be invoked')
    assert.ok(subprocess.calls.some((c) => c.includes('branch') && c.includes('-d')), 'git branch -d must be invoked')
    assert.equal(subprocess.calls.some((c) => c.includes('branch') && c.includes('-D')), false, 'never force-delete a branch')
  })
})

test('approval reject: clear error, no worktree, no git call (no half-artifact)', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('gated task'), null)
    const subprocess = fakeSubprocess(gitResponder())
    const approval = {
      overrideOf() { return 'ask' },
      async request() { return 'rejected' },
    }
    const { svc } = instantiate({ subprocess, approval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'gated task' })
    assert.equal(result.ok, false)
    assert.match(result.error, /not authorized/)
    assert.equal(existsSync(plan.path), false, 'no worktree may be created on rejection')
    assert.equal(subprocess.calls.length, 0, 'no git command may run on rejection')
  })
})

test('approval gate is strictly allowed-once: an unrelated outcome is rejected', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const approval = { overrideOf() { return 'ask' }, async request() { return 'allowed' } }
    const { svc } = instantiate({ subprocess, approval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'gated task' })
    assert.equal(result.ok, false)
    assert.match(result.error, /not authorized/)
  })
})

test('approval gate passes with allowed-once and proceeds once', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    let requests = 0
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const approval = { overrideOf() { return 'ask' }, async request() { requests += 1; return 'allowed-once' } }
    const { svc } = instantiate({ subprocess, approval, agentDefaultModel: modelService, agents: fakeAgents() })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'gated task' })
    assert.equal(result.ok, true)
    assert.equal(requests, 1)
  })
})

test('cancel semantics: stop cancels a live worker and never auto-cleans its worktree', async () => {
  const cancelled = []
  const agents = {
    get(id) {
      if (id === 'w1') {
        return { session: { header: { cwd: 'C:\\x\\ws-wt-f' } }, cancel(kind) { cancelled.push(kind) } }
      }
      return undefined
    },
  }
  const { svc } = instantiate({ agents })
  const result = await svc.stop({ id: 'coord' }, 'w1')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /left in place/)
  assert.match(result.text, /human decision/)
  assert.deepEqual(cancelled, [{ kind: 'parent' }])
  const missing = await svc.stop({ id: 'coord' }, 'nope')
  assert.equal(missing.kind, 'success')
  assert.match(missing.text, /nothing to stop/)
})

test('stop detaches the stopped worker from its workspace group', async () => {
  const cancelled = []
  const detached = []
  const ws = { id: 'ws-1', path: 'C:\\x\\ws-wt-f', async detachSession(sid) { detached.push(sid) } }
  const agents = {
    get(id) {
      if (id === 'w-worker') {
        return { session: { header: { cwd: 'C:\\x\\ws-wt-f' } }, cancel(kind) { cancelled.push(kind) } }
      }
      return undefined
    },
  }
  const reg = { async resolveByPath(path) { return path === 'C:\\x\\ws-wt-f' ? ws : undefined } }
  const { svc } = instantiate({ agents, workspaceRegistry: reg })
  const result = await svc.stop({ id: 'coord' }, 'w-worker')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Detached from its workspace group/)
  assert.deepEqual(cancelled, [{ kind: 'parent' }])
  assert.deepEqual(detached, ['w-worker'])
})

test('spawn attaches the worker session to its workspace record (GUI grouping)', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('attach ok'), null)
    const reg = fakeWorkspaceRegistry()
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents(), workspaceRegistry: reg })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'attach ok' })
    assert.equal(result.ok, true)
    assert.equal(result.attached, true)
    assert.equal(result.attachError, null)
    const ws = await reg.resolveByPath(plan.path)
    assert.ok(ws, 'workspace record must be registered')
    assert.ok(ws.sessionIds.includes(result.workerId), 'worker session must be attached')
  })
})

test('attach is idempotent: a worker session is accounted exactly once', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('attach idem'), null)
    const reg = fakeWorkspaceRegistry()
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents: fakeAgents(), workspaceRegistry: reg })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'attach idem' })
    assert.equal(result.attached, true)
    const ws = await reg.resolveByPath(plan.path)
    assert.equal(ws.sessionIds.filter((s) => s === result.workerId).length, 1, 'spawn attaches the worker exactly once')
    await ws.attachSession(result.workerId) // harness attach is idempotent
    assert.equal(ws.sessionIds.filter((s) => s === result.workerId).length, 1, 're-attach must not duplicate the session')
  })
})

test('attach failure is a partial success: worker runs but not grouped, no rollback', async () => {
  await withTemp(async (dir) => {
    const workspace = join(dir, 'ws')
    mkdirSync(workspace)
    const plan = worktreePlan(workspace, slugify('attach fail'), null)
    const ws = fakeWorkspace({ id: 'ws-x', path: plan.path, title: 't', attachError: new Error('attach boom') })
    const reg = fakeWorkspaceRegistry({ workspaces: [ws] })
    const subprocess = fakeSubprocess(gitResponder({ revParse: NON_GIT_PROBE }))
    const agents = fakeAgents()
    const { svc } = instantiate({ subprocess, approval: allowApproval, agentDefaultModel: modelService, agents, workspaceRegistry: reg })
    const result = await svc.spawnWorker(coordinator(workspace), { brief: 'attach fail' })
    assert.equal(result.ok, true)
    assert.equal(result.attached, false)
    assert.match(result.attachError, /attach boom/)
    assert.ok(agents.get(result.workerId), 'worker must still exist (no rollback on attach failure)')
    assert.ok(existsSync(plan.path), 'worktree must not be rolled back on attach failure')
  })
})

test('cleanup --dry-run lists temporary worktree workspaces without deleting', async () => {
  const settled = fakeWorkspace({ id: 'w1', path: 'C:\\repo\\main-wt-alpha', sessionIds: ['s-alpha'] })
  const liveWs = fakeWorkspace({ id: 'w2', path: 'C:\\repo\\main-wt-beta', sessionIds: ['s-beta'] })
  const ordinary = fakeWorkspace({ id: 'w3', path: 'C:\\other\\ordinary', sessionIds: ['s-main'] })
  const reg = fakeWorkspaceRegistry({ workspaces: [settled, liveWs, ordinary] })
  const agents = { get: (id) => (id === 's-beta' ? { status: 'idle' } : undefined) }
  const { svc } = instantiate({ workspaceRegistry: reg, agents })
  const result = await svc.cleanup({ id: 'c' }, '--dry-run')
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('main-wt-alpha'))
  assert.ok(result.text.includes('main-wt-beta'))
  assert.ok(result.text.includes('s-alpha'))
  assert.ok(result.text.includes('s-beta'))
  assert.ok(!result.text.includes('ordinary'), 'non-worktree workspace must not be listed')
  assert.equal(reg.list().length, 3, 'dry-run must not delete anything')
})

test('cleanup --confirm detaches settled workers, deletes their records, skips live', async () => {
  const settled = fakeWorkspace({ id: 'w1', path: 'C:\\repo\\main-wt-alpha', sessionIds: ['s-alpha'] })
  const detached = []
  const origDetach = settled.detachSession.bind(settled)
  settled.detachSession = async (sid) => { detached.push(sid); return origDetach(sid) }
  const liveWs = fakeWorkspace({ id: 'w2', path: 'C:\\repo\\main-wt-beta', sessionIds: ['s-beta'] })
  const reg = fakeWorkspaceRegistry({ workspaces: [settled, liveWs] })
  const agents = { get: (id) => (id === 's-beta' ? { status: 'idle' } : undefined) }
  const { svc } = instantiate({ workspaceRegistry: reg, agents })
  const result = await svc.cleanup({ id: 'c' }, '--confirm')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /removed 1 record/)
  assert.match(result.text, /skipped 1/)
  assert.deepEqual(detached, ['s-alpha'], 'settled worker must be detached before delete')
  assert.equal(reg.get('w1'), undefined, 'settled workspace record deleted')
  assert.ok(reg.get('w2'), 'live workspace record kept')
  assert.deepEqual(reg.get('w2').sessionIds, ['s-beta'], 'live session untouched')
})

await Promise.all(pending)
console.log('')
console.log('passed: ' + passed + ', failed: ' + failed)
if (failed > 0) process.exitCode = 1
