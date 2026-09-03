# Independent TCLK readiness and verification lab

This repository is an **independent TCLK readiness and verification lab**. It pins an exact upstream checkout, runs upstream gates, and uses the built upstream library for a local no-value rehearsal. It is not official FLOP Labs software and does not reimplement TCLK.

## Scope and safety

- Upstream: https://github.com/flop-labs/tclk
- Pinned baseline: `81a83464bd909fb5cd80de647da4e42fbae177dd` on `main` (untagged; see `evidence/upstream-baseline.json`).
- No canonical DID key, private seed, wallet, payment key, or signing adapter is stored here.
- The lab performs no live Technocore writes and moves no value. PaperRail is only a world-writable rehearsal record.
- PTLC/adaptor code is upstream's unaudited reference cryptography, not production Bitcoin signing.

## Reproduce

The upstream checkout is local and ignored at `.upstream/tclk`. From PowerShell:

```powershell
./scripts/bootstrap-upstream.ps1
./scripts/verify-upstream.ps1
node ./lab/run-rehearsal.mjs
```

The scripts use pnpm and the upstream-declared version. They do not modify upstream source. `verify-upstream.ps1` runs the exact install/build/test gates documented by upstream AGENTS.md.

## Current Phase 1 result

At the captured baseline, upstream install, build, and tests passed: 13 test files and 124 tests, with no failures. The local rehearsal passed 11 cases: hash-lock claim, refund, supported cancel, six negative/fail-closed cases, canonicalization, and PaperRail lock/claim/refund predicates. The local run is offline and its evidence serializer removes registered secret values.

This does not prove settlement, funding, reward eligibility, testnet access, or production security. Live rehearsal requires explicit operator approval and remains unexecuted.

## Phase 2: TCLK Blackbox

**TCLK Blackbox — Agent Deal Flight Recorder** is an independent, local-first
verifier/replayer. It reconstructs accepted and rejected frames against the
pinned upstream implementation, visualizes the protocol/custody/rail lanes,
and exports a secret-screened evidence capsule. CHAOS mode deterministically
mutates safe fixtures to expose invariants; it is not a penetration-testing
suite and makes no identity, payment, reward, or complete-history claims.

Run the offline demo:

```powershell
pnpm demo
```

Open `blackbox/out/blackbox-demo.html`. No credentials, wallet, network, or
Technocore write is involved. See `docs/BLACKBOX_PRODUCT_THESIS.md` and
`docs/REPLAY_DETERMINISM.md`.

Phase 2.1 hardens the demo into a forensic replay instrument: an
evidence-derived deal flight path, explicit rejection boundary, before/event/
after inspector, event-bearing protocol/custody/rail tracks, deterministic
scrubber, CHAOS invariant comparison, incident signal, and evidence drawer.
Generate the seven local visual-acceptance captures with `pnpm artifacts`;
outputs live in `blackbox/artifacts/phase-2.1/`.

## Phase 3A: Signature Airlock

**Signature Airlock** is the custody-boundary mechanic. It is not a signer and
holds no key. It makes the exact bytes that cross into a trusted local signer
inspectable, approvable, fingerprinted and replayable, so TCLK never takes
custody of a private key.

Five doors, each one shut unless the previous one opened:

```
PREPARED → REVIEWED → SIGNED → LOCALLY VERIFIED → POST ELIGIBLE
```

Run the offline airlock demo:

```powershell
pnpm airlock
```

It renders `blackbox/out/airlock-demo.html` and prints one happy dry run plus
the mutated-payload, wrong-signer, stale-request and replayed-response runs.
Every failure run ends `POST_ELIGIBLE=NO`.

Load-bearing properties:

- **BYTE FREEZE** — approval binds one exact canonical payload. Any later field
  change invalidates the approval and the signature, and forces a new request id.
- **Dual representation** — the human interpretation is displayed next to the
  exact signed bytes, and the UI states that the bytes, not the interpretation,
  are what the signature covers.
- **POST_ELIGIBLE is not POSTED.** Phase 3A stops at eligibility;
  `PUBLIC POSTING DISABLED` stays visible and no posting path exists in code.
- The signer used here is a deterministic test-only signer. The real canonical
  local agent was never called and no private key was accessed.

Upstream drift for this phase is recorded in
`evidence/upstream-drift-phase3a.json` and `docs/UPSTREAM_DRIFT_PHASE3A.md`.
Upstream is wire-format and canonicalization compatible with the pinned
baseline, but one existing transition tightened (a lock is refused once the
refund deadline has passed). Reproduce the A/B comparison with
`pnpm compat:matrix <candidateDir> <candidateSha>`; see
`docs/BLACKBOX_UPSTREAM_COMPATIBILITY.md`.

## Phase 3A.1: fixture rebaseline

The fixture that relied on the loosened transition has been re-authored rather than patched
around, and fixtures now carry explicit provenance: `legacy-v1` is the frozen Phase 2 timing,
`current-v2` is authored for the tightened deadline rule and is what the default baseline, demo
and capsules use. Both sets reach the same terminal states under the compared commits. See
`docs/PHASE3A1_FIXTURE_MIGRATION.md` and `docs/CROSS_PIN_REPLAY_MATRIX.md`.

**Blackbox stays pinned at `81a8346`.** Re-verifying upstream during this phase found `main` had
moved again, to `d48e873`, with four of five new commits changing protocol-observable behaviour
that has had no drift pass here. Fingerprint lineage across baselines is recorded in
`evidence/replay-baseline-migration.json`; the stop itself is in
`evidence/upstream-moved-again-phase3a1.json`. Historical evidence is untouched and remains valid
against the implementation it was pinned to.

The one future public rehearsal is designed but unexecuted:
`docs/PHASE3B_ONE_DEAL_PLAN.md`, with its exact proposed public actions in
`evidence/phase3b-public-footprint-preview.json`. What each artifact does and
does not prove is in `docs/PHASE3_EVIDENCE_CHAIN.md`.

See `docs/` for protocol, security, custody, runbook, and future evidence notes.
