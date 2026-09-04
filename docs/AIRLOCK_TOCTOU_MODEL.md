# AIRLOCK TOCTOU MODEL

Phase 3A.3 · adopted pin `d48e87343200e3115e243df39e8f295f5ce2e645`

## The window

An operator approves canonical bytes at time T1. The adapter hands a challenge to the canonical
signer at time T2. Everything dangerous lives between those two moments, because that is where the
thing reviewed and the thing signed can stop being the same thing.

```
T1  operator reads bytes and approves
        ↓          ← the TOCTOU window
T2  adapter builds the signer challenge and hands it over
```

The window cannot be closed by being fast. It is closed by making the approval a **separate frozen
copy** of what was approved, and by re-deriving every claim at T2 from that copy rather than from
the live request object.

## Why approval is a copy, not a pointer

`approveRequest` does not record "the operator approved request X". It records the bytes
themselves plus a fingerprint over the whole envelope:

| Field on the approval | What it pins |
| --- | --- |
| `frozenPayload` | the exact canonical bytes shown to the operator |
| `canonicalHash` | SHA-256 over those frozen bytes |
| `requestFingerprint` | fingerprint over the full request envelope at approval time |
| `signerDid` | who was to sign |
| `intendedRoom` | where it was to go |
| `intendedOperation` | what was to be done |
| `upstreamSha` | which pin's rules produced it |

A mutation of the request after T1 therefore cannot follow the approval. The approval keeps its own
copy, and the two copies are compared before the signer is contacted.

## Mutation matrix

Every row was exercised; the finding column is what the code emits, not a paraphrase.

| Mutated after approval | Finding | Signer contacted |
| --- | --- | --- |
| canonical payload (one hex digit of the lock statement) | `BYTE_FREEZE_BROKEN`, `PAYLOAD_MUTATED_AFTER_APPROVAL`, `REQUEST_FINGERPRINT_BROKEN` | NO |
| canonical hash only, bytes untouched | `CANONICAL_HASH_DOES_NOT_COVER_PAYLOAD`, `REQUEST_FINGERPRINT_BROKEN` | NO |
| signer DID | `SIGNER_CHANGED_AFTER_APPROVAL`, `REQUEST_FINGERPRINT_BROKEN` | NO |
| destination room | `DESTINATION_ROOM_CHANGED_AFTER_APPROVAL`, `REQUEST_FINGERPRINT_BROKEN` | NO |
| intended operation | `OPERATION_CHANGED_AFTER_APPROVAL`, `OPERATION_NOT_PERMITTED` | NO |
| upstream pin | `UPSTREAM_PIN_NOT_ADOPTED` / `APPROVED_UPSTREAM_PIN_NOT_ADOPTED` | NO |
| request id | `APPROVAL_REQUEST_ID_MISMATCH` | NO |

The committed TOCTOU dry run mutates the payload and reports:

```
stage            HANDOFF_REFUSED
findings         REQUEST_FINGERPRINT_BROKEN · BYTE_FREEZE_BROKEN · PAYLOAD_MUTATED_AFTER_APPROVAL
signer contacted NO
events           PREPARED > REVIEWED > HANDOFF_REFUSED
POST_ELIGIBLE    NO
```

`HANDOFF_REFUSED` is emitted **before** any transport call. That ordering is the actual protection:
a refusal after the signer had already been asked would still have produced a signature over
attacker-chosen bytes.

## Consequences of a detected mutation

1. The approval is invalid. It is not repaired, downgraded or partially honoured.
2. The signer is not contacted. No challenge is built from a mutated request.
3. The request id is burned. Re-approving the mutated bytes requires `buildRequest` again, which
   derives a new `alr1-…` id from the new bytes.
4. Nothing is posted, because nothing was signed.

There is no override flag. No `--force`, no `--yes`, no "approve anyway" path exists in the adapter
surface, and adding one would break the tests that assert the refusal.

## What this model does not claim

- It does not defend against an attacker who controls the operator's screen at T1. If the bytes
  shown were already wrong, the freeze faithfully protects the wrong bytes. The mitigation is the
  reviewed diff, not the freeze.
- It does not defend against a compromised canonical signer. The adapter verifies what came back,
  but a signer that signs something other than the challenge is a custody-side failure.
- It is not network-level replay protection. Duplicate refusal is local operator safety only; see
  `docs/CANONICAL_SIGNER_ADAPTER.md`.
- It says nothing about whether posting is a good idea. `POST_ELIGIBLE` never means `POSTED`.

## Reproducing

```
pnpm airlock                       # prints the TOCTOU probe line
node --test blackbox/tests/adapter.test.mjs
```
