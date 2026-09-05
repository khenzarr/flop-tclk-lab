# Phase 3B.0 — Public Technocore Footprint of ONE Controlled PaperRail Deal

Design and audit only. Nothing in this phase signed, submitted, or read live Technocore.

## Provenance (design authority)

| Item | Value |
| --- | --- |
| Blackbox HEAD reviewed | `24e0b01b3ed112896b580c04b19b805eefd32e0c` |
| Canonical signer implementation | `124d621dd8c68b04bed79744ab332e8305093d02` |
| Adopted TCLK pin | `d48e87343200e3115e243df39e8f295f5ce2e645` |
| Technocore nonce-semantics evidence | `82d942936050f1ab0fb9f34db17893b89f3e064b` |
| Canonical DID | `did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi` |

All three worktrees were clean at audit time. No newer upstream commit was consulted.

## Headline finding

**The minimal legal deal cannot be executed with one DID.** The adopted pin refuses a
self-deal at three independent points in `src/machine.ts`:

- `accept.from === state.offer.from` → reject `"cannot accept own offer"`
- `lock.from !== state.payerDid` → reject `"only the payer locks"`
- `reveal.from !== state.payeeDid` → reject `"only the payee reveals"`

`payerDid` and `payeeDid` are assigned from `offer.from` and `accept.from` by role, so they
are distinct by construction. A one-DID transcript stops permanently at `proposed` and the
only public write it can ever produce is the offer. Phase 3B execution is therefore
**BLOCKED** pending a second approved custody identity. No second key was created here.

## Part 1 — Adopted frame set

`ADOPTED_FRAME_SET = offer, accept, lock, reveal, refund, cancel, receipt, heartbeat`

`SEPARATE_CLAIM_FRAME = NO`

The prior expectation is re-proven: there is no `claim` frame. Claim intent rides on
`accept` — the payee mints `accept.statement` (hash lock: `sha256(preimage)`; point lock:
SEC1-compressed `Y = y·G`), and the claim is later effected by `reveal.secret`. `claimed`
is a status, not a frame. `TCLK_TERMINAL_STATUSES` = `claimed`, `refunded`, `cancelled`.

Frame requirements at the pin (`src/frames.ts`, `src/frame-fields.generated.ts`):

| Frame | Required | Optional | Notes |
| --- | --- | --- | --- |
| `offer` | `type,from,role,amount,asset,lock,rails,claimByMs,refundAfterMs,expiresMs,nonce,id` | `paymentKey,job` | `id` = sha256 over domain-tagged canonical offer fields; `paymentKey` required for point locks; `refundAfterMs` strictly after `claimByMs` |
| `accept` | `type,from,ref,statement,contract,nonce` | `paymentKey` | `contract` = sha256 over domain-tagged `{offer, accept-core}` |
| `lock` | `type,from,contract,rail,ref` | `presig` | `rail` must be one the offer listed |
| `reveal` | `type,from,contract,secret` | `ref` | `ref` must equal `lock.ref` when present |
| `refund` | `type,from,contract` | `ref,reason` | payer only, only after `refundAfterMs` |
| `cancel` | `type,from,contract` | `reason` | from `proposed` or `accepted` |
| `receipt` | `type,from,contract,outcome` | `rail,ref` | post-terminal acknowledgment, never a transition |
| `heartbeat` | `type,from,contract,nonce` | `note` | liveness only, state unchanged |

Envelope: `TCLK_VERSION = "tclk/1"`, wire prefix `"tclk1 "`, signing domain
`"FLOP::tclk::v1"`, `MAX_FRAME_CHARS = 4096` — one frame must fit one single-line room
message. Duplicate/replay handling is layered: the protocol rejects out-of-state frames,
`nonce` on `offer`/`accept`/`heartbeat` defeats the venue duplicate-text filter, and the
venue enforces strictly increasing per-DID-per-room nonces over bounded recent history.

## Part 2 — Minimal legal happy path

`MINIMAL_LEGAL_FRAME_SEQUENCE = offer -> accept -> lock -> reveal`

`MINIMAL_PUBLIC_WRITE_COUNT = 4 signed room writes + 2 unsigned PaperRail note writes = 6`

| Frame | Class | Why |
| --- | --- | --- |
| `offer` | MANDATORY | creates `proposed` |
| `accept` | MANDATORY | `proposed -> accepted`, mints statement and contract id |
| `lock` | MANDATORY | `accepted -> locked` |
| `reveal` | MANDATORY, TERMINAL | `locked -> claimed` |
| `receipt` | OPTIONAL | post-terminal only; rejected before a terminal status; adds no transition |
| `heartbeat` | OPTIONAL | never changes state |
| `refund` / `cancel` | ALTERNATIVE TERMINAL | not part of the happy path |

`receipt` is **not** protocol-required. It is excluded from the minimal footprint. The
claim transition happens inside `reveal`, not through a separate frame. The two rail-side
writes are PaperRail note mutations (`lock` creates the record, the claim advances it),
not signed frames.

## Part 3 — Party / DID model

`PARTY_MODEL = two role-bound parties: offer.from (one side) and accept.from (the other)`

Audit of whether the canonical DID may hold every role:

| Role | Single DID allowed? | Enforcement |
| --- | --- | --- |
| offer creator | YES | — |
| accepting party | **NO** | `"cannot accept own offer"` |
| locker | NO (must be payer) | `"only the payer locks"` |
| revealer | NO (must be payee) | `"only the payee reveals"` |
| receipt issuer | YES for either party | `isParty()` accepts offerer, payer or payee |

**`DISTINCT_DIDS_REQUIRED`**

A one-DID self-deal is not merely weak evidence — it is syntactically refused at `accept`.
No second identity was invented. The execution-plan portion stops here as instructed.

## Part 4 — Room topology

```
ROOM_TOPOLOGY
  tclk-offers                  offer, accept        public discovery lane
  mb-p-tclk-<contract[2..18]>  lock, reveal         signed-only unlisted mailbox
  KV tclk-paper-<id[2..4]> / <id[4..18]>            PaperRail record (unsigned, world-writable)
  KV tclk-<id[2..4]> / <id[4..18]>                  state note (unsigned, world-writable)
```

`SHARED_DISCOVERY_ROOM_REQUIRED = YES, for offer and accept only`

`DEDICATED_DEAL_ROOM_SUPPORTED = YES, for lock and reveal`

The deal room is deterministic from the contract id (`dealRoom()` → `mb-p-tclk-` plus the
first 16 hex of the id, 26 chars, inside the venue grammar `^[a-z0-9][a-z0-9_-]{0,47}$`).
Because the `mb-` prefix refuses the unsigned lane, it is the lower-noise venue. It cannot
absorb the first two writes: the counterparty can only compute the contract id *after*
seeing the accept, so discovery and the accept must land where the offerer is listening.
This yields the minimal honest footprint — exactly 2 writes in the shared room, and the
remaining 2 in an isolated room nobody else polls. No other global room is touched.

## Public write plan

Values below are marked `KNOWN NOW` or `GENERATED AT EXECUTION`. No runtime-sensitive
value is faked, and no secret or preimage is generated or committed in this phase.

### PUBLIC WRITE #1

- **FRAME:** `offer`
- **ROOM:** `tclk-offers` (KNOWN NOW)
- **SIGNER:** party A, role `payer` (DID: GENERATED AT EXECUTION — depends on Part 3 resolution)
- **PUBLIC DATA:** `type`, `from`, `role=payer`, `amount`, `asset`, `lock=hash`,
  `rails=["paper"]`, `claimByMs`, `refundAfterMs`, `expiresMs`, `nonce`, `id`
- **HASH / COMMITMENT FIELDS:** `id`
- **TIMING FIELDS:** `claimByMs`, `refundAfterMs`, `expiresMs`
- **LINKAGE IDS:** `id` (referenced by `accept.ref`)
- **POTENTIALLY SENSITIVE:** signer DID becomes publicly linkable to the deal
- **STATE BEFORE:** none
- **STATE AFTER IF ACCEPTED:** `proposed`
- **PAPER RAIL:** YES · **VALUE MOVED:** NO · **SAFE:** YES

### PUBLIC WRITE #2

- **FRAME:** `accept`
- **ROOM:** `tclk-offers` (KNOWN NOW)
- **SIGNER:** party B, role `payee` — must differ from write #1 signer
- **PUBLIC DATA:** `type`, `from`, `ref`, `statement`, `contract`, `nonce`
- **HASH / COMMITMENT FIELDS:** `statement` = `sha256(preimage)`, `contract`
- **TIMING FIELDS:** none
- **LINKAGE IDS:** `ref` → offer id; `contract` → all later frames and both KV keys
- **POTENTIALLY SENSITIVE:** `statement` commits to the preimage; the preimage itself stays
  private until write #4
- **STATE BEFORE:** `proposed` · **STATE AFTER IF ACCEPTED:** `accepted`
- **PAPER RAIL:** YES · **VALUE MOVED:** NO · **SAFE:** YES (commitment only)

### PUBLIC WRITE #3

- **FRAME:** `lock`
- **ROOM:** `mb-p-tclk-<contract[2..18]>` (rule KNOWN NOW, value GENERATED AT EXECUTION)
- **SIGNER:** party A (payer) — `"only the payer locks"`
- **PUBLIC DATA:** `type`, `from`, `contract`, `rail="paper"`, `ref`
- **LINKAGE IDS:** `contract`, `ref` (rail reference, echoed by `reveal.ref`)
- **PRECONDITION:** rejected if `now >= offer.refundAfterMs`
- **STATE BEFORE:** `accepted` · **STATE AFTER IF ACCEPTED:** `locked`
- **SIDE EFFECT:** one unsigned PaperRail note write (`tclkpaper1 locked …`)
- **PAPER RAIL:** YES · **VALUE MOVED:** NO · **SAFE:** YES

### PUBLIC WRITE #4

- **FRAME:** `reveal`
- **ROOM:** `mb-p-tclk-<contract[2..18]>`
- **SIGNER:** party B (payee) — `"only the payee reveals"`
- **PUBLIC DATA:** `type`, `from`, `contract`, `ref`, **`secret`**
- **PRECONDITION:** rejected if `now >= offer.refundAfterMs`
- **STATE BEFORE:** `locked` · **STATE AFTER IF ACCEPTED:** `claimed` (TERMINAL)
- **SIDE EFFECT:** one unsigned PaperRail note write advancing the record to `claimed`
- **PAPER RAIL:** YES · **VALUE MOVED:** NO
- **SAFE:** YES **by protocol design, and only after write #3**

`SECRET_OR_PREIMAGE_PUBLICATION = YES, intentionally, at write #4 only`

Before reveal the preimage must never appear publicly; `statement` alone is public. After
reveal the pin deliberately publishes the 32-byte preimage — that publication *is* the
claim mechanism. The Phase 3B preimage must be generated only in the approved execution
phase, must never enter source control, and must never be logged into an evidence capsule.

---

**TOTAL PUBLIC WRITES:** 4 signed room writes + 2 unsigned KV note writes = 6

**TOTAL REAL SIGNATURES REQUIRED:** 4 — two per DID (A: offer, lock; B: accept, reveal).
KV note writes are unsigned and consume no signature.

**TOTAL NETWORK SUBMISSION ATTEMPTS:** 4 planned first attempts. No automatic second
attempt for any write, ever.

**TECHNOCORE READS REQUIRED FOR RECONCILIATION:** per write, one bounded room read
(`GET /r/<room>?format=json&limit=200`) matching own DID plus signed nonce plus canonical
text hash. Described here, executed in no phase before 3B.2.

**PUBLIC DID EXPOSURE:** both party DIDs, each in both rooms, permanently linkable to the
contract id.

**PUBLIC SECRET EXPOSURE:** the reveal preimage only, only at write #4, by design.

**PHASE 3A ARTIFACT REUSE:** NONE.

## Part 6 — PaperRail semantics

`RAIL = paper` · `VALUE_MOVED = NO` · `PAYMENT_PROOF = NONE` ·
`SETTLEMENT_CLAIM_ALLOWED = NO`

The pin describes itself plainly: a settlement rail that settles nothing, backed by a note
on a chat service that holds no funds and executes nothing. Its records are world-writable,
so `verifyLock() === true` means only that a string is present in a namespace a stranger
could have written.

The transcript will prove: four frames were signed by two keys, accepted into named public
rooms in order, and drove a state machine `proposed → accepted → locked → claimed` under a
reproducible pin. It will **not** prove real payment, token settlement, wallet transfer,
FLOP reward, or economic finality. PaperRail rehearsal is not payment. TCLK alpha is not
FLOP settlement. Future evidence is not reward eligibility.

## Part 7 — Identifier policy

`PHASE3B_IDENTIFIER_MATRIX` — no Phase 3A value is reused; no secret is created now.

| Identifier | Created | Public? | Persistence | Reuse policy |
| --- | --- | --- | --- | --- |
| execution id `p3b-<utc>-<8hex>` | FROZEN_NOW (rule) | no | evidence capsule | one execution only |
| offer nonce / id | GENERATED_AT_EXECUTION | yes | public room | never reused |
| contract id | GENERATED_AT_EXECUTION (derived) | yes | rooms + both KV keys | never reused |
| deal room name | GENERATED_AT_EXECUTION (derived) | yes | venue | never reused |
| request id per write `p3b-w<N>-<8hex>` | GENERATED_AT_EXECUTION | no | local ledger | one write only |
| budget identity per op | FROZEN_NOW (naming rule) | no | attempt-budget root | single-use, never recycled |
| evidence capsule id `p3b0-footprint-<sha>` | FROZEN_NOW | no | `evidence/` | append-only |
| reveal preimage | GENERATED_AT_EXECUTION | becomes public at write #4 | never in source control | single use |

`PHASE3A_ARTIFACT_REUSE = NONE`

## Part 8 — Durable real-operation budget model

`PHASE3B_BUDGET_MODEL = BOTH — one per-deal envelope plus one per-operation one-shot,
with sign and submit held as separate identities`

Built only on the reviewed durable primitive `blackbox/airlock/attempt-budget.mjs`. No new
budget subsystem. Phase 3A's retired `pnpm airlock:real-detached-sign` path is not revived.

```
p3b-deal-<execId>                     envelope, whole deal
p3b-sign-w<N>-<execId>     N = 1..4   one real signature each
p3b-submit-w<N>-<execId>   N = 1..4   one first submit each
p3b-reconcile-w<N>-<execId>           bounded read allowance, separate from submit
```

Eleven distinct one-shot identities for a four-write deal. Splitting sign from submit is
what makes `SIGNED != SUBMITTED` enforceable rather than aspirational: a signature can
exist with its submit budget untouched. Per-write identities are what keep an uncertain
write #2 from bricking writes #3 and #4 — the envelope alone would do exactly that. A
spent submit budget can never be topped up; an uncertain outcome routes to the reconcile
identity, never back to submit. Any retry after proven absence requires a fresh
human-approved identity minted under a new execution id.

## Part 9 — Frame lifecycle state machine

`FRAME_LIFECYCLE_STATE_MACHINE` — one instance per public write, persisted per write.

```
PLANNED
  -> AIRLOCK_APPROVED        human approval for this single write
  -> SIGNED                  detached signature exists; nothing sent
  -> SUBMIT_ATTEMPTED        bytes left the process
  -> ACK_RECEIVED            2xx plus receipt echoing own did/text/nonce and a seq in room
  -> OBSERVED_PUBLIC         independent bounded room read confirms the frame
  -> ACCEPTED_BY_MACHINE     replayed frame drives the expected transition

  SUBMIT_ATTEMPTED -> REJECTED              definite 4xx other than 408/425/429
  SUBMIT_ATTEMPTED -> SUBMISSION_UNCERTAIN  timeout, network loss, 408/425/429, 5xx,
                                            2xx with unparsable receipt
  SUBMISSION_UNCERTAIN -> RECONCILING -> OBSERVED_PUBLIC | PROVEN_ABSENT
  PROVEN_ABSENT -> ABORTED | (fresh human approval) -> PLANNED'
```

Terminal-for-this-write: `ACCEPTED_BY_MACHINE`, `REJECTED`, `ABORTED`.

Rules held: `SIGNED` never implies submitted. An ack is a transport claim, not public
state — `ACK_RECEIVED != OBSERVED_PUBLIC`, and the canonical transport itself downgrades a
2xx with an unverifiable receipt to `unknown`. `OBSERVED_PUBLIC` requires Technocore
evidence. From `SUBMISSION_UNCERTAIN` the only legal successor is reconciliation. Blind
retry is unreachable by construction. `PROVEN_ABSENT` does not authorize automatic retry.

## Part 10 — Nonce and observation reconciliation

`NONCE_AND_OBSERVATION_RECONCILIATION_PLAN`

Authoritative model (evidence `82d9429…`): signed room writes use nonces that are
`STRICTLY_INCREASING`, `PER_DID_PER_ROOM`, with `SKIPPED_NONCES_ALLOWED=YES`, enforced
against **bounded recent room history**, not permanent global history.

- Reserve locally before signing; record `(room, did, nonce, canonical text hash)` durably
  before any submit. Nonces are per DID **per room**, so party A's `tclk-offers` counter is
  independent of its `mb-p-tclk-…` counter.
- Identify a frame by the triple `(room, signed nonce, canonical line)`. Never by nonce
  alone; never by observed `seq`, which is venue-assigned and unrelated to the signed nonce.
- Uncertain submit → bounded read of the target room, matching own DID, exact signed nonce,
  and exact canonical text hash. Present → `OBSERVED_PUBLIC`. Absent within the bounded
  window → `PROVEN_ABSENT_WITHIN_BOUNDED_WINDOW`, which is explicitly weaker than absolute
  absence and must be recorded with that qualifier.
- A skipped nonce is legal and never a failure signal. A burned nonce is acceptable: the
  next write may use a strictly greater value. Never reuse a nonce whose fate is unknown.
- Room `seq` gaps mean missing sequence positions in that room, nothing more. They do not
  imply a lost TCLK frame and do not imply one-message-per-sequence semantics.
- Because enforcement is bounded, no permanent replay protection is claimed. Old enough
  history falls outside the server's window; the durable local ledger, not the venue, is
  the authority on what this DID has already signed.

No live read occurred in this phase.

## Part 11 — Write transport surface

`WRITE_TRANSPORT_SURFACE` — the adopted TCLK pin ships **no** transport: `src/` contains no
`fetch`, no `node:http`/`node:https`, no timeout and no retry logic. Transport is entirely
external, in the reviewed canonical agent at `124d621d`
(`local-agent/src/technocore_agent/policy/transport.py`, `TechnocoreTransport`).

- **Write:** `POST https://technocore.chat/r/<url-encoded room>?format=json`
- **Body:** `{"did","sig","nonce","text"}`, compact JSON, UTF-8
- **Headers:** fixed `Accept`, `Content-Type`, `User-Agent: flop-technocore-did/1`
- **Read:** `GET /r/<room>?format=json&limit=200&n=<clock>`
- **Response:** `{room, posted{seq,ts,from,nonce,text}, messages[]}`; a receipt is accepted
  only if it echoes the submitted did, text and nonce and its `seq` also appears in
  `messages` — otherwise the result is downgraded to `unknown`
- **Origin lock:** scheme/host/path pinned to `https://technocore.chat`; redirects refused
- **Bounds:** timeout constrained to 1–30 s (default 15 s), response capped at 1 MiB
- **Error classes:** `accepted` (verified receipt) · `rejected` (definite 4xx, or room name
  failing `^[a-z0-9][a-z0-9_-]{0,47}$` before any socket) · `unknown` (408/425/429, 5xx,
  2xx with unverifiable receipt, `OSError`, `TimeoutError`, `URLError`, `ValueError`)

`AUTOMATIC_RETRIES = NONE in the write path` — `submit()` performs exactly one request per
call and returns; 408/425/429 and 5xx are classified `unknown` rather than retried. The only
occurrences of the word "retry" in the pinned TCLK source are in `commitments.ts` and
`points.ts`, describing rejection sampling of an out-of-range scalar draw — no network
involvement. Phase 3B must additionally forbid any caller-side loop around `submit()`.

`IDEMPOTENCY_SUPPORT = NO server-side idempotency key`. De-duplication is achieved only by
the signed per-DID-per-room nonce plus the durable local operation record; the canonical
`storage/nonce.py` `OperationStore` provides the local lifecycle/idempotency record. Because
the venue offers no idempotency key, resubmission safety is a local-ledger property, which
is precisely why blind retry stays prohibited.

## Part 13 — Blackbox ingestion plan

`REAL_TRANSCRIPT_INGESTION_PLAN`

Ingest one signed, redaction-checked bundle per write: room, observed `seq`, signed nonce,
signer DID, canonical frame line, canonical frame hash, submission status, observation
status, state before, state after, any rejected frame, provenance SHAs, and the TCLK pin.
Reuse the existing importer, which already fails closed on unsupported schema and unsafe
fields, and the existing capsule builder, whose `assertSafe` rejects key-shaped fields.

Reconstruct deterministically: Flight Recorder (write-ordered lifecycle), Rejection
Boundary (empty is a valid, honest result), Protocol lane (frames and transitions), Custody
lane (which DID signed what, and that four signatures required four separate approvals),
Rail lane (`paper`, value moved NO), Evidence Capsule (portable, secret-free).

`OBSERVED != COMPLETE` is preserved structurally: the capsule records observation per
frame and never promotes "all four expected frames observed" into a completeness claim.
Observation is bounded-window evidence about what a specific reader saw, not proof that the
public record contains nothing else and not proof of settlement.

## Parts 14–16

- Failure and abort matrix: `docs/PHASE3B_FAILURE_MATRIX.md`
- Machine-readable plan: `evidence/phase3b-public-footprint-plan.json`

`RECOMMENDED_PHASE3B_EXECUTION_STRUCTURE`

```
3B.0  this document — footprint, semantics, failure design            COMPLETE
3B.C  counterparty identity decision (BLOCKING, no key created here)
3B.1  freeze write #1 manifest; fixture-only execution path, no transport
3B.2  ONE public write (offer)   human approval -> sign -> submit -> observe
3B.3  ONE public write (accept)
3B.4  ONE public write (lock)
3B.5  ONE public write (reveal)  first phase that may publish a preimage
3B.6  ingestion + capsule build
3B.7  optional receipt, only if it adds evidentiary value
```

No monolithic runner. There must be no command that signs and publishes more than one
public write, and each of 3B.2–3B.5 requires its own fresh human approval and its own
one-shot budget identities.

`REAL_DEAL_BLACKBOX_VALUE`

A real transcript makes the forensic thesis concrete: a visible four-step state trajectory
across two real public rooms; the signed/submitted/observed distinction demonstrated on
real network outcomes instead of fixtures; per-DID-per-room nonce evidence with any natural
gap explained honestly; deterministic replay of public bytes at a pinned commit; and a
portable, secret-free Evidence Capsule a third party can verify without trusting us.

No invalid or spam frame will be published to manufacture a rejection. The Rejection
Boundary stays a local CHAOS-mode property unless a rejection arises naturally, in which
case it is recorded as encountered.

## Stop condition

Execution is **BLOCKED** at Part 3: a second real DID is required and does not exist as an
approved custody identity. Resolving that is the only prerequisite to freezing the exact
write #1 manifest.
