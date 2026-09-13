# Blackbox Architecture

## Product boundary

```text
BLACKBOX Web (Vercel / browser; public-safe UI)
             │ pairing-authenticated localhost request
             ▼
Local Connector (127.0.0.1; explicit approval boundary)
             │ existing Technocore DID / local signer
             ▼
Signed TCLK action → Technocore venue → exact public observation
                                           │
                                           ▼
                              BLACKBOX Flight Record
```

The production server does not hold the user's private key. The pairing JSON grants the browser access to the local connector; it is neither a DID nor a signer export, but its bearer token must still be protected. The connector discovers compatible existing Technocore identities and reuses them without generating, importing, rotating or replacing keys. See [Identity Hub](IDENTITY_HUB.md) for the prerequisite and [Getting Started](GETTING_STARTED.md) for the operator path.

BLACKBOX V1's actionable deal mode is Local Self-Test: one operator controls two cryptographic DIDs. A signature proves key control for a message, not independent humans or economic value. `SIGNED`, `SUBMITTED`, `ACK_RECEIVED`, `OBSERVED_PUBLIC`, and `COMPLETE` are distinct evidence stages. PaperRail is unsigned, world-writable, non-value-bearing, and not a payment rail. The verified `/deal/phase3b-final` route is a historical public reference, not a live current deal.

## Replay implementation

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
