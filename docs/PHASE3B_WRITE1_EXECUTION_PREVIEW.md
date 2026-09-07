# Phase 3B WRITE #1 Execution Preview

**Fixture-only preparation artifact.** This document does not authorize signing,
nonce reservation, submission, observation, or PaperRail writes.

| Field | Frozen value |
|---|---|
| Manifest root | `9be158c613e68533a1700fdb2e08fac1adcacba16370551a98403b7d10922d8f` |
| Operation ID | `phase3b-write-1` |
| Frame | `offer` |
| Signer | `did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi` (DID A) |
| Room | `tclk-offers` |
| Runtime | attested; source `d48e87343200e3115e243df39e8f295f5ce2e645` |

## Public footprint after a future explicit SUBMIT

**PUBLIC:** room, frame type, DID, canonical offer fields, signed nonce,
signature, and the canonical line. The frozen fields are `role=payer`,
`amount=100`, `asset=FLOP`, `lock=hash`, `rails=[paper]`, the three expiry
timestamps, frame type `offer`, and the frozen offer ID.

**NOT PUBLIC IN THIS PREVIEW:** the future signature and the future signer nonce.
Those are typed runtime-only values until a separate SIGN operation produces a
pending signed operation. They are not generated here.

`VALUE MOVED=NO`, `PAYMENT=NO`, `SETTLEMENT=NO`, `FLOP REWARD PROOF=NO`.
PaperRail is **NOT INVOLVED YET**.

## Separation and failure rules

The reviewed future sequence is `PLAN -> APPROVE -> SIGN -> STOP`, then a
separate `SUBMIT -> STOP`, then a separate read-only `OBSERVE / RECONCILE ->
STOP`. SIGN is not SUBMIT and an HTTP acknowledgement is not observation.

The SIGN budget is acquired before the irreversible signer boundary. The SUBMIT
budget is acquired before exactly one POST. A timeout, connection loss, 408,
425, 429, or 5xx is `SUBMISSION_UNCERTAIN`; no blind retry is available.

No signature, nonce, budget, custody access, network call, public action, or
PaperRail write was performed to produce this artifact.