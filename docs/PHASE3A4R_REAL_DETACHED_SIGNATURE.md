# Phase 3A.7 — real detached entrypoint reconciliation

The previous Phase 3A.4R refusal was correct for the coupled offline path, but overly broad for
the reviewed detached method. Gate A now distinguishes `LEGACY_COUPLED_ROOM_OPERATION` from
`DETACHED_NETWORK_FREE_ROOM_OPERATION` rather than deleting the safety gate.

This phase uses only a fixture Ed25519 key and a temporary nonce ledger. No canonical real key,
passphrase, DPAPI custody, real nonce ledger, real signature, Technocore read/write, or submission
is used. The historical implementation baseline pin is
`e5bd617b36c69315c238ef39bfca7c3f5a8c4d98`; the reviewed bridge pin is
`be19176f37a3c83544a0f55d9e43ba48ec388bc8` (pre-format bridge commit); the exact post-format
reviewed pin is `ab8f9a27b2ea99aa21fb3f4fc4f414ff178ff22d`; and the authoritative nonce evidence is
`82d942936050f1ab0fb9f34db17893b89f3e064b`.

**SIGN != SUBMIT.** A detached signature is a local artifact; its nonce is consumed locally, while
the server has observed nothing. Future real execution requires fresh external operator approval.