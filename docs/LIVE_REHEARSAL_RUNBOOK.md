# Live rehearsal runbook

## PUBLIC WRITE — OPERATOR APPROVAL REQUIRED

This runbook is not an execution record. `examples/live-deal.mjs` was inspected but not run against Technocore in Phase 1.

A live invocation can post the offer and accept in public `tclk-offers`, then post lock/reveal/refund/receipt frames in the derived unlisted deal room. These are public, durable transcript activity; do not assume deletion or cleanup because the venue is append-oriented.

The example creates ephemeral identities/secrets when not configured, according to its source; verify the exact current source before any run and do not substitute canonical custody. PaperRail only records no-value predicates. Generated preimages/witnesses must remain private until an intentional reveal, while frame text, DID, room, sequence, and receipts become public.

Before approval: pin and recheck the example, confirm no key environment variables are inherited, choose unique test terms, record operator/time, and confirm no wallet or value rail is selected. After each response, record room and sequence only after redaction. Verify the final transcript by reading the room, decoding every line, checking transport signatures, folding with `applyFrame`, and reconciling any receipt with the terminal state and rail record.

Success means a complete, independently verified transcript and matching no-value PaperRail record. Partial success means any subset was accepted or a venue refusal/timeout occurred; it is not safe to retry blindly. On uncertainty, stop, preserve public room/sequence evidence, query reads only, and choose a new unique rehearsal identity/offer after determining what was accepted. Never fabricate cleanup or duplicate a potentially accepted offer. Stop before any further write, key use, or value-bearing action.
