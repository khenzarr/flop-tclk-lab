# Phase 3 Evidence Chain

Six artefacts, each proving something narrow. The chain is only as strong as the
weakest link, and one link is explicitly weak on purpose.

```
Technocore receipt
      ↓
signed TCLK frame
      ↓
room transcript
      ↓
Blackbox deterministic replay
      ↓
Blackbox Evidence Capsule
      ↓
Airlock request/response fingerprints
```

The last item is not downstream of the others in time — it is the local record of
the custody handoff that produced the signature, and it binds back to the frame.
It sits last in the list because it is the link that closes the loop.

## 1. Technocore receipt

Proves the venue acknowledged a submission at a point in time, with the fields the
venue chose to return.

Does not prove: that the frame is semantically valid TCLK; that the room
transcript is complete; that anything settled; that the absence of a receipt means
rejection. `submit()` returns `accepted` / `rejected` / `unknown`, and `unknown`
stays `unknown`.

## 2. Signed TCLK frame

Proves the holder of a specific private key authorised these exact canonical bytes
— `room|nonce|clean_text(text)` — verifiable offline against the `did:key`.

Does not prove: that the signer understood the deal; that the frame was accepted;
that the DID corresponds to any real-world party. Identity binding is to a key,
not a person.

## 3. Room transcript

Proves a sequence of records was observed in a room, each with `line`, `room`,
`seq`, venue timestamp, `sender`, `nonce` and `signature`. At current upstream
head `foldTranscript` verifies both the signature and the sender binding on each
record, so a transcript that folds carries per-record authentication.

Does not prove completeness. **OBSERVED != COMPLETE.** An export shows what was
observed at the time of export. Missing records, withheld records and records
posted after export are all indistinguishable from an empty tail. Nothing in this
chain claims otherwise, and `blackbox/core/live-import.mjs` records the
completeness limitation as data rather than dropping it.

## 4. Blackbox deterministic replay

Proves that given a specific frame sequence and a specific upstream commit, the
TCLK state machine reaches a specific terminal state — reproducibly, byte for
byte, on any machine.

Does not prove: that the frame sequence was the whole story; that upstream's
semantics are correct; that a different pin would agree. The `normal-refund`
divergence in `docs/BLACKBOX_UPSTREAM_COMPATIBILITY.md` is a live demonstration
that replay is pin-relative, which is why every fingerprint binds the commit.

## 5. Blackbox Evidence Capsule

Proves a self-contained, verifiable bundle: inputs, upstream pin, per-step
outcomes, state digests and a replay fingerprint that a third party can recompute.

Does not prove the inputs were complete or honestly collected. A capsule is a
faithful record of what it was given. It makes tampering with the record
detectable; it cannot make the record exhaustive.

## 6. Airlock request/response fingerprints

Proves that a specific operator approved specific canonical bytes at a specific
local time, that a signature was returned bound to that request id, DID and hash,
that local verification passed, and that the bytes did not change between approval
and signature — BYTE FREEZE.

Does not prove: that anything was posted (`POST_ELIGIBLE` is not `POSTED`); that
the venue would accept it; that the operator read the human interpretation. It
proves what they approved, not what they understood.

## Where the chain is strongest

Links 2, 4, 5 and 6 are cryptographic or deterministic — independently
recomputable with no trust in us. Anyone can verify a signature against a DID,
re-run a replay at a pin, recompute a capsule fingerprint, or recompute a request
fingerprint.

## Where the chain is weakest

Link 3. Transcript completeness is not provable from the outside, and we do not
pretend it is. Every downstream artefact inherits that limitation and carries it
forward explicitly rather than silently.

Link 1 is second weakest: a venue receipt is an assertion by the venue about
itself.

## What the whole chain proves together

That an operator approved exact bytes, a key authorised exactly those bytes, the
venue acknowledged them, they appeared in an observed transcript, and replaying
that transcript at a named upstream commit deterministically reaches a named
terminal state.

## What it never proves

That the transcript was complete, that value moved, that anything is final, or
that either DID maps to a legal person. No settlement claim, no finality claim,
no blockchain claim.
