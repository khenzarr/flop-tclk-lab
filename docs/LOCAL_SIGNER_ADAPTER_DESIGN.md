# Local signer adapter design (future; not implemented)

This document defines an interface only. Phase 1 does not read, import, connect to, or test against the existing canonical DID custody system.

1. TCLK creates the exact canonical frame line and transport signing challenge.
2. A trusted local signer process verifies room, nonce, swept text, and exact UTF-8 bytes against an operator-approved request.
3. The user explicitly approves the concrete challenge.
4. The custody process signs internally with the canonical DID key.
5. Only `{did, sig, nonce}` leaves the custody process; no seed, DPAPI blob, passphrase, or key handle is exported.
6. TCLK posts the caller-supplied signature through its existing API.
7. The lab stores only public room/sequence/receipt evidence, after secret scanning.

The adapter must reject mismatched canonical text, stale/reused nonce, unexpected room, partial triples, and any request that asks it to reveal key material. It should use an IPC boundary with structured requests, explicit user approval, short-lived in-memory request state, no durable secret logs, and an auditable public-receipt result. This is design work only; no implementation is authorized in Phase 1.
