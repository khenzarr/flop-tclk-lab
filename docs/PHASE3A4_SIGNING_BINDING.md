# PHASE 3A.4 — TCLK CANONICAL FRAME vs TECHNOCORE SIGN_ROOM PREIMAGE

Two different byte strings are involved in "signing a TCLK frame", and conflating them would
overstate what a DID signature proves. This document states the layering precisely. No real
signature exists — Gate A refused (see `PHASE3A4_SIGNER_SIDE_EFFECT_AUDIT.md`) — so everything
below describes what a signature *would* cover, derived from the canonical signer's source and
the adopted pin's encoder.

## The two layers

    LAYER 1 — TCLK_CANONICAL_FRAME
      produced by   tclk.encodeFrame(frame)              (adopted pin d48e873)
      shape         deterministic canonical JSON of the protocol frame
      covers        type, from, contract, statement, nonce, terms — the protocol meaning
      frozen by     BYTE FREEZE (blackbox/airlock/envelope.mjs)
      hashed as     canonicalHash = sha256(canonicalPayload)

    LAYER 2 — TECHNOCORE_SIGN_ROOM_PREIMAGE
      produced by   canonical_message(room, nonce, text) (technocore_agent.signer.canonical)
      shape         room | nonce | clean_text(text)
      covers        the room, a custody-chosen nonce, AND the swept Layer 1 bytes
      frozen by     nothing — the nonce does not exist until custody reserves it

Layer 2 strictly contains a *transformed* Layer 1, plus two fields the airlock cannot know in
advance. `TCLK_CANONICAL_FRAME != TECHNOCORE_SIGN_ROOM_PREIMAGE`, and the containment is not
plain concatenation because of `clean_text`.

## Why the nonce cannot be in the freeze

`Signer.sign_room` reserves the nonce durably inside custody (`storage/nonce.py`) *after* the
airlock has already frozen its bytes. So the airlock can freeze `text` and `room`, but not the
preimage. The lab's design consequence, already implemented in `verify.mjs`, is that verification
reconstructs the preimage from `approval.intendedRoom` + `response.nonce` +
`approval.frozenPayload` and checks the signature over *that*. The nonce is accepted from the
response and bound, never predicted. `docs/SIGNATURE_AIRLOCK.md` records this under "What BYTE
FREEZE does not cover".

## `clean_text` is a real transform, not a formality

`clean_text` (canonical signer) and the lab's mirror `cleanText`
(`blackbox/airlock/signer.mjs:30`) both:

- replace every `\p{Cc} \p{Cf} \p{Cs} \p{Co} \p{Zl} \p{Zp}` character with a space,
- `.strip()` / `.trim()` the result,
- reject empty output and output longer than 4096 characters.

If `clean_text(frame) != frame`, the signature covers the swept form and **not** the bytes the
operator approved. The airlock refuses that case rather than signing it:
`APPROVED_PAYLOAD_ALTERED_BY_VENUE_SWEEP` in both `validateHandoff` and `verifyResponse`. A frame
is therefore only signable if it is single-line, has no leading or trailing whitespace, and
contains no control or format characters. The adopted pin's `encodeFrame` output satisfies this
for the rehearsal frame; that is checked, not assumed (`sweepIsIdentity`).

## The `|` truncation hazard

Recorded because it is a genuine correctness trap in the canonical signer's return value, not in
its signature.

`sign_room` returns

    SignedOperation(self.did, room, nonce, signature, message.rsplit("|", 1)[1])

The final field is `message.rsplit("|", 1)[1]` — the text *after the last pipe*. If the cleaned
text itself contains a `|`, the signature still covers the full `room|nonce|text`, but the
returned `text` field is **truncated to the tail after the last pipe**. Anyone rebuilding the
preimage from the returned field would compute a different string and fail verification.

Two mitigations already hold in this lab:

1. `canonicalMessage` rejects a `room` containing `|` (`signer.mjs:39`).
2. Verification never trusts a returned text field: it rebuilds the preimage from
   `approval.frozenPayload`, the operator's own copy. The response envelope's allow-list
   (`verify.mjs:20`) does not even accept a `text` field.

A frame whose canonical JSON contains a `|` would still be a hazard for any *other* consumer of
`SignedOperation.text`. The rehearsal frame's bytes were checked and contain none.

## What a real signature would prove

Given a verified Ed25519 signature under DID `D` over `room|nonce|clean_text(frame)`:

**Would prove.** The holder of the private key for `D` produced a signature over that exact
preimage; the frame bytes inside it are the operator-approved canonical bytes; the destination
room and the custody-chosen nonce are bound into the same signature; the airlock request,
approval, byte freeze and response all refer to one payload (the binding chain in
`airlockToSignerBinding`).

**Would not prove.** That anything was posted. That Technocore received, accepted or ordered it.
That the nonce is valid at the venue. That a human approved anything beyond the local
acknowledgement. That the DID corresponds to a real person or a trusted party. Any settlement,
any value movement, any FLOP eligibility. That the frame is economically meaningful — a
syntactically perfect `accept` for a nonexistent offer verifies exactly as well as a real one.

## Signature-layer summary

| Question | Answer |
| --- | --- |
| Does the DID signature cover only the raw TCLK frame? | **No.** |
| What does it cover? | `room \| nonce \| clean_text(TCLK_CANONICAL_FRAME)` |
| Is the frame recoverable from the preimage? | Only if the frame contains no `\|` |
| Can the airlock precompute the preimage? | No — the nonce is custody-chosen |
| Is the freeze still meaningful? | Yes — it pins `text` and `room`, the two things it can pin |
| Was any real signature produced in Phase 3A.4? | **No.** Gate A refused. |
