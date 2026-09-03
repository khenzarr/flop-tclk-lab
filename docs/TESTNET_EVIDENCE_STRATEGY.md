# Testnet evidence strategy

This schema is preparation only. It is provider-neutral and does not assert any FLOP RPC, endpoint, field, reward rule, or testnet availability. Optional/null fields remain optional until a future provider documents them.

A future collector should record immutable request identifiers and hashes, public DID/Technocore room and sequence references, TCLK contract/receipt references, outcome, latency, provider, and any provider-documented amount/asset/transaction reference. Secrets, seeds, passphrases, raw preimages, bearer tokens, and private transcripts must never enter the evidence record.

Evidence can demonstrate what a client observed; it cannot by itself prove reward eligibility, an airdrop, funding, or ownership. Eligibility must be determined by the authoritative future program rules and provider records.
