/**
 * continuity-rotation — host-plane rollover driver (V4 design, Phase A).
 *
 * User-owned host component installed through the active profile's user patch
 * layer (`$DSH_HOME/profiles/web/cordis.patch.yml`). It publishes the plain
 * service `continuityRotation` that the `continuity` preset's `/rotate`
 * command consumes; session/agent creation stays on this host plane.
 *
 * Zero-import except one absolute file-URL import of the preset companion's
 * PURE helpers (single source of truth for the checkpoint format).
 *
 * Behavior:
 * - suggest mode (default): ratio >= rotateRatio marks the session as
 *   "rotation suggested"; the preset's /continuity shows it and /rotate
 *   executes the rollover (an explicit /rotate is always a confirmation).
 * - auto mode (opt-in via the row config): at a SAFE boundary
 *   (agent/turn-stopping or idle), a root continuity session past the
 *   threshold rolls over automatically, with cooldown and history guards.
 * - The rollover itself: ensure a durable valid checkpoint (reusing the
 *   preset's /handoff machinery), create a fresh blank session in the same
 *   workspace on the same preset, inject the bounded snapshot BEFORE the
 *   waking instruction, and wake it to perform only the checkpoint's next
 *   atomic action. The old session stays alive by default.
 *
 * v4 (this generation):
 * - the per-boundary tick and suggest/observe paths fold session events into an
 *   incremental cache (cursor `lastScanSeq`) instead of re-scanning the log, so
 *   the hot path is O(new events) with identical decision semantics;
 * - repeated /rotate is idempotent (a rollover already produced for an
 *   unchanged log is not re-created) and a partial success (new session
 *   created but waking it failed) is reported honestly instead of claiming the
 *   old session was untouched;
 * - the checkpoint waiter cleans itself up on timeout/abort and honors an
 *   already-aborted signal;
 * - adds `rotateSuccessor` (P2): a coordinator spawns a successor worker that
 *   inherits a worker's durable checkpoint + remaining instruction. Opt-in and
 *   explicit only — a worker never rotates itself and nothing here auto-rotates
 *   a worker.
 */
import {
  MARKER,
  validateCheckpoint,
  userMessage,
  capText,
  textOfMessage,
  buildInstruction,
} from 'file:///C:/Users/<USER>/.dsh/continuity-host/continuity-shared.v1.mjs'

export const SERVICE = 'continuityRotation'

const DEFAULTS = Object.freeze({
  rotateRatio: 0.78,
  autoRollover: 'suggest', // off | suggest | auto
  maxWaitMs: 300000,
  cooldownMs: 300000,
  oldSession: 'keep', // keep | archive
})

/** Clamp and default the row config. */
export function sanitizeRotationConfig(raw) {
  const src = (raw !== null && typeof raw === 'object') ? raw : {}
  const num = (value, fallback, lo, hi) =>
    (typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi) ? value : fallback
  const intInRange = (value, fallback, lo, hi) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(hi, Math.max(lo, Math.trunc(value)))
  }
  const mode = src.autoRollover === 'auto' || src.autoRollover === 'off' ? src.autoRollover : DEFAULTS.autoRollover
  return {
    rotateRatio: num(src.rotateRatio, DEFAULTS.rotateRatio, 0, 1),
    autoRollover: mode,
    maxWaitMs: intInRange(src.maxWaitMs, DEFAULTS.maxWaitMs, 1000, 3600000),
    cooldownMs: intInRange(src.cooldownMs, DEFAULTS.cooldownMs, 0, 3600000),
    oldSession: src.oldSession === 'archive' ? 'archive' : DEFAULTS.oldSession,
  }
}

/**
 * Pure decision for one observation.
 * facts: { ratio (null when capacity unknown), capacityKnown, rotating,
 *          cooldownElapsed, hasHistory, mode }
 * returns 'busy' | 'none' | 'suggest' | 'auto'
 */
export function decide(config, facts) {
  if (facts.rotating) return 'busy'
  if (!facts.capacityKnown || facts.ratio === null) return 'none'
  if (facts.ratio < config.rotateRatio) return 'none'
  if (facts.mode === 'off') return 'suggest'
  if (facts.mode === 'auto') {
    if (!facts.cooldownElapsed || !facts.hasHistory) return 'suggest'
    return 'auto'
  }
  return 'suggest'
}

/**
 * Incremental per-session event cache for the rotation driver. The pure folder
 * keeps the per-boundary hot paths O(new events): `lastScanSeq` is the cursor,
 * and each derived fact (assistant count, last user seq, context window, newest
 * marker checkpoint) folds every appended event exactly once. Semantics match
 * the v3 full scans under the append-only ascending-seq invariant.
 */
export function freshRotationCache() {
  return {
    lastScanSeq: 0,
    assistantCount: 0,
    lastUserSeq: null,
    lastContextWindow: null, // newest request/context window, or null
    lastMarkerCheckpoint: null, // { seq, valid } of the newest marker message
  }
}

/** Clear every derived field back to the baseline (cursor kept). */
export function resetRotationCache(cache) {
  const cursor = cache.lastScanSeq
  Object.assign(cache, freshRotationCache())
  cache.lastScanSeq = cursor
  return cache
}

/** Fold one event into the rotation cache (mutates in place). */
export function foldRotationEvent(cache, event) {
  if (event === null || event === undefined) return cache
  const seq = event.seq
  if (event.type === 'assistant/message') {
    cache.assistantCount += 1
    const text = textOfMessage(event.data && event.data.message)
    if (text.includes(MARKER)) {
      cache.lastMarkerCheckpoint = { seq, valid: validateCheckpoint(text).ok }
    }
  } else if (event.type === 'user/message') {
    if (seq !== undefined && (cache.lastUserSeq === null || seq > cache.lastUserSeq)) cache.lastUserSeq = seq
  } else if (event.type === 'request/context') {
    cache.lastContextWindow = (event.data && Number.isFinite(event.data.contextWindow) && event.data.contextWindow > 0)
      ? event.data.contextWindow
      : null
  }
  if (seq !== undefined && seq > cache.lastScanSeq) cache.lastScanSeq = seq
  return cache
}

/** Fold only events newer than the cursor; full refold fallback when seq is absent. */
export function foldRotationIncremental(cache, events) {
  if (!Array.isArray(events) || events.length === 0) return cache
  const fresh = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const seq = events[index].seq
    if (seq === undefined) {
      resetRotationCache(cache)
      for (const event of events) foldRotationEvent(cache, event)
      return cache
    }
    if (seq <= cache.lastScanSeq) break
    fresh.push(events[index])
  }
  for (let index = fresh.length - 1; index >= 0; index -= 1) foldRotationEvent(cache, fresh[index])
  return cache
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

export default function continuityRotation(ctx, config) {
  const cfg = sanitizeRotationConfig(config)
  const fail = (error) => (error instanceof Error ? error.message : String(error))
  // Lazy reads: patch-inserted rows may apply while sibling/bundle rows are
  // still loading, so apply-time captures would freeze undefined services.
  const get = (name) => ctx.get(name)

  // sessionId -> { rotating, lastRolloverAt, failure, continuationSessionId, rolloverCheckpointSeq }
  const states = new Map()
  // sessionId -> incremental event cache
  const caches = new Map()
  // sessionId -> array of finish(outcome) closures awaiting that session's checkpoint
  const checkpointWaiters = new Map()
  // workerId -> { successorId, checkpointSeq } for successor idempotency
  const successorByWorker = new Map()

  function getState(id) {
    let state = states.get(id)
    if (state === undefined) {
      state = { rotating: false, lastRolloverAt: 0, failure: null, continuationSessionId: null, rolloverCheckpointSeq: null }
      states.set(id, state)
      if (states.size > 512) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
    }
    return state
  }

  /** Incremental event cache: baseline-fold on first use, then fold only new events. */
  function syncCache(session) {
    let cache = caches.get(session.id)
    const events = Array.isArray(session.events) ? session.events : []
    if (cache === undefined) {
      cache = freshRotationCache()
      caches.set(session.id, cache)
      if (caches.size > 512) {
        const oldest = caches.keys().next().value
        if (oldest !== undefined) caches.delete(oldest)
      }
      for (const event of events) foldRotationEvent(cache, event)
      return cache
    }
    return foldRotationIncremental(cache, events)
  }

  /** Newest valid checkpoint from the cache — mirrors the v3 full backward scan. */
  function validCheckpointFromCache(cache) {
    const marker = cache.lastMarkerCheckpoint
    if (marker === null || marker === undefined || !marker.valid) return null
    return { seq: marker.seq }
  }

  /** Full backward scan over a detached event log (used by the successor read). */
  function findValidCheckpoint(log) {
    const events = log && Array.isArray(log.events) ? log.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = textOfMessage(event.data && event.data.message)
      if (!text.includes(MARKER)) continue
      if (validateCheckpoint(text).ok) return { seq: event.seq }
      return null
    }
    return null
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

  /** Pressure observation for one session (reuses the host token meter). */
  function observe(agent) {
    const session = agent.session
    const meter = get('tokenMeter')
    let totalTokens = null
    try {
      if (meter !== undefined) totalTokens = meter.measure(session).totalTokens
    } catch {
      totalTokens = null
    }
    const capacity = syncCache(session).lastContextWindow
    const capacityKnown = typeof capacity === 'number' && capacity > 0
    const ratio = capacityKnown && totalTokens !== null ? totalTokens / capacity : null
    return { totalTokens, capacity, capacityKnown, ratio }
  }

  /** Suggestion view consumed by the preset's /continuity and /rotate. */
  function suggest(agent) {
    const observation = observe(agent)
    const state = getState(agent.id)
    const mode = cfg.autoRollover
    const header = agent.session.header
    const worker = header !== undefined && header.parentSession !== undefined
    let recommendation = decide(cfg, {
      ratio: observation.ratio,
      capacityKnown: observation.capacityKnown,
      rotating: state.rotating,
      cooldownElapsed: Date.now() - state.lastRolloverAt >= cfg.cooldownMs,
      hasHistory: syncCache(agent.session).assistantCount >= 1,
      mode,
    })
    // Workers never auto-rotate (successor rotation is coordinator-driven), so
    // an auto recommendation for a worker is downgraded to a suggest signal.
    if (worker && recommendation === 'auto') recommendation = 'suggest'
    return {
      ratio: observation.ratio,
      capacity: observation.capacity,
      threshold: cfg.rotateRatio,
      mode,
      recommendation, // none | suggest | auto | busy
      rotating: state.rotating,
      failure: state.failure,
      worker,
      successor: worker && recommendation === 'suggest',
    }
  }

  function resolveCheckpointWaiters(sessionId, ok, detail, seq) {
    const waiters = checkpointWaiters.get(sessionId)
    if (waiters === undefined) return
    checkpointWaiters.delete(sessionId)
    for (const finish of waiters) finish({ ok, detail, seq })
  }

  function waitForCheckpoint(sessionId, timeoutMs, signal) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        // Self-removal: neither a timeout, an abort, nor a late event can leak
        // a settled waiter or resolve it twice.
        const waiters = checkpointWaiters.get(sessionId)
        if (waiters !== undefined) {
          const index = waiters.indexOf(finish)
          if (index >= 0) waiters.splice(index, 1)
          if (waiters.length === 0) checkpointWaiters.delete(sessionId)
        }
        resolve(outcome)
      }
      const entry = checkpointWaiters.get(sessionId)
      if (entry !== undefined) entry.push(finish)
      else checkpointWaiters.set(sessionId, [finish])
      const timer = get('timer')
      if (timer !== undefined) {
        void timer.timeout(timeoutMs).then(() => finish({ ok: false, detail: 'timeout' }))
      }
      if (signal !== undefined && signal !== null) {
        try {
          if (signal.aborted) finish({ ok: false, detail: 'aborted' })
          else signal.addEventListener('abort', () => finish({ ok: false, detail: 'aborted' }), { once: true })
        } catch {
          // shimmed signal without listeners: nothing to do
        }
      }
    })
  }

  /** Full rollover. Explicit /rotate calls this; auto mode calls it at safe boundaries. */
  async function rotate(agent, signal) {
    const session = agent.session
    const state = getState(session.id)
    if (state.rotating) {
      return { kind: 'error', text: 'A rollover is already in progress for this session (idempotent).' }
    }
    // Chain guard: a session that is itself a rollover continuation has no
    // rollover need of its own (its context is fresh) — this also stops
    // recursive chains when a checkpoint's next action names /rotate.
    const header = session.header
    if (header !== undefined && header.parentSession !== undefined) {
      return {
        kind: 'error',
        text: 'This session is itself a rollover continuation (parent: ' + String(header.parentSession)
          + '); it does not need another rollover — continue working here, or /handoff first if a new checkpoint is needed.',
      }
    }
    // Idempotency: a rollover already produced for an unchanged log is not
    // re-created (mirrors the preset /handoff "already ready" guard).
    if (state.continuationSessionId !== null) {
      const newestUser = syncCache(session).lastUserSeq
      if (newestUser === null || newestUser <= (state.rolloverCheckpointSeq ?? 0)) {
        return {
          kind: 'success',
          text: 'Already rolled over to continuation session ' + state.continuationSessionId
            + ' (idempotent): no new user work since that checkpoint. Continue in the new session, or add input and run /handoff before another /rotate.',
        }
      }
      state.continuationSessionId = null
      state.rolloverCheckpointSeq = null
    }
    state.rotating = true
    state.failure = null
    // commands.execute requires a real AbortSignal; the auto path has none.
    const sig = signal !== undefined && signal !== null ? signal : new AbortController().signal
    let createdSessionId = null
    try {
      // 1. Durable valid checkpoint (reuse the preset's /handoff machinery).
      let checkpointSeq = null
      const durable = validCheckpointFromCache(syncCache(session))
      if (durable !== null) checkpointSeq = durable.seq
      else {
        const commands = get('commands')
        if (commands === undefined) throw new Error('command registry unavailable')
        await commands.execute(agent, '/handoff', sig)
        const waited = await waitForCheckpoint(session.id, cfg.maxWaitMs, sig)
        if (!waited.ok) {
          state.failure = 'checkpoint not ready: ' + String(waited.detail)
          return {
            kind: 'error',
            text: 'Rollover aborted: the final checkpoint did not become durable in time (' + String(waited.detail) + '). The old session is unchanged.',
          }
        }
        checkpointSeq = typeof waited.seq === 'number' ? waited.seq : null
      }
      // 2. Fresh blank continuation session in the same workspace.
      const agents = get('agents')
      if (agents === undefined) throw new Error('agent registry unavailable')
      const cwd = (session.header && session.header.cwd) || undefined
      const selection = modelSelectionFor(session)
      if (selection === undefined) throw new Error('no model route for the continuation session')
      const newId = 'session-cont-rotate-' + Date.now().toString(36)
      const ref = { current: selection, assembled: undefined }
      const handle = await agents.create({
        sessionId: newId,
        meta: {
          ...(cwd === undefined ? {} : { cwd }),
          agentPreset: 'continuity',
          parentSession: session.id,
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, ref)
          const presets = get('agentPresets')
          if (presets !== undefined) await presets.mount(agentCtx, 'continuity')
        },
      })
      createdSessionId = newId
      const next = handle.agent
      next.session.append('agent-preset/selected', { agentPreset: 'continuity' })
      const label = session.id
      const instruction = buildInstruction({ sessionId: session.id, label, cwd }, next)
      const content = [{ type: 'text', text: instruction }]
      // 3. Inject source context BEFORE waking.
      const presets = get('agentPresets')
      const resolver = presets !== undefined ? presets.serviceFor(agent, 'sessionReferenceResolver') : undefined
      let injectedSnapshot = false
      if (resolver !== undefined) {
        const prepared = await resolver.prepare(next, content, [{ sessionId: session.id, label }], sig)
        if (prepared.additionalContext !== undefined) {
          next.inject(prepared.additionalContext)
          injectedSnapshot = true
          const snapshotText = textOfMessage(prepared.additionalContext)
          const sessionQuery = get('sessionQuery')
          if (!snapshotText.includes(MARKER) && sessionQuery !== undefined) {
            try {
              const log = await sessionQuery.readSession(session.id)
              for (let index = log.events.length - 1; index >= 0; index -= 1) {
                const event = log.events[index]
                if (event.type !== 'assistant/message') continue
                const text = textOfMessage(event.data && event.data.message)
                if (!text.includes(MARKER)) continue
                next.inject(userMessage(
                  'Recall of the durable continuity checkpoint from session ' + session.id
                    + ' (seq ' + String(event.seq) + '):\n\n' + capText(text, 24000),
                  'continuity-checkpoint-recall',
                ))
                break
              }
            } catch {
              // bounded snapshot alone still carries context
            }
          }
        }
      }
      // 4. Wake with the continuation instruction.
      next.followup({
        id: userMessage('x', 'continuity-continue').id,
        role: 'user',
        source: { kind: 'continuity-continue', version: 1 },
        content,
      })
      state.lastRolloverAt = Date.now()
      state.continuationSessionId = newId
      state.rolloverCheckpointSeq = checkpointSeq
      // 5. Old-session disposition (default: keep alive; archive is explicit config).
      if (cfg.oldSession === 'archive') {
        const workspaces = get('workspaceRegistry')
        if (workspaces !== undefined) {
          try { await workspaces.archiveSession(session.id) } catch { /* keep alive on failure */ }
        }
      }
      return {
        kind: 'success',
        text: 'Rollover complete: continuation session ' + newId + ' created in the same workspace and woken'
          + (injectedSnapshot ? ' with the bounded snapshot injected before the instruction' : '')
          + '. The old session ' + session.id + ' stays alive. The new session performs only the checkpoint next atomic action.',
      }
    } catch (error) {
      state.failure = fail(error)
      if (createdSessionId !== null) {
        return {
          kind: 'error',
          text: 'Rollover partially completed: continuation session ' + createdSessionId
            + ' was created, but waking it failed: ' + fail(error)
            + '. The new session is recoverable via its durable log; the old session is unchanged.',
        }
      }
      return { kind: 'error', text: 'Rollover failed: ' + fail(error) + ' (the old session is unchanged).' }
    } finally {
      state.rotating = false
    }
  }

  /** Coordinator-driven worker successor (P2, opt-in and explicit only). */
  async function rotateSuccessor(coordinator, workerId, instruction, signal) {
    const workerIdClean = (typeof workerId === 'string' ? workerId : '').trim()
    if (workerIdClean === '') {
      return { kind: 'error', text: 'Usage: /worker-successor <worker-id> [remaining instruction]' }
    }
    const sessionQuery = get('sessionQuery')
    if (sessionQuery === undefined) {
      return { kind: 'error', text: 'Session query unavailable; cannot read the worker log for successor rotation.' }
    }
    const sig = signal !== undefined && signal !== null ? signal : new AbortController().signal
    try {
      const log = await sessionQuery.readSession(workerIdClean)
      const workerHeader = log.session
      if (workerHeader === undefined || workerHeader.parentSession === undefined) {
        return {
          kind: 'error',
          text: 'Session ' + workerIdClean + ' is not a worker (no parentSession); successor rotation applies only to worker sessions.',
        }
      }
      // Durable valid checkpoint is required: the worker writes it (via /handoff)
      // and reports BEFORE the coordinator spawns the successor.
      const durable = findValidCheckpoint(log)
      if (durable === null) {
        return {
          kind: 'error',
          text: 'Worker ' + workerIdClean + ' has no durable valid checkpoint yet. The worker must write its final checkpoint (/handoff) and report before a successor can inherit it.',
        }
      }
      // Idempotency: same checkpoint → no duplicate successor.
      const prior = successorByWorker.get(workerIdClean)
      if (prior !== undefined && prior.checkpointSeq === durable.seq) {
        return {
          kind: 'error',
          text: 'A successor (session ' + prior.successorId + ') was already spawned for this worker from the same checkpoint (idempotent).',
        }
      }
      const cwd = workerHeader.cwd || undefined
      const selection = modelSelectionFor({ events: log.events })
      if (selection === undefined) return { kind: 'error', text: 'no model route for the successor worker' }
      const agents = get('agents')
      if (agents === undefined) return { kind: 'error', text: 'agent registry unavailable' }
      const newId = 'session-cont-successor-' + Date.now().toString(36)
      const ref = { current: selection, assembled: undefined }
      const handle = await agents.create({
        sessionId: newId,
        meta: {
          ...(cwd === undefined ? {} : { cwd }),
          agentPreset: 'continuity',
          parentSession: workerHeader.parentSession,
          delegationDepth: 1,
          successorOf: workerIdClean,
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, ref)
          const presets = get('agentPresets')
          if (presets !== undefined) await presets.mount(agentCtx, 'continuity')
        },
      })
      const next = handle.agent
      next.session.append('agent-preset/selected', { agentPreset: 'continuity' })
      const remaining = (typeof instruction === 'string' ? instruction : '').trim()
      const successorPrompt = [
        'Successor worker task (continuity preset).',
        'You are the successor of worker ' + workerIdClean + ', which reached its context rollover threshold.',
        'A read-only bounded snapshot of that worker, including its durable continuity checkpoint, was injected BEFORE this message.',
        'Workspace: ' + (cwd === undefined ? '(unset)' : cwd) + '.',
        ...(remaining === '' ? [] : ['Remaining instruction from the coordinator:', remaining]),
        'Steps:',
        '1. Verify the workspace with read-only checks before editing anything.',
        '2. Read the checkpoint in the snapshot, then continue the task from its "Next atomic action".',
        '3. Complete the assigned work, then finish with a message starting "## Worker report" (done / files changed / verification / open problems / next action).',
        '4. Never run /rotate (a worker never rolls itself over).',
      ].join('\n')
      const content = [{ type: 'text', text: successorPrompt }]
      // Inject source context BEFORE waking.
      const presets = get('agentPresets')
      const resolver = presets !== undefined ? presets.serviceFor(coordinator, 'sessionReferenceResolver') : undefined
      let injectedSnapshot = false
      if (resolver !== undefined) {
        const prepared = await resolver.prepare(next, content, [{ sessionId: workerIdClean, label: workerIdClean }], sig)
        if (prepared.additionalContext !== undefined) {
          next.inject(prepared.additionalContext)
          injectedSnapshot = true
          const snapshotText = textOfMessage(prepared.additionalContext)
          if (!snapshotText.includes(MARKER)) {
            const checkpointText = capText(
              textOfMessage(log.events.findLast((event) => event.type === 'assistant/message'
                && textOfMessage(event.data && event.data.message).includes(MARKER))?.data?.message),
              24000,
            )
            if (checkpointText !== '') {
              next.inject(userMessage(
                'Recall of the durable continuity checkpoint from worker ' + workerIdClean + ' (seq ' + String(durable.seq) + '):\n\n' + checkpointText,
                'continuity-checkpoint-recall',
              ))
            }
          }
        }
      }
      next.followup({
        id: userMessage('x', 'continuity-successor').id,
        role: 'user',
        source: { kind: 'continuity-successor', version: 1 },
        content,
      })
      successorByWorker.set(workerIdClean, { successorId: newId, checkpointSeq: durable.seq })
      if (successorByWorker.size > 512) {
        const oldest = successorByWorker.keys().next().value
        if (oldest !== undefined) successorByWorker.delete(oldest)
      }
      return {
        kind: 'success',
        text: 'Successor worker ' + newId + ' spawned for worker ' + workerIdClean + ' in workspace ' + (cwd || '(unset)')
          + (injectedSnapshot ? ' with the bounded checkpoint snapshot injected before the instruction' : '')
          + '. Track it with /workers and read its report with /worker-report ' + newId + '.',
      }
    } catch (error) {
      return { kind: 'error', text: '/worker-successor failed: ' + fail(error) }
    }
  }

  function onSessionEvent(session, event) {
    if (event === null || event === undefined) return
    // Fold into the incremental cache (baseline on first sight).
    syncCache(session)
    if (event.type !== 'assistant/message') return
    const text = textOfMessage(event.data && event.data.message)
    if (!text.includes(MARKER)) return
    const verdict = validateCheckpoint(text)
    resolveCheckpointWaiters(session.id, verdict.ok, verdict.ok ? null : verdict.reason, event.seq)
  }

  function tick(agent) {
    if (agent === null || agent === undefined) return
    const presets = get('agentPresets')
    if (presets === undefined || presets.composedPreset(agent.ctx) !== 'continuity') return
    const state = getState(agent.id)
    if (state.rotating) return
    const observation = observe(agent)
    const header = agent.session.header
    const decision = decide(cfg, {
      ratio: observation.ratio,
      capacityKnown: observation.capacityKnown,
      rotating: false,
      cooldownElapsed: Date.now() - state.lastRolloverAt >= cfg.cooldownMs,
      hasHistory: syncCache(agent.session).assistantCount >= 1,
      mode: cfg.autoRollover,
    })
    if (decision !== 'auto') return
    // Auto rollover only for root sessions (no parent lineage).
    if (header !== undefined && header.parentSession !== undefined) return
    void rotate(agent, undefined).catch(() => {})
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/turn-stopping', (payload) => {
    if (payload !== null && payload !== undefined && payload.agent !== undefined) tick(payload.agent)
  })
  ctx.on('agent/status', (payload) => {
    if (payload !== null && payload !== undefined && payload.status === 'idle') tick(payload.agent)
  })

  ctx.provide(SERVICE, {
    rotate,
    rotateSuccessor,
    suggest,
    get config() { return cfg },
  })
  return undefined
}
