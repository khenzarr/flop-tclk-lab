# Phase 3B — One Deal Plan (DOCUMENT ONLY)

Not executed. Nothing in this document was performed. Phase 3A ends before any
public activity. Executing this plan requires separate explicit operator approval.

Sources read: `examples/live-deal.mjs`, `SPEC.md`, the MCP implementation and the
transcript/rail changes at upstream `103a1b960c117c82473ee058b7dca1769e167125`
(upstream head when Phase 3A ran; a comparison head, not the pin).

## Upstream status for this plan (Phase 3A.1)

The pin is still `81a83464bd909fb5cd80de647da4e42fbae177dd`. Phase 3A.1 re-verified upstream and
found `main` at `d48e87343200e3115e243df39e8f295f5ce2e645`, five commits ahead, so the re-pin was
not taken and `evidence/phase3b-public-footprint-preview.json` was **not** regenerated: it is
still generated against the pin in force and is therefore still current, not superseded.

Four of those five commits tighten things a live rehearsal would hit, and they are preconditions
for Phase 3B whenever the pin does move — each one fails closed, so a rehearsal that ignores them
gets a refusal, not a bad post:

- decode-side cap on room messages (#60);
- narrowed published-frame schema (#59);
- stricter hex rejection, with reasons that do not echo the offending input (#63);
- accept-path refusals for a contradictory receipt rail/ref pair and a zero adaptor witness (#51).

Phase 3B must not be executed against a pin whose semantics have not had a drift pass. Re-run
`pnpm compat:matrix` against whatever head is current at that time first.

## Purpose

Prove one thing: that a real signed TCLK deal, conducted through the real venue,
produces a transcript that Blackbox can deterministically replay into an Evidence
Capsule. One intentional deal, minimum public footprint, no value at risk.

Not in scope: economic settlement, counterparty discovery, throughput, or any
claim about finality.

## Roles

| Role | Identity | Notes |
|---|---|---|
| A — offerer | ours, test-only DID | signs via the trusted local signer through the Airlock |
| B — claimer | ours, test-only DID | second local identity, separate DID |

Both identities are ours. No third party is involved, so no one else's data
enters the transcript and no counterparty can be harmed by an abort. Neither DID
is a wallet identity.

Private keys stay in the canonical local-agent's custody the entire time. TCLK
never receives a key; Blackbox never receives a key.

## Rooms

- Public rendezvous: `tclk-offers` — exactly **one** offer frame. Nothing else.
- Deal room: derived per SPEC from the offer, not chosen by us.

`tclk-offers` is a shared venue. One offer is a rehearsal; repeated offers are
spam. If the first attempt fails, see abort conditions — the answer is not
"post another offer".

## Expected public frames

| # | Room | Frame | Signer | Public |
|---|---|---|---|---|
| 1 | `tclk-offers` | `offer` | A | yes |
| 2 | deal room | `claim` | B | yes |
| 3 | deal room | `accept` | A | yes |
| 4 | deal room | `lock` | A | yes |
| 5 | deal room | `reveal` | B | yes |
| 6 | deal room | `receipt` projection | A | yes |

Six frames total, each one prepared, reviewed and BYTE FROZEN through the
Airlock, verified locally, and only then posted. Any frame that does not reach
`POST_ELIGIBLE=YES` is not posted.

`evidence/phase3b-public-footprint-preview.json` carries the machine-readable
preview with canonical hashes, generated without signing anything.

## PaperRail

PaperRail only. No value-bearing rail, no wallet connection, no settlement
network. The rail statement is a declaration inside the frame, not a transfer.

Upstream now normalises rail ids and matches rail sets order-independently, so
the offer's rail set and the lock's rail reference must agree under
`normalizeRailIds` — a check to run locally before posting, not after.

## Public vs local

Public: the six frames, their canonical text, signer DIDs, nonces, venue
sequence numbers and timestamps, and the room names.

Local only: private keys, the Airlock request/response envelopes, operator
approval records, the reveal preimage until the reveal frame is deliberately
posted, and every Blackbox artefact.

The preimage is the one item where ordering matters. It is confidential until
frame 5 and public afterwards, by design. Nothing else crosses that direction.

## Deadlines

Choose deadlines so the lawful path is unambiguous under current head's tightened
guard: the lock must be posted while the refund window is still closed
(`nowMs < refundAfterMs`). Upstream `103a1b9` rejects a lock once the refund
window is open — the same guard that flipped our `normal-refund` fixture.

Concretely: a claim window comfortably longer than a human review cycle, and a
refund window that does not open until well after the reveal is expected. Airlock
review is a human step; deadlines must budget for it.

## Duplicate prevention

Three layers: the Airlock ledger refuses a second use of a completed request id;
the canonical signer's `NonceStore` allocates durable non-reusable nonces; and
the venue's own sequence numbering is observed but not relied upon.

Rule for the operator: an uncertain outcome is never resolved by re-posting.
Read the room first.

## Reconciliation when uncertain

`submit()` can return `unknown`, and `reconcile` deliberately does not claim
rejection when a message is absent. On `unknown`: stop, read the room, and match
on the exact bound DID and nonce. If a matching message exists the frame landed;
if not, the outcome stays `unknown` and is recorded as `unknown`. Never
optimistically re-send.

## Evidence collection

Per frame: the Airlock request fingerprint, the response envelope, the local
verification result, and the venue receipt if one is returned. At the end: the
room transcript export as complete signed transcript records — `line`, `room`,
`seq`, venue timestamp, `sender`, `nonce`, `signature` — because current head's
`foldTranscript` requires that shape and verifies both signature and sender
binding.

Bare frame lines are no longer sufficient. An export that lacks records cannot be
folded, and that failure must be reported rather than worked around.

## Blackbox import and replay

`blackbox/core/live-import.mjs` consumes the sanitised transcript, preserving
room, generation when available, `seq` as observation metadata, exact frame text,
verification result, and the completeness limitation. It stays inert until this
phase is approved.

`OBSERVED != COMPLETE` is preserved end to end. An exported room transcript is
not claimed to be complete unless completeness is proven, and it will not be.

Replay then produces an Evidence Capsule per `docs/BLACKBOX_EVIDENCE.md`.

## Blocking precondition

Upstream issue **#61** claims the SPEC §2 room binding is unsatisfiable on the
shared venue, and that `foldTranscript` therefore rejects every live deal. If
that holds, this rehearsal produces a transcript we cannot fold — the evidence
chain would be unusable and the public footprint would be spent for nothing.

**Phase 3B does not start until the room-binding question has an upstream
answer.** Issues #3, #2, #45 and #56 describe venue-level failure modes (room
cap, 5xx handling, unbounded attempts) that one intentional deal could plausibly
hit; they inform the abort conditions below rather than blocking outright.

Per the phase separation rule, nothing was opened, commented on or modified
upstream. #61 is indexed as risk, not engaged.

## Abort conditions

Abort — do not retry, do not post again — on any of:

- any frame failing to reach `POST_ELIGIBLE=YES`
- any Airlock verification finding
- `submit()` returning `unknown` and reconciliation not resolving it
- the venue rejecting a frame for a reason not predicted locally
- a transcript export that cannot be folded
- upstream drift mid-rehearsal (pin changed under us)
- any secret appearing anywhere it should not
- any impulse to post a second offer to `tclk-offers`

Abort leaves a partial public trail. That is acceptable and expected: a partial
trail of our own test identities harms nobody, and the incomplete transcript is
itself evidence. Recording an honest partial outcome is preferable to forcing
completion.

## What this rehearsal would prove

That one real signed deal round-trips from Airlock approval through the live venue
into a deterministic Blackbox replay.

## What it would not prove

- Not that the venue is reliable — one deal is one sample.
- Not that the transcript is complete.
- Not that anything settled. PaperRail moves no value.
- Not that a third-party counterparty would behave as our second identity did.
