# CANONICAL SIGNER ADAPTER

Phase 3A.3. Adopted TCLK pin `d48e87343200e3115e243df39e8f295f5ce2e645`.
Implementation: `blackbox/airlock/adapter.mjs`. Tests: `blackbox/tests/adapter.test.mjs`.

The adapter is the narrowest thing that can sit between the Signature Airlock and the canonical
Windows-local signer: a courier. It carries an already-reviewed, byte-frozen request to the
signer's public interface, carries a signature back, binds that signature to the original request,
verifies it locally, and stops. It is not custody, not a signing authority, not an identity
authority, not a wallet, not a settlement rail, and not a Technocore writer.

No real canonical signer was accessed in this phase. `REAL_CANONICAL_SIGNER_ACCESSED=NO`,
`REAL_SIGNATURE_PERFORMED=NO`.

## Public interface being targeted

From `docs/CANONICAL_SIGNER_INTERFACE_AUDIT.md`, re-read for this phase and unchanged:

| Question | Answer |
| --- | --- |
| Transport | in-process Python call inside the trusted runtime; no socket, no CLI, no URL |
| Surface | `technocore_agent.signer.service.Signer.sign_room(room: str, text: str)` |
| Request schema | two positional strings. No key parameter, no caller-supplied nonce, no payload blob |
| Canonical bytes | `canonical_message(room, nonce, text)`; the signer reserves the nonce from `NonceStore` at signing time |
| DID input | none. The signer knows its own DID; the caller cannot select a key |
| Approval semantics | `ControlPlane.approve_and_execute(draft_id, session, fresh_passphrase)` — trusted coordinator only, fresh operator passphrase per execution |
| Result | `SignedOperation(did, room, nonce, signature, text)` — non-secret |
| Verification | `verify_contribution_proof(proof)` / `_public_key_from_did`, gated on `did:key:z6Mk` Ed25519 |
| Error model | `SignerInputError` for anything that does not belong in the signed lane |
| Dry run | **none.** No validate/prepare surface stops short of signing |

`CANONICAL_SIGNER_CHANGE_REQUIRED=NO` for this phase: the adapter is implementable entirely inside
`flop-tclk-lab` against that surface as it exists. Nothing in `technocore-agent-canonical` was
modified, and no file under it was opened beyond the non-secret sources already covered by the audit.

The one structural consequence is recorded rather than worked around: because `sign_room` reserves
the nonce itself, the Airlock cannot freeze a preimage that already contains the nonce. The adapter
therefore freezes the **text** — the canonical TCLK frame bytes — and treats `room | nonce | text`
as the signer's own composition, checking the returned nonce and room against the frozen request
after the fact. That is the same arrangement the existing Airlock verification uses.

## Contract

```
signFrozenAirlockRequest({ request, approval }, { mode, transport, ledger, nowMs, signedAt })
```

Input must carry: `schema`, `requestId`, `signerDid`, `canonicalPayload`, `canonicalHash`,
`upstream.sha`, an approval whose `stage` is `REVIEWED`, and the request fingerprint that binds
them (`byteFreezeFingerprint`, implemented as `requestFingerprint`).

Ten checks run **before** the transport is touched. All ten failures are pre-handoff:

1. adapter mode known;
2. Airlock schema recognised;
3. request id well formed;
4. `canonicalHash` recomputed from `canonicalPayload`;
5. request fingerprint intact (the byte freeze);
6. approval present and the operator acknowledgement exact;
7. signer DID parses as `did:key:z6Mk` Ed25519;
8. upstream pin equals the adopted pin, on both the request and the approval;
9. freshness — not expired, not future-dated;
10. duplicate/replay state clean, operation is `post_frame`, `publicPostingEnabled === false`, and
    the approved payload survives TCLK's `cleanText` sweep unchanged.

If any check fails the signer is not contacted. The result is `HANDOFF_REFUSED` (or
`DUPLICATE_REQUEST_REFUSED`) with `signerContacted: false`.

## Response handling

Only four fields are read from the signer: `requestId`, `signerDid`, `signature`, `canonicalHash`,
plus the `room` and `nonce` the signer chose. `acceptSignerResponse` fails closed on any key whose
name is custody-shaped — `privateKey`, `seed`, `mnemonic`, `passphrase`, `secretKey`,
`decryptedKey`, `keyHandle`, `keystore`, `keyMaterial`, `dpapi*`, `entropy`, `xprv`, `wif`,
`credential(s)` — at any depth. The offending value is never read, printed, or logged; only the
field's name is reported, as a code.

Binding checks then run: request id matches, signer DID matches, canonical hash matches, the
signature verifies over the exact frozen bytes, the upstream pin is still the adopted pin, the
destination room and operation are unchanged, and the approval is still valid. Only then
`POST_ELIGIBLE=YES`.

`POST_ELIGIBLE` never means `POSTED`. Nothing in this lab can post; the public boundary is held
shut for the whole of Phase 3A.

## Modes

`MOCK` — the published deterministic test-vector signer. This is the only mode that produces a
signature in this phase, and the signature is from a test vector, not from a custody key. Signer
kinds are allow-listed to `TEST_VECTOR_SIGNER` / `MOCK_SIGNER`; a real transport presented in
`MOCK` mode is refused with `REAL_SIGNER_NOT_PERMITTED_IN_THIS_PHASE`.

`REAL_INTERFACE_DRY_RUN` — asks the transport for a non-signing compatibility probe. The audited
canonical signer has no such surface, so the adapter reports
`REAL_INTERFACE_DRY_RUN=NOT_SUPPORTED`, reason `NO_NON_SIGNING_DRY_RUN_SURFACE`, and does not
invoke the real signer. Had a probe existed and returned anything signature-shaped, that too would
be refused (`DRY_RUN_RETURNED_SIGNING_MATERIAL`).

## Operator approval

Unchanged and not bypassed. There is no `--yes`, no `--force`, no auto-confirm, no headless
approval path. The adapter has no passphrase parameter and no field that could carry one: if the
real signer is ever wired in, `ControlPlane.approve_and_execute` prompts the operator itself and
the adapter never sees, captures, or persists the value.

## Byte freeze, end to end

`AIRLOCK_TO_SIGNER_BINDING_HASH` (`airlockToSignerBinding`) hashes four layers — the Airlock
request, the operator's frozen copy, the signer input representation, and the returned response —
and asserts all four refer to one canonical payload. It contains hashes and lengths only, no
secret material and no payload text.

## Event log

`PREPARED`, `REVIEWED`, `HANDOFF_ALLOWED`, `SIGNER_RESPONSE_RECEIVED`, `LOCALLY_VERIFIED`,
`POST_ELIGIBLE`, plus failure codes (`HANDOFF_REFUSED`, `SIGNER_REFUSED`,
`SIGNER_RESPONSE_REFUSED`, `LOCAL_VERIFY_FAILED`, `POST_ELIGIBILITY_REFUSED`,
`REAL_INTERFACE_DRY_RUN_NOT_SUPPORTED`, `DUPLICATE_REQUEST_REFUSED`). Entries carry hashes,
counts and references — never key material, never a passphrase, never operator credentials. The
log rejects any code outside that list, so a future edit cannot smuggle a new event shape in.

## CUSTODY SEAL

A deterministic `CS1-XXXX-…` fingerprint over the request, the byte freeze, the signer response
and the local verification result.

It means exactly one thing: **these local artifacts were cryptographically bound to the same
approved canonical payload.**

It does not mean a trusted human, economic settlement, FLOP eligibility, official FLOP
verification, or that anything was posted. The seal is emitted only when local verification
passes, and it is recomputable from non-secret artifacts alone.
