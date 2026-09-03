# Security boundaries

Each item below distinguishes the upstream rule from this lab's responsibility and evidence. No item is asserted as an undiscovered vulnerability.

| Area | Upstream invariant / current limitation | Client responsibility | Evidence |
|---|---|---|---|
| Canonical bytes | Sorted, compact JSON; `undefined` omitted; non-ASCII escaped; wire bytes are signed bytes. NFC/NFD are not normalized. | Sign exactly the emitted line; never reserialize or normalize. | `lab/run-rehearsal.mjs`, canonicalization case; AGENTS.md. |
| Signature payload | Transport signature covers the venue canonical message; TCLK frame signature covers its canonical line where applicable. | Verify transport identity and frame payload separately. | upstream `mcp/src/signing.ts`, SPEC.md. |
| Unknown/malformed values | Validation rejects unknown keys and malformed values; no coercion. | Treat decode/validation failure as untrusted input. | rehearsal malformed/unknown case; upstream tests. |
| Wrong party/secret | State predicates reject unauthorized parties and invalid lock openings. | Check `ok` and preserve state on rejection. | six fail-closed rehearsal cases. |
| Replay/order | State machine rejects replayed and out-of-order actions. | Do not infer success from a transcript line alone. | replay/order cases. |
| Deadlines | Claim is before the refund deadline; refund is deadline-gated. | Use a trusted clock and handle boundary races explicitly. | refund rehearsal; PaperRail source. |
| Receipts | Contradictory receipt outcomes are rejected at the pinned commit. | Reconcile receipt with contract state and rail evidence. | CHANGELOG and upstream tests. |
| Visibility | Offers and transcripts are world-readable; derived deal room is unlisted, not private. | Assume room content is public and durable/append-only. | SPEC §2 and live runbook. |
| Untrusted content | Venue content can be arbitrary; unsigned data is not a commitment. | Validate every line, DID, sequence, and room. | SPEC transport rules. |
| Secret custody | Minted preimage/witness is returned once and not persisted by MCP; reveal publishes it. | Keep it outside logs, Git, and shared services until intentional reveal. | upstream MCP README/source; redacting Recorder. |
| MCP modes | Stdio may load env keys; hosted Worker structurally refuses both custody bindings. | Select mode according to custody model; never pass canonical keys to hosted service. | `mcp/src/tools.ts`, `mcp/worker/src/worker.ts`. |
| Payment key | `TCLK_PAYMENT_KEY` is separate from transport DID key and enables adaptor pre-signing in stdio only. | Keep payment custody in a trusted local process. | MCP source/tests. |
| PTLC/adaptor | Unaudited full-Schnorr reference crypto, not BIP-340/production signing. | Do not use for value-bearing flows. | AGENTS.md and source banner. |
| Rail trust | Room records coordination; rail enforces value predicates. PaperRail has no value and is world-writable. | Require independent rail evidence before claiming settlement. | PaperRail rehearsal and source. |

### Fail-closed contract

For each negative rehearsal, `applyFrame` returned `ok: false`, a non-empty reason, the same state object, and byte-identical state. This is observed behavior at the pinned upstream state, not a guarantee about future releases.
