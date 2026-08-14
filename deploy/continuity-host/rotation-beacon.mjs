/** Minimal beacon plugin: proves the profile patch hot-apply pipeline. */
export default function beacon(ctx) {
  ctx.provide('continuityRotationBeacon', {
    version: 1,
    mountedAt: Date.now(),
  })
}
