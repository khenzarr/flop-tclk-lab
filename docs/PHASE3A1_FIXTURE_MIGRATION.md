# Phase 3A.1 — Fixture Migration

Status: **migration complete, re-pin deliberately not performed.** Scope: one fixture, one
timestamp, no protocol change.

- Pin in force, before and after this phase: `81a83464bd909fb5cd80de647da4e42fbae177dd`
- Comparison head this migration targets: `103a1b960c117c82473ee058b7dca1769e167125` —
  **not adopted as the pin**
- Actual upstream `main` when the phase re-verified it:
  `d48e87343200e3115e243df39e8f295f5ce2e645`
- Package under both compared commits: `@flop-labs/tclk@0.1.0`
- Classification: **`FAIL_CLOSED_SEMANTIC_TIGHTENING`**

This is a fixture problem, not an upstream problem. Nothing in `.upstream/` was modified, no
deadline rule was relaxed, and no TCLK source was patched to accommodate our test data.

## Why the pin did not move

The phase brief opens by requiring upstream to be re-verified rather than assumed, and it was:
`main` had advanced five commits past the head Phase 3A recorded. Four of those commits change
protocol-observable behaviour that no probe in this repository has exercised — a decode-side
room-message cap (#60), a narrowed published frame schema (#59), stricter hex rejection with
non-echoing reasons (#63), and new accept-path refusals for contradictory receipt rail/ref and a
zero adaptor witness (#51).

Re-pinning onto `d48e873` would therefore adopt unexamined semantics *and* rotate every replay
fingerprint in the same commit, which is exactly the silent baseline move the provenance rules of
this phase exist to prevent. Two of the ten re-pin conditions fail (all state-semantic differences
understood; only known fixture timing requires adaptation), so the answer is
`BLACKBOX_REPINNED=NO` and the stop is recorded in
`evidence/upstream-moved-again-phase3a1.json`.

The migration itself still stands on its own: the fixture set is now correct under the tightened
deadline rule whenever the lab does re-pin, and it remains correct under the pin in force.

## The change upstream made

Current upstream refuses a `lock` frame once the refund deadline has been reached:

```
lawful lock requires:  nowMs < refundAfterMs
```

Previously the boundary instant `nowMs === refundAfterMs` was accepted. The tightened rule is
correct: at the moment the refund window opens, a lock can no longer be lawfully created, and
accepting one would let a lock and its own refund be simultaneously valid. Upstream now fails
closed. Calling that a regression would be wrong in both directions — it removes an unsafe
acceptance, and it removes it in the safe direction.

## The affected fixture

Exactly one fixture tripped it.

| | |
|---|---|
| Fixture | `normal-refund` |
| Original intent | The **lawful refund path**: an accepted, locked deal that is never revealed, refunded after its deadline. |
| Frames | `offer` → `accept` → `lock` → `refund` (4 frames, all expected to be accepted) |
| `refundAfterMs` | `1800000002000` (`REFUND_AFTER_MS = NOW + 2000`, where `NOW = 1800000000000`) |
| Old evaluation clock | flat `nowMs = 1800000002000` for **all four** frames |
| Lock evaluated at | `1800000002000` — i.e. exactly `refundAfterMs` |
| Result under old pin | `refunded` · 4 accepted / 0 rejected |
| Result under comparison head | `accepted` · 2 accepted / 2 rejected (`lock` refused, then `refund` refused for want of a lock) |

The other seven fixtures (`happy-claim`, `cancel-before-lock`, `wrong-party`, `wrong-secret`,
`replay-attack`, `out-of-order-reveal`, `mutated-canonical-frame`) are unaffected under either
commit.

### Why it broke

The fixture was authored with a single flat clock — one `nowMs` reused for every frame in the
transcript. That is convenient for outcome determinism and it was sufficient under the old pin,
but it collapses the deal's timeline: the lock and the refund appear to happen at the same
instant. To be *late enough to refund*, the flat clock had to sit at `refundAfterMs`, which
dragged the lock to the same instant. The fixture's refund assertion therefore rested on the
boundary acceptance that upstream has now closed.

Stated precisely: **this fixture previously tested the lawful refund path, and its timestamp
accidentally depended on a lock being accepted at `nowMs === refundAfterMs` — behaviour current
upstream correctly rejects.** The intent was always lawful; only the encoding of time was wrong.

## The re-authored timing

The scenario was re-authored, not patched around. Frames are byte-identical; only the evaluation
schedule changed, from one flat instant to the deal's real ordering:

| Frame | Old `nowMs` | New `nowMs` | Rationale |
|-------|-------------|-------------|-----------|
| `offer` | `1800000002000` | `1800000000000` | `T0`. The deal is proposed before its own deadline. |
| `accept` | `1800000002000` | `1800000000000` | Same instant as the offer; acceptance is immediate in this scenario, as before. |
| `lock` | `1800000002000` | `1800000000000` | **The migration.** `1800000000000 < 1800000002000`, so the lock is lawful with the full refund window ahead of it. |
| `refund` | `1800000002000` | `1800000002000` | Unchanged. `nowMs === refundAfterMs` is the *first lawful instant to refund*, which is exactly what this fixture exists to test. |

Timing rationale, in full:

- **No new magic numbers.** Both constants already existed in the fixture set: `NOW`
  (`1800000000000`) and `NOW + REFUND_AFTER_MS` (`1800000002000`). The 2000 ms window is the
  fixture's own pre-existing deadline offset.
- **No arbitrary gap.** The lock did not move "far enough back to be safe"; it moved to `T0`,
  where the rest of the transcript already lived. The refund did not move at all.
- **The boundary is still exercised, on the correct side.** The refund is still evaluated at
  precisely `refundAfterMs`. The fixture continues to test the deadline instant — it just tests
  the frame for which that instant is lawful.
- **Realistic ordering preserved.** offer → accept → lock, then later refund. Monotonic,
  deterministic, no clock travel.
- **Scenario intent preserved.** Terminal state is `refunded`, 4 accepted / 0 rejected under
  *both* compared commits — the same protocol trajectory the fixture asserted originally.

## Fixture provenance: `legacy-v1` and `current-v2`

Rather than edit the historical fixture in place, both sets exist side by side and are labelled:

| `fixtureSetVersion` | Meaning | `normal-refund` clock |
|---|---|---|
| `legacy-v1` | Frozen. The timing Phase 2 / 2.1 evidence was produced under, evaluated against the old pin. | flat `1800000002000` |
| `current-v2` | Default. Authored for current semantics. | scheduled `T0, T0, T0, refundAfterMs` |

Nothing is duplicated needlessly: the two sets share one transcript builder and differ only in
their evaluation schedule, so `legacy-v1` cannot silently drift from the frames it documents.
Seven of the eight fixtures resolve to identical timing in both sets; only `normal-refund`
carries a genuine difference.

The distinction is deliberately non-misleading in both directions:

- a `legacy-v1` divergence under current upstream is an **expected historical finding**, and is
  reported as such rather than being allowed to gate the compatibility verdict;
- `current-v2` is the only set the default baseline, demo, capsules and artifacts are built from.

## What this migration does *not* do

- It does not modify Phase 2 evidence, Phase 2.1 replay fingerprints, or the Phase 2.1
  screenshots. Those remain byte-for-byte as committed, pinned to `81a8346`.
- It does not overwrite any historical replay fingerprint. Old and new fingerprints are recorded
  as separate provenance records in `evidence/replay-baseline-migration.json`.
- It does not weaken, wrap, or special-case the upstream deadline rule.
- It does not claim the old and new evidence are interchangeable. They are lineage-linked and
  explicitly *not* hash-equivalent.

Historical evidence remains **valid evidence against its pinned implementation**. It is not
stale and it is not invalid; it answers a question about `81a8346`, and it still answers it.

## See also

- `docs/CROSS_PIN_REPLAY_MATRIX.md` — per-fixture A/B results across both commits.
- `evidence/cross-pin-replay-matrix.json` — machine-readable matrix.
- `evidence/replay-baseline-migration.json` — fingerprint lineage.
- `docs/UPSTREAM_DRIFT_PHASE3A.md` — the drift capture that found the tightening.
