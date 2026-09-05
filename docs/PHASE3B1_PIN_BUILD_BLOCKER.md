# Phase 3B.1 — halted at the pin-build gate

Phase 3B.1 asked for a byte-exact freeze of one future TCLK deal: canonical frame templates, a
template hash per frame, a manifest root binding all of it, and a fixture replay proving the
two-DID happy path — all computed "using the adopted TCLK implementation".

That freeze did not happen, and no frozen manifest was written.

**The artifact this lab executes is not a build of the adopted pin.**

`FINAL_STATUS = BLOCKED`, block reason `PIN_BUILD_PROVENANCE`.

Not `TCLK_PHASE3B1_PROTOCOL_MISMATCH`: the pinned protocol sources still agree with the Phase 3B.0
conclusions. What mismatches is the locally built artifact the lab executes.

## What the gap is

`lab/upstream.mjs` does two separate things that were silently assumed to be one:

1. it verifies the upstream *clone's* `HEAD` against `evidence/upstream-baseline.json`, and
2. it imports `.upstream/tclk/dist/index.js`.

The SHA check covers the clone. The import resolves a compiled artifact. Upstream gitignores
`dist/`, so it is a local build output that no check in this repository covers. The clone can sit
exactly on the pin while `dist/` still holds the compiled output of an earlier commit — which is
what it holds.

Verified read-only by `lab/pin-build-integrity.mjs`:

| | pinned sources at `d48e873` | executed `dist/` |
|---|---|---|
| state-machine frames dispatched | `accept cancel heartbeat lock offer receipt refund reveal` | `accept cancel lock offer receipt refund reveal` |
| `heartbeat` frame | present | **absent** |
| `makeHeartbeat` export | present | **absent** |
| generated frame-field table | `src/frame-fields.generated.ts` | **not built** |
| modules | — | missing `frame-fields.generated`, `rails`, `transcript` |
| frame field tables | — | **10 deltas** |

`dist/frames.js` predates upstream `103a1b96` ("close live-wire conformance gaps"), which is an
ancestor of the pin. Concretely, the built artifact omits `type` from every frame's `required`
list and omits `ref` from `refund.allowed` and `reveal.allowed`.

Every canonical frame, transition, replay trajectory and hash this lab has produced under the
`d48e873` label came out of that stale artifact. Thirteen modules resolve the protocol through it,
including `blackbox/core/provenance.mjs`, `blackbox/core/replay.mjs`, `blackbox/fixtures/index.mjs`
and all three airlock stages.

## Why the phase stopped instead of continuing

A manifest root is only worth the implementation it was computed against. Freezing templates and
hashes from an artifact of unknown provenance would have produced a document that reads as
authoritative, hashes cleanly, reproduces on demand — and describes frames the pinned protocol
would reject, since `type` is required at the pin and absent from the stale artifact's required
set. The freeze would then have been cited by Phase 3B.2 as the reviewed pre-sign baseline.

So the following were deliberately **not** written:

- `docs/PHASE3B_EXACT_MANIFEST.md`
- `evidence/phase3b-exact-manifest.json`
- any `CANONICAL_FRAME_HASH`, `TEMPLATE_HASH` or `PHASE3B_MANIFEST_ROOT`
- `PHASE3B_EXECUTION_ID` (an execution identity implies an executable plan)
- `TWO_DID_FIXTURE_TRAJECTORY` / `ONE_DID_NEGATIVE_CONTROL` results

A fixture trajectory run through the stale machine would have passed. It would have proven that
the stale machine accepts the sequence, which is not the claim Phase 3B.1 was asked to establish.

## What was established

**Part 1 reconfirmation, read from the pinned sources** (`src/frames.ts`, `src/machine.ts`,
`src/frame-fields.generated.ts` at `d48e873`) rather than from docs or from `dist/`:

- frame set: `offer accept lock reveal refund cancel receipt heartbeat`
- separate claim frame: `NO`
- minimal state-changing sequence: `offer → accept → lock → reveal`

This agrees with Phase 3B.0. `src/frames.ts` also carries `job` and `presig` type literals, but
`src/machine.ts` dispatches on exactly the eight frames above.

**Part 17 provenance correction.** The two canonical roles are distinct:

| role | commit |
|---|---|
| `canonicalSigningCommit` | `124d621dd8c68b04bed79744ab332e8305093d02` |
| `canonicalEnrollmentCommit` | `3675aeacdb73656285c4253b6d6d8d937afe25d6` |

Both stored artifacts — `evidence/phase3b-counterparty-identity.json` and
`docs/PHASE3BC1B_HUMAN_ENROLLMENT.md` — already carried these correctly; the conflation existed
only in the Phase 3B.C1b report text. `blackbox/tests/phase3b1.test.mjs` now fails if the two
roles are ever collapsed onto one SHA. No history was rewritten.

**The gate itself.** `lab/pin-build-integrity.mjs` exports `freezeAllowed()`. It is read-only
static text analysis: it never imports the artifact whose provenance is in question, never writes,
and never touches custody, nonces, Technocore or the network.

## Remediation, in order

1. **Human decides how the pin becomes executable** — rebuild `.upstream/tclk` from the pinned
   commit, or consume the pin's sources directly instead of `dist/`.
2. **Make the artifact's provenance checkable.** `lab/upstream.mjs` should fail closed when
   `dist/` does not correspond to the verified clone `HEAD`, instead of assuming it does.
3. **Re-run the Blackbox suite against the corrected artifact** and record which previously
   recorded hashes and trajectories move. Some will.
4. **Then re-attempt Phase 3B.1 from Part 1.**

Step 3 changes recorded evidence, so it is a human decision, not an automatic repair.

## Safety

`REAL_CANONICAL_KEY_ACCESSED=NO` · `REAL_SIGNATURE_PERFORMED=NO` · `REAL_NONCE_CONSUMED=NO` ·
`TRANSPORT_OBJECTS=0` · `NETWORK_CALLS=0` · `SUBMISSION_CALLS=0` ·
`LIVE_TECHNOCORE_READS=NONE` · `LIVE_TECHNOCORE_WRITES=NONE` · `PUBLIC_ACTIONS=0` ·
`POSTED=NO` · `VALUE_MOVED=NO` · `BUDGETS_ACQUIRED=0`

DID A and DID B were both left locked. The upstream clone and both canonical repositories are
unmodified.

## Status carried forward

`READY_FOR_PHASE3B2_PREP=NO` — Phase 3B.2 prep would inherit an unverified protocol baseline.

`READY_FOR_FIRST_PUBLIC_WRITE=NO` — two independent reasons now: the pin-build gap above, and
DID B's signing route, which remains `ENROLLED_BUT_SIGNING_ROUTE_UNPROVEN` from Phase 3B.C1b and
was not re-audited here because the phase halted before Part 14.
