# Cross-Pin Replay Matrix — Phase 3A.1

Deterministic A/B replay of the Blackbox fixture suite against two upstream commits, through the
real replay code and two real upstream builds. Regenerate with:

```
node lab/compat-matrix.mjs .upstream/tclk-head-lf 103a1b960c117c82473ee058b7dca1769e167125
```

Machine-readable output: `evidence/cross-pin-replay-matrix.json`.

| | |
|---|---|
| A — pin in force | `81a83464bd909fb5cd80de647da4e42fbae177dd` · still the pin after this phase |
| B — comparison head | `103a1b960c117c82473ee058b7dca1769e167125` · **NOT ADOPTED AS PIN** |
| Package (both) | `@flop-labs/tclk@0.1.0` |
| Verdict | `BLACKBOX_COMPATIBLE` (A vs B only) |
| Upstream writes | none — both clones read-only |

The B column is a comparison, not a baseline. Upstream `main` moved to
`d48e87343200e3115e243df39e8f295f5ce2e645` while this phase was running, and four of the five new
commits tighten decode acceptance, published-schema validity, or accept-path preconditions. So B is
neither the pin nor current upstream head — it is the commit whose one known semantic change (the
refund-deadline guard) this migration was scoped to. See
`evidence/upstream-moved-again-phase3a1.json`.

Compared per fixture: frame types, canonical frame encoding, contract id, accepted/rejected
sequence, per-frame state trajectory, terminal state, rail observations, and the
rejections-do-not-mutate invariant.

## Two questions, kept apart

**Byte equivalence** — do the transcript bytes and the replay evidence bytes match? Reported as
two sub-columns, because they answer different things: identical transcript bytes prove
canonicalization did not move; identical replay-evidence bytes additionally require that the
recorded evaluation timing did not move. A deliberately re-authored fixture is *expected* to
break the second while keeping the first.

**Semantic equivalence** — does the same transcript still produce the same protocol-observable
trajectory: same accept/reject sequence, same reasons, same state at every step, same terminal
state? This is the load-bearing column. Nothing is permitted to break it silently.

Replay fingerprints hash the upstream SHA, so **every** fingerprint rotates on a re-pin by
construction. Fingerprint inequality is therefore never used as a compatibility signal here; the
upstream-stripped fingerprint is used instead.

## A — `current-v2` fixtures across both commits

This is the compatibility question, and the verdict above is computed from it.

Column headers below read *pin in force* / *comparison head* rather than the *old pin* /
*current pin* of the phase brief, because the pin did not move: calling column B "current pin"
would assert a re-pin this phase deliberately did not perform.

| Fixture | Pin in force | Comparison head | Byte-equivalent | Semantically equivalent | Reason |
|---------|--------------|-----------------|-----------------|-------------------------|--------|
| `happy-claim` | claimed · 4 accepted / 0 rejected | claimed · 4 accepted / 0 rejected | YES | YES | identical frames, identical timing, identical trajectory |
| `normal-refund` | refunded · 4 accepted / 0 rejected | refunded · 4 accepted / 0 rejected | YES | YES | re-authored lock time is lawful under both commits |
| `cancel-before-lock` | cancelled · 2 accepted / 0 rejected | cancelled · 2 accepted / 0 rejected | YES | YES | unaffected by the deadline rule |
| `wrong-party` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | same rejection boundary, same reason |
| `wrong-secret` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | same rejection boundary, same reason |
| `replay-attack` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | same rejection boundary, same reason |
| `out-of-order-reveal` | accepted · 2 accepted / 1 rejected | accepted · 2 accepted / 1 rejected | YES | YES | same rejection boundary, same reason |
| `mutated-canonical-frame` | proposed · 1 accepted / 2 rejected | proposed · 1 accepted / 2 rejected | YES | YES | canonical rejection identical; no canonicalization drift |

Rail observations match per fixture (`paper` for `happy-claim`, `normal-refund`, `wrong-party`,
`wrong-secret`, `replay-attack`; none for the three that never reach a rail). The
rejections-do-not-mutate invariant holds under both pins for all eight.

## B — `legacy-v1` fixtures across both commits

Historical timing, frozen. A divergence here is the migration **finding**, not a regression, and
it does not gate the verdict.

| Fixture | Pin in force | Comparison head | Byte-equivalent | Semantically equivalent | Reason |
|---------|--------------|-----------------|-----------------|-------------------------|--------|
| `happy-claim` | claimed · 4 accepted / 0 rejected | claimed · 4 accepted / 0 rejected | YES | YES | unaffected |
| `normal-refund` | refunded · 4 accepted / 0 rejected | **accepted · 2 accepted / 2 rejected** | NO | **NO** | legacy clock evaluates the lock at exactly `refundAfterMs`; the comparison head refuses it (#43), so the later refund has no lock to release. Rail observation drops from `paper` to none. |
| `cancel-before-lock` | cancelled · 2 accepted / 0 rejected | cancelled · 2 accepted / 0 rejected | YES | YES | unaffected |
| `wrong-party` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | unaffected |
| `wrong-secret` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | unaffected |
| `replay-attack` | locked · 3 accepted / 1 rejected | locked · 3 accepted / 1 rejected | YES | YES | unaffected |
| `out-of-order-reveal` | accepted · 2 accepted / 1 rejected | accepted · 2 accepted / 1 rejected | YES | YES | unaffected |
| `mutated-canonical-frame` | proposed · 1 accepted / 2 rejected | proposed · 1 accepted / 2 rejected | YES | YES | unaffected |

One fixture, one transition, fully attributed. Nothing else in the suite moves — which is what
makes this a fixture migration rather than a protocol break.

## C — Migration lineage: `legacy-v1` @ A → `current-v2` @ B

The published Phase 2 replay against the migrated fixture set. Transcript bytes are identical throughout;
only `normal-refund` changed its evaluation schedule, so only it loses replay-evidence byte
equality. Old fingerprints are reproduced, never replaced.

| Fixture | Transcript bytes | Replay evidence bytes | Semantically equivalent | Timing re-authored | Reason |
|---------|------------------|-----------------------|-------------------------|--------------------|--------|
| `happy-claim` | identical | identical | YES | no | provenance-only rotation |
| `normal-refund` | identical | **differ** | YES | **yes** | lock moved from `refundAfterMs` to `T0`; refund still evaluated at `refundAfterMs`; same trajectory, different bytes by construction |
| `cancel-before-lock` | identical | identical | YES | no | provenance-only rotation |
| `wrong-party` | identical | identical | YES | no | provenance-only rotation |
| `wrong-secret` | identical | identical | YES | no | provenance-only rotation |
| `replay-attack` | identical | identical | YES | no | provenance-only rotation |
| `out-of-order-reveal` | identical | identical | YES | no | provenance-only rotation |
| `mutated-canonical-frame` | identical | identical | YES | no | provenance-only rotation |

Per-fixture fingerprint lineage — old SHA + old fingerprint alongside new SHA + new fingerprint,
with `fingerprintsEqual` stated explicitly rather than implied — is in
`evidence/replay-baseline-migration.json`.

## Conclusions

- `CROSS_PIN_BYTE_EQUIVALENCE` — YES for the `current-v2` set across both pins; NO across the
  `legacy-v1` → `current-v2` migration for `normal-refund`, by design.
- `CROSS_PIN_SEMANTIC_EQUIVALENCE` — YES for all eight `current-v2` fixtures and for the
  migration lineage; NO for `legacy-v1` `normal-refund` under the comparison head, which is the
  documented historical finding.
- `BLACKBOX_REPINNED` — NO. The pin stays at `81a8346`; see `docs/PHASE3A1_FIXTURE_MIGRATION.md`
  and `evidence/upstream-moved-again-phase3a1.json` for the reasoning.
- Wire format, canonical JSON, offer ids and contract ids are unchanged. Upstream's export
  surface grew by twelve names and removed none.

## See also

- `docs/PHASE3A1_FIXTURE_MIGRATION.md` — why the fixture moved and the exact timing rationale.
- `evidence/replay-baseline-migration.json` — fingerprint lineage records.
- `docs/BLACKBOX_UPSTREAM_COMPATIBILITY.md` — the compatibility harness itself.
