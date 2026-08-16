/**
 * One-shot runner for the offline patch-pipeline test: after the tree settles,
 * report visibility of the patch-inserted services plus every loader entry's
 * fiber state, write the result file, and request process exit.
 *
 * The continuity-smoke profile intentionally has NO continuity-mission row
 * (it assembles only the beacon + rotation rows + this runner). The mission
 * driver is therefore verified here by DIRECTLY importing its new versioned
 * file and instantiating it against a minimal fake ctx — this also proves the
 * file and its static dependency graph (continuity-shared.v1.mjs) resolve in
 * a fresh offline process.
 */
import { writeFileSync } from 'node:fs'
import continuityMission, {
  SERVICE as MISSION_SERVICE,
  capTextSafe,
  scanWorkerEvents,
  findMissionCheckpoint,
  missionGoalFromCheckpoint,
} from 'file:///C:/Users/wangy/.dsh/continuity-host/continuity-mission.v8.mjs'

export default function patchPipelineTest(ctx, config) {
  const outPath = (config && config.outPath) || 'C:\\Users\\wangy\\.dsh\\continuity-host\\pipeline-result.json'
  const finish = () => {
    // Direct-import mission check (no mission row in this profile).
    const provided = {}
    const missionCtx = { get() { return undefined }, on() {}, provide(name, value) { provided[name] = value } }
    let missionError = null
    try {
      continuityMission(missionCtx, {})
    } catch (error) {
      missionError = String(error)
    }
    const mission = provided[MISSION_SERVICE]
    const result = {
      beacon: typeof ctx.get('continuityRotationBeacon'),
      rotation: typeof ctx.get('continuityRotation'),
      missionRowPresent: typeof ctx.get('continuityMission'),
      missionImport: {
        service: MISSION_SERVICE,
        error: missionError,
        provided: mission !== undefined,
        start: mission !== undefined ? typeof mission.start : 'n/a',
        resume: mission !== undefined ? typeof mission.resume : 'n/a',
        status: mission !== undefined ? typeof mission.status : 'n/a',
        diagnostics: mission !== undefined ? typeof mission.__diagnostics : 'n/a',
        capTextSafe: typeof capTextSafe,
        scanWorkerEvents: typeof scanWorkerEvents,
        findMissionCheckpoint: typeof findMissionCheckpoint,
        missionGoalFromCheckpoint: typeof missionGoalFromCheckpoint,
      },
      timer: typeof ctx.get('timer'),
      rows: [],
      at: Date.now(),
    }
    try {
      const loader = ctx.get('loader')
      if (loader !== undefined && typeof loader.entries === 'function') {
        for (const entry of loader.entries()) {
          const fiber = entry.fiber
          result.rows.push({
            id: entry.options.id,
            disabled: entry.disabled,
            hasFiber: fiber !== undefined,
            state: fiber !== undefined ? fiber.state : null,
          })
        }
      } else {
        result.loader = 'unavailable'
      }
    } catch (error) {
      result.dumpError = String(error)
    }
    try {
      writeFileSync(outPath, JSON.stringify(result, null, 2))
    } catch (error) {
      try { writeFileSync(outPath, JSON.stringify({ error: String(error) })) } catch {}
    }
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(0)
  }
  const loader = ctx.get('loader')
  if (loader !== undefined && typeof loader.await === 'function') {
    void loader.await().then(finish, finish)
  } else {
    finish()
  }
}
