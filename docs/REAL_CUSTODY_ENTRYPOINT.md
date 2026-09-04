# Real Custody Detached Entrypoint

Phase 3A.8 adds the canonical `real_detached_sign_bridge` module. Its sole
operation is `Signer.sign_room_detached(room, text)`. Requests are non-secret
JSON files; canonical HEAD and the relevant worktree are checked before
custody access. Fixture mode is the only executable mode in this phase.

The real branch is structurally present but hard-gated with
`FRESH_REAL_OPERATOR_APPROVAL_REQUIRED`. It reuses `DPAPIKeyProvider` and
`create_local_signer`; it does not export keys and does not construct transport.

**SIGN != SUBMIT. NETWORK-FREE != SIDE-EFFECT-FREE.** A future real signing
operation will consume the local nonce ledger and the one-signature budget.