# Phase 3A.8 — Real custody entrypoint review

## Construction graph

The reviewed canonical live construction is `TrustedRuntime` in
`src/technocore_agent/service/runtime.py`:

```text
TrustedPaths.under(root)
  -> DPAPIKeyProvider(paths.protected_key).load_or_create()
  -> NonceStore(paths.nonces)
  -> Signer(key, nonce store, operation store, transport, ledger, approvals)
  -> (live-only) TechnocoreTransport / RecordingTransport
```

`DPAPIKeyProvider` is the sole protected-key loader. The signer derives its DID in the
`Signer` constructor, after custody has returned the key. `NonceStore.reserve(room, request_id)`
is the durable, per-DID/per-room strictly increasing reservation path; this review does not read
or mutate its real file.

The additive `create_local_signer` factory reuses exactly the same key provider and nonce-store
construction. Optional live components are injected by `TrustedRuntime`; the detached entrypoint
passes none, so no transport, operation store, approval store, or ledger is constructed.

## Credential and transport boundary

`real_detached_sign_bridge.py` accepts only a request file and operation mode. It never accepts a
passphrase, key, seed, DPAPI blob, or generic method selector. Phase 3A.8 hard-stops real mode
with `FRESH_REAL_OPERATOR_APPROVAL_REQUIRED` before the protected loader is invoked. Future
operator authorization must remain inside this canonical process, with stdin reserved for its
prompt; Node captures stdout and never proxies credentials.

`Signer.sign_room_detached(room, text)` is the only signing operation. `execute_room`, submit,
and transport construction are absent from the detached construction graph.

## Attestation and lifecycle

Before custody access, the child validates the exact request schema, purpose, actual Git HEAD,
and relevant clean worktree. The request is non-secret and temporary; Blackbox creates it under
the OS temp directory with a random name and deletes it in `finally`. The real nonce path is
identified by `TrustedPaths.nonces` only; no contents are inspected and no reservation occurs.