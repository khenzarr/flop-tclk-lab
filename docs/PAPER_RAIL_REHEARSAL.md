# PaperRail rehearsal

PaperRail is an upstream `SettlementRail` implementation that stores a paper record in a note store. Its source explicitly says it backs the lifecycle with nothing and that the record is world-writable. It enforces predicates (one lock, valid claim opening, strict pre-refund claim, deadline-gated refund) but cannot make them binding on a counterparty.

The lab used `MemoryNoteStore` and a deterministic injected clock. It proved, locally and offline:

1. lock accepted before the refund window;
2. `verifyLock` accepted the matching record;
3. claim accepted with the matching hash secret;
4. a separate record refunded at the deadline;
5. no funds, wallet, transaction, or external rail was contacted.

The evidence records `valueMoved: false` and does not persist the generated preimage. PaperRail must never be described as escrow, payment, or FLOP settlement.
