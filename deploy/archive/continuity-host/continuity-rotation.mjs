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
 */
import {
  MARKER,
  validateCheckpoint,
  userMessage,
  capText,
  textOfMessage,
  buildInstruction,
} from 'file:///C:/Users/wangy/.dsh/.agent-presets/continuity/continuity-plugin.v2.mjs'

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

  // sessionId -> { rotating: boolean, lastRolloverAt: number, failure: string | null }
  const states = new Map()
  // sessionId -> array of resolve callbacks awaiting that session's checkpoint
  const checkpointWaiters = new Map()

  function getState(id) {
    let state = states.get(id)
    if (state === undefined) {
      state = { rotating: false, lastRolloverAt: 0, failure: null }
      states.set(id, state)
      if (states.size > 512) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
    }
    return state
  }

  function countAssistant(session) {
    let count = 0
    for (const event of session.events) {
      if (event.type === 'assistant/message') count += 1
    }
    return count
  }

  function capacityOf(session) {
    const contextEvent = session.events.findLast((event) => event.type === 'request/context')
    if (contextEvent !== undefined && contextEvent.data
      && Number.isFinite(contextEvent.data.contextWindow) && contextEvent.data.contextWindow > 0) {
      return contextEvent.data.contextWindow
    }
    return null
  }

  function findValidCheckpoint(session) {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
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
    const capacity = capacityOf(session)
    const capacityKnown = typeof capacity === 'number' && capacity > 0
    const ratio = capacityKnown && totalTokens !== null ? totalTokens / capacity : null
    return { totalTokens, capacity, capacityKnown, ratio }
  }

  /** Suggestion view consumed by the preset's /continuity and /rotate. */
  function suggest(agent) {
    const observation = observe(agent)
    const state = getState(agent.id)
    const mode = cfg.autoRollover
    const recommendation = decide(cfg, {
      ratio: observation.ratio,
      capacityKnown: observation.capacityKnown,
      rotating: state.rotating,
      cooldownElapsed: Date.now() - state.lastRolloverAt >= cfg.cooldownMs,
      hasHistory: countAssistant(agent.session) >= 1,
      mode,
    })
    return {
      ratio: observation.ratio,
      capacity: observation.capacity,
      threshold: cfg.rotateRatio,
      mode,
      recommendation, // none | suggest | auto | busy
      rotating: state.rotating,
      failure: state.failure,
    }
  }

  function resolveCheckpointWaiters(sessionId, ok, detail) {
    const waiters = checkpointWaiters.get(sessionId)
    if (waiters === undefined) return
    checkpointWaiters.delete(sessionId)
    for (const resolve of waiters) resolve({ ok, detail })
  }

  function waitForCheckpoint(sessionId, timeoutMs, signal) {
    return new Promise((resolve) => {
      const entry = checkpointWaiters.get(sessionId)
      if (entry !== undefined) entry.push(resolve)
      else checkpointWaiters.set(sessionId, [resolve])
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        resolve(outcome)
      }
      const timer = get('timer')
      if (timer !== undefined) {
        void timer.timeout(timeoutMs).then(() => finish({ ok: false, detail: 'timeout' }))
      }
      if (signal !== undefined && signal !== null) {
        try {
          signal.addEventListener('abort', () => finish({ ok: false, detail: 'aborted' }), { once: true })
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
    state.rotating = true
    state.failure = null
    // commands.execute requires a real AbortSignal; the auto path has none.
    const sig = signal !== undefined && signal !== null ? signal : new AbortController().signal
    try {
      // 1. Durable valid checkpoint (reuse the preset's /handoff machinery).
      const durable = findValidCheckpoint(session)
      if (durable === null) {
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
      return { kind: 'error', text: 'Rollover failed: ' + fail(error) + ' (the old session is unchanged).' }
    } finally {
      state.rotating = false
    }
  }

  function onSessionEvent(session, event) {
    if (event.type !== 'assistant/message') return
    const text = textOfMessage(event.data && event.data.message)
    if (!text.includes(MARKER)) return
    const verdict = validateCheckpoint(text)
    resolveCheckpointWaiters(session.id, verdict.ok, verdict.ok ? null : verdict.reason)
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
      hasHistory: countAssistant(agent.session) >= 1,
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
    suggest,
    get config() { return cfg },
  })
  return undefined
}
