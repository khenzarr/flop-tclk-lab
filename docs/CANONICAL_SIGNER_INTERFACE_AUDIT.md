# Canonical Local Signer — Interface Audit

Subject:
`C:\Users\mertb\Desktop\NODE\technocore-agent-canonical\canonical\public-release\local-agent`

Access: **read-only**. Nothing in that tree was modified. Only public source,
public interfaces, request/response schemas, signer routing, approval flow,
public verification logic and test names were read.

Not opened: private seeds, decrypted keys, DPAPI secret blobs, passphrases,
backup secrets, secret environment values, operator credentials, or any file
whose purpose is private key material. No secret content is reproduced here.

`REAL_CANONICAL_SIGNER_ACCESSED = NO` — the signer was read as an interface, never
invoked, and no key was loaded.

## Public input the signer expects

`technocore_agent.signer.service.Signer.sign_room(room: str, text: str)`.

Two public arguments. No payload blob, no URL, no key parameter, no caller-supplied
nonce. `stage2a_local.InMemorySigner.sign_room` has the same shape, which
confirms the signature is domain-specific by design rather than a general-purpose
signing oracle.

Preimage construction lives in `signer/canonical.py`:

- `clean_text(text)` — the server's control/invisible-character sweep and length limit
- `canonical_message(room, nonce, text)` — the exact UTF-8 string that gets signed
- `SignerInputError` — raised on anything that does not belong in the signed lane

`room` must be a non-empty string with no `|`. The delimiter is load-bearing, so
the field rejects the character that could forge a boundary.

## Public output it returns

`SignedOperation(did, room, nonce, signature, text)` — a frozen slotted
dataclass. `canonical_did(key)` derives the Ed25519 `did:key`.

Non-secret by construction: a public DID, the room, the nonce, the signature, and
the cleaned text. No key bytes, no key handle, no path to key material.

## Operator approval boundary

The agent-facing boundary is draft-only. `ipc/draft_protocol.py` decodes what it
calls "the complete, intentionally untrusted, agent capability surface", and
`encode_agent_response` allow-lists the reply to
`{draft_id, request_id, status, error}`. `DraftIPCServer` is documented as
"loopback-only, unprivileged draft endpoint; never a signer control endpoint".

Approval is a separate trusted plane:

- `control/drafts.py` — `DraftStore`, `draft_fingerprint(operation, room, cleaned_text)`
- `control/approval.py` — `ApprovalStore`, "raw session credentials never enter this store"
- `control/operator.py` — `OperatorAuth`, only a verifier is persisted
- `control/service.py` — `ControlPlane.approve_and_execute(draft_id, session, fresh_passphrase)`,
  "trusted coordinator; agent-facing code has no reference to this object"

`service/runtime.py` holds `DPAPIKeyProvider` and `TrustedRuntime`, "the sole
runtime owner of trusted stores, authentication, key, and signer".

The test names assert the same boundary the source implies:
`test_ipc_schema_has_no_key_channel`,
`test_agent_boundary_is_draft_only_and_prompt_injection_cannot_approve`,
`test_approval_exact_binding_and_one_time_consumption_across_restart`,
`test_rejection_cannot_be_reactivated`,
`test_secret_is_not_printed_or_returned`,
`test_signed_restart_is_never_automatically_submitted`.

## Verification behaviour

`evidence/contribution.py` exposes `verify_contribution_proof(proof)` and derives
a public key from a DID with `_public_key_from_did`, gated on a `did:key:z6Mk`
prefix and an exact length. Verification is local and offline.

`policy/transport.py` separates submission from truth: `submit()` returns
`accepted` / `rejected` / `unknown`, and `reconcile` "never claims rejection when
message is absent". `storage/nonce.py` carries a durable `OperationStore` and a
`Reconciliation` state set, so an uncertain outcome stays uncertain rather than
being resolved optimistically.

That posture matches our own `OBSERVED != COMPLETE` rule, which is why the
evidence chain can span both systems without either one overstating.

## What the Airlock already lines up with

| Airlock | Canonical local-agent |
|---|---|
| `canonicalMessage(room, nonce, text)` | `canonical_message(room, nonce, text)` |
| `cleanText` | `clean_text` |
| `did:key` Ed25519 codec + local verify | `canonical_did` / `_public_key_from_did` |
| request envelope | draft record |
| operator approval + fingerprint | `ApprovalStore` + `draft_fingerprint` |
| `AirlockLedger` duplicate refusal | `OperationStore` idempotency |
| response allow-list | `encode_agent_response` allow-list |

The Airlock's `signApprovedChallenge` return shape
(`requestId`, `signerDid`, `signature`, `canonicalHash`) is a strict subset of
what `SignedOperation` already exposes publicly.

## Two frictions, both outside custody

**1. The nonce is signer-owned, not caller-owned.**

`Signer.sign_room` reserves the nonce itself from `NonceStore` at signing time.
The Airlock therefore cannot freeze a preimage that already contains the nonce.

This is correct behaviour on their side — durable, crash-safe, non-reusable nonce
allocation is exactly what should own that field, and letting a caller choose it
would weaken replay protection. The consequence for us is a scoping rule, not a
defect: **BYTE FREEZE covers `(room, clean_text(text))`**, and the nonce is a
signer-assigned field observed in the response. Our verification recomputes
`room|nonce|clean_text(text)` using the returned nonce and checks the signature
over that, so the freeze still binds everything the operator actually approved.

`docs/SIGNATURE_AIRLOCK.md` and the response schema both carry `nonce` as a
returned field for this reason.

**2. `approve_and_execute` approves, signs and submits in one call.**

The Airlock needs signature-only return — sign, then stop, so local verification
runs before anything public happens. The existing entry point would post as part
of approval.

Everything needed for a sign-only path already exists internally: the signer
produces `SignedOperation` before `TechnocoreTransport.submit` is called, and
`test_signed_restart_is_never_automatically_submitted` shows a signed operation
already survives without being submitted. What is missing is a public entry point
that stops at that point and returns the non-secret `SignedOperation`.

That is a routing change, not a custody change. The key stays inside
`TrustedRuntime`/`DPAPIKeyProvider`. No new key channel, no new IPC secret, no
loosened ACL, no change to DPAPI handling.

## Can the Airlock integrate without exposing key material?

Yes. The Airlock never needs a key, a seed, a passphrase or a decrypted blob. It
needs a public DID, a signature over an exact preimage, and the nonce that was
assigned. All three are already public outputs.

## Classification

**`REQUIRES_SMALL_SAFE_ADAPTER`**

Not `READY_WITH_EXISTING_PUBLIC_INTERFACE`, because the only public approval
entry point also submits, and signature-only return is a hard Airlock
requirement.

Not `REQUIRES_CUSTODY_CHANGE`. Nothing here asks the signer to hand over key
material, accept an arbitrary payload, or relax the draft-only agent boundary. If
integration had required any of those, this phase would have stopped — we do not
weaken custody for TCLK.

## Eventual adapter, stated precisely

A sign-only method on the trusted control plane that:

1. accepts a draft id plus an authenticated operator session, exactly as today;
2. requires the approved `(room, cleaned_text)` to match the stored draft
   fingerprint;
3. calls `Signer.sign_room` and returns the non-secret `SignedOperation`;
4. does **not** call `TechnocoreTransport.submit`;
5. leaves the approval unconsumed, or records it as signed-not-submitted, so
   posting stays a separate deliberate act.

Submission remains theirs. The Airlock's job ends at
`POST_ELIGIBLE = YES | NO`.

**No change was made to the canonical local-agent tree in this phase, and none is
proposed for Phase 3A.**

## What this audit does not establish

- It does not prove the canonical signer is free of defects. It reads interfaces
  and boundaries, not the full implementation.
- It does not prove DPAPI or ACL behaviour on this machine; those tests were not
  run and the relevant files were not opened.
- It does not constitute agreement from the canonical local-agent's maintainer
  that the adapter above will be added.
