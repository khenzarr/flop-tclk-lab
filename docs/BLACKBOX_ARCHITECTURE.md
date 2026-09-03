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