# Blackbox Architecture

`blackbox/core/replay.mjs` imports the pinned build through `lab/upstream.mjs`.
It calls `openContract`, `decodeFrame`, `encodeFrame`, and `applyFrame`; it does
not reimplement transitions. Each step records raw and canonical hashes,
state projections, and before/after digests. `fixtures` provide deterministic
offline input. `capsule` is an allow-list artifact guarded by the sentinel.
`ui/render.mjs` emits a self-contained flight-recorder HTML artifact.

The three lanes are projections, not additional sources of truth: rail events
exist only when a frame supplies them, and custody describes upstream-derived
party binding rather than human identity.

## Phase 2.1 forensic projection

`blackbox/core/model.mjs` projects immutable replay steps into frame markers,
flight-path nodes, rejection boundaries, evidence-bearing lanes, exact frame-N
reconstruction, invariant results, and capsule summaries. The renderer does
not infer transitions from fixture names or animation. Accepted steps may mark
only upstream `stateAfter.status` as reached; rejected steps preserve the
current node and identical before/after digests. Rail marks are emitted only
for observed accepted rail-bearing steps and never represent value movement.

Scrub and play controls select precomputed deterministic reconstructions.
Playback is local sequencing, not network or live-room activity.