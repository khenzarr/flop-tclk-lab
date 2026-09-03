# Signature Airlock

The Airlock is not a signer and it is not key custody. It is a deterministic
local handoff protocol that makes the exact bytes crossing the custody boundary
inspectable, approvable, fingerprinted and replayable — without ever giving TCLK
custody of a key.

```
TCLK canonical frame preparation
            ↓
      SIGNATURE AIRLOCK          ← this module
            ↓
 trusted local signer boundary   ← stays outside, unchanged
            ↓
    signature-only return
            ↓
 future TCLK public posting      ← Phase 3B, not this phase
```

In Phase 3A the last arrow does not exist. The Airlock's terminal output is
`POST_ELIGIBLE = YES | NO`. `POST_ELIGIBLE` is a local judgement about a
signature; `POSTED` would be a public fact about a venue. Nothing here posts.

## Layout

| File | Role |
|---|---|
| `blackbox/airlock/prepare.mjs` | Stage 1 — canonicalise a frame, pin upstream, derive the human reading |
| `blackbox/airlock/envelope.mjs` | Stages 2–3 — request envelope, fingerprint, approval, BYTE FREEZE, replay ledger |
| `blackbox/airlock/signer.mjs` | Stage 4 — signer adapter shape, `did:key` codec, Ed25519 verify, `TestVectorSigner` |
| `blackbox/airlock/verify.mjs` | Stages 5–7 — response envelope, binding checks, post eligibility |
| `blackbox/airlock/render.mjs` | The pressure-door surface |
| `blackbox/airlock/dryrun.mjs` | Five end-to-end deterministic scenarios + footprint preview |
| `blackbox/airlock/demo.mjs` | `pnpm airlock` |
| `schemas/signature-airlock-request.schema.json` | Request envelope contract |
| `schemas/signature-airlock-response.schema.json` | Response envelope contract |

## Stage 1 — FRAME PREPARED

`prepareFrame(frame, { operation })` returns a frozen `PREPARED` record holding
the TCLK frame type, contract id, actor DID, the canonical serialised frame, its
canonical hash, the upstream SHA that produced it, the destination room when
known, and the operation type. No signature exists yet.

Canonicalisation is delegated to upstream `tclk.canonicalJson` — the Airlock
never re-implements it. `upstreamPin()` reads the recorded baseline so every
envelope carries the commit whose encoder produced the bytes.

`deepFreeze` is applied on the way out. The prepared record cannot be edited in
place; a change means a new prepare.

## Stage 2 — REVIEW ENVELOPE

`buildRequest(prepared, { createdAt, ttlMs })` emits a
`tclk-airlock-request/v1` envelope: schema, request id, created timestamp,
upstream SHA, frame type, contract id, signer DID, canonical payload and hash,
intended room, intended operation, expiry, and warnings.

The request id is the fingerprint: `fingerprintRequest` hashes a domain-separated
`bindingCore(envelope)` — the fields that define *what is being approved*, not
the incidental metadata around it. The same frame, clock and pin always produce
the same id. Determinism is the point: an id that drifted per run could not
detect a mutation.

`assertSafeEnvelope` walks every envelope and refuses seed, mnemonic,
passphrase, private-key, decrypted-blob and token-shaped content. This is the
unsafe-field sentinel, and it runs on both directions of the boundary.

## Stage 3 — OPERATOR REVIEW

`approveRequest(envelope)` refuses outright if `requestIsIntact(envelope)` fails
— an envelope whose recomputed fingerprint no longer matches its own content is
never approvable. Approval records the approved hash, the approved payload and
the fingerprint at approval time.

The surface states plainly: **you are approving these exact canonical bytes**.

## Dual representation

Every review shows two things side by side:

- **Human interpretation** — `humanReading(frame, room)`: who, what, which
  contract, which room, which deadline.
- **Exact signed bytes** — the canonical payload, verbatim.

The surface says which one the signature covers: the bytes. The human reading is
a courtesy and carries no cryptographic weight. This matters because TCLK
canonicalisation is load-bearing — a plausible-looking summary can sit on top of
bytes that mean something else, and the operator must never be asked to trust the
summary.

## Stage 4 — LOCAL SIGNER HANDOFF

Phase 3A does not call the real canonical signer. `TestVectorSigner` derives a
deterministic Ed25519 keypair from a domain string, and its key never leaves the
instance.

The adapter shape is the contract that matters:

```js
signApprovedChallenge({ requestId, canonicalPayload, canonicalHash, signerDid, room })
// → { requestId, signerDid, signature, canonicalHash }
```

Deliberate properties: the signer receives an already-approved challenge and has
no authority to construct one; it returns a signature and binding fields and
nothing else; there is no parameter through which a private key could travel in
either direction. A future trusted local signer can satisfy this interface
without changing its custody model.

`canonicalMessage(room, nonce, text)` reproduces the venue preimage
`room|nonce|clean_text(text)` so local verification checks the same bytes the
venue would.

## Stage 5 — RETURN ENVELOPE

`buildResponse(signed)` emits `tclk-airlock-response/v1` through an allow-list:
`requestId`, `signerDid`, `signature`, `canonicalHash`, `room`, `nonce`,
`signerKind`. An allow-list rather than a deny-list — a field nobody thought
about is dropped, not forwarded.

## Stage 6 — LOCAL VERIFICATION

`verifyResponse(request, approval, response, { ledger, nowMs })` accumulates
findings and returns them all rather than throwing on the first. It checks the
request id matches, the signer DID matches the approved DID, the canonical hash
matches the approved hash, the payload still hashes to that value, the signature
verifies as Ed25519 against the public key decoded from the `did:key`, the
request has not expired, the destination metadata is unchanged, the upstream pin
still matches, and the ledger has not already consumed this request.

Any finding means not verified. Failure is closed by construction: eligibility
requires an empty finding list, so a new unanticipated failure mode blocks rather
than passes.

## Stage 7 — POST ELIGIBILITY

`postEligibility(...)` returns `postEligible` plus every blocker. In Phase 3A
`publicPostingEnabled` defaults to `false`, and that alone is listed as a
blocker-class fact on the surface: **PUBLIC POSTING DISABLED**.

Eligibility requires all of: request envelope valid, operator approval recorded,
response envelope matching the request, signature verifying, canonical bytes
unchanged, upstream semantics known, room and operation constraints valid, no
unsafe-field finding.

## BYTE FREEZE

`checkByteFreeze(envelope, approval)` is the first-class invariant. Once approved,
the canonical payload is immutable. If any field changes afterwards, the approval
is invalidated, any previous signature is invalidated, a new request id is
required, and a fresh review is required.

Three independent layers enforce it: the envelope is deep-frozen so in-place
mutation fails; the fingerprint is recomputed from content so a mutated envelope
cannot present the old id; and the approval stores the approved hash so a
substituted payload cannot borrow the old approval.

## Replay protection

`AirlockLedger` records completed request ids locally. A previously completed
request does not silently become a new action — presenting the same signed
envelope twice is a duplicate, not a retry.

This is local operator-safety state only. It is not a Technocore protocol
guarantee, and the Airlock does not claim the venue will reject a duplicate.

## Signature-confusion coverage

`blackbox/tests/airlock.test.mjs` covers, at minimum: altered payload after
approval, signature for a different request id, signature for a different DID,
signature over a different canonical hash, stale envelope, duplicate response,
malformed signature, valid signature with changed destination metadata, valid
envelope loaded against a different upstream pin, and unsafe fields injected into
either direction. Every unsafe mismatch fails closed.

## Dry runs

`pnpm airlock` runs five deterministic scenarios:

| Scenario | Ends |
|---|---|
| `happy-handoff` | `POST_ELIGIBLE=YES` — and posts nothing |
| `mutated-payload` | `POST_ELIGIBLE=NO` |
| `wrong-signer` | `POST_ELIGIBLE=NO` |
| `stale-request` | `POST_ELIGIBLE=NO` |
| `replayed-response` | `POST_ELIGIBLE=NO` |

All five run offline with no real key, no wallet and no venue.

## Surface

A separate Airlock surface, not a change to the accepted forensic interface. The
metaphor is a pressure door sequence:

```
PREPARED → REVIEWED → SIGNED → LOCALLY VERIFIED → POST ELIGIBLE
```

A failed step leaves the next door shut, and the reason is shown at the door that
refused. No finality language, no settlement language, no dashboard.

## What the Airlock does not prove

- It does not prove the signer is trustworthy — only that a signature over the
  approved bytes verifies against the stated DID.
- It does not prove the venue will accept the frame.
- It does not prove the operator understood the deal, only that they approved
  specific bytes.
- `POST_ELIGIBLE=YES` is not a claim that anything was posted, settled or
  finalised.
