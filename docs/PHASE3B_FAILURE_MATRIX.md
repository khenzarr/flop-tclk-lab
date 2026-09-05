# Phase 3B — Failure / Abort Matrix

Design only. No public execution has begun. Companion to
`docs/PHASE3B_PUBLIC_FOOTPRINT.md` at TCLK pin `d48e87343200e3115e243df39e8f295f5ce2e645`.

**Blind retry is NO in every row.** There is no cell in this matrix that authorizes
resending bytes without first proving public state by reading.

## Matrix

| # | Boundary | Safe to abort? | Requires reconciliation? | May retry? | Fresh human approval? |
| --- | --- | --- | --- | --- | --- |
| 1 | Before signature | YES, cleanly | NO | N/A | YES to resume |
| 2 | After signature, before submit | YES — signature is local, nothing public | NO | Submit is not a retry; it is the untouched first attempt | YES, and the submit budget must still be unspent |
| 3 | During submit, unknown result | YES, but the write is left `SUBMISSION_UNCERTAIN` | **YES, mandatory** | NO — never blind | YES for any later action |
| 4 | Submit rejected (definite 4xx) | YES | Recommended, to confirm nothing landed | NO for identical bytes; a corrected frame is a new write | YES |
| 5 | Submit acknowledged, not yet observed | YES — the frame is probably public | YES, to reach `OBSERVED_PUBLIC` | NO | Only to continue to the next write |
| 6 | Observed malformed / unexpected | YES | YES — record exactly what was observed | NO | YES; treat as a finding, not a bug to paper over |
| 7 | Wrong room | YES — halt the deal | YES | NO. The misplaced frame is public and permanent | YES; a correct-room frame is a NEW write with a new budget |
| 8 | Wrong signer (role violation) | YES — halt | YES | NO. The pin will reject it: `cannot accept own offer` / `only the payer locks` / `only the payee reveals` | YES; requires fixing the party model first |
| 9 | State conflict (frame does not fit current status) | YES | YES — re-derive state from observed frames | NO | YES |
| 10 | Nonce conflict (nonce not strictly increasing for that DID+room) | YES | YES — read the room to learn the effective floor | NO with the same nonce. A strictly greater nonce is a new signature and a new write | YES |
| 11 | Timeout | YES, as `SUBMISSION_UNCERTAIN` | YES | NO | YES |
| 12 | Network loss | YES, as `SUBMISSION_UNCERTAIN` | YES | NO | YES |

## Notes that change decisions

**Row 3 is the important one.** The canonical transport maps 408, 425, 429, all 5xx, and any
2xx whose receipt cannot be verified to `unknown`. `unknown` means the frame may well be
public. Treating it as failure and resending is exactly the mistake this matrix exists to
prevent. The only legal successor is a bounded read matching own DID, exact signed nonce,
and exact canonical text hash.

**Absence is qualified, never absolute.** Venue enforcement and readability are bounded to
recent room history. A negative reconciliation result is recorded as
`PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW`, not as proof the frame never existed. Any retry
decision built on it must be explicit that it rests on bounded evidence.

**Burning a nonce is cheaper than double-posting.** Skipped nonces are legal
(`SKIPPED_NONCES_ALLOWED=YES`). When a nonce's fate is unknown, abandon it and move to a
strictly greater one under fresh approval. Never reuse a nonce whose outcome is uncertain.

**Rows 7 and 8 are not recoverable in place.** A frame that reached a public room cannot be
retracted. The honest response is to record it in the Evidence Capsule as what happened,
including in the Rejection Boundary if the venue or machine rejected it, and to treat the
corrective frame as a new public write with its own approval and its own budget identity.

**Signature without submission is a normal resting state, not an error.** Row 2 exists so
that aborting between signing and submitting is a first-class, safe outcome. `SIGNED` never
implies `SUBMITTED`.

**One aborted write must not brick the rest.** Per-write budget identities
(`p3b-sign-w<N>`, `p3b-submit-w<N>`, `p3b-reconcile-w<N>`) mean an uncertain write #2 leaves
writes #3 and #4 still executable once the operator has reconciled and re-approved.

**Fresh approval means fresh identity.** Any retry that survives reconciliation runs under a
newly minted budget identity in a new execution id. A spent one-shot is never topped up,
reset, or recycled.
