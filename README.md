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

See `docs/` for protocol, security, custody, runbook, and future evidence notes.
