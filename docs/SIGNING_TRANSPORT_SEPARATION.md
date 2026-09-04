# Signing / Transport Separation — Phase 3A.5

## Current canonical graph (source-only)

```text
room + text
  -> Signer.execute_room(request_id, room, text, approval)
  -> clean/canonicalize text
  -> OperationStore.create and, when needed, NonceStore.reserve(room, request_id)
  -> Signer._sign_with_nonce
  -> OperationStore.update + transition SIGNED
  -> OperationStore.transition SUBMISSION_STARTED
  -> TechnocoreTransport.submit
  -> HTTPS POST /r/<room>
```

The lower-level `Signer.sign_room(room, text)` path is source-level network
free, but it still calls `NonceStore.reserve(room)` and is not an approved
external sign-only service surface. The reachable approved execution path is
coupled to transport by `Signer.execute_room`.

## Exact boundaries

| Boundary | Location | Effect |
| --- | --- | --- |
| nonce reservation | `signer/service.py:90-93` and `storage/nonce.py:45-72` | durable atomic `nonces.json` mutation |
| preimage construction | `signer/canonical.py:24-30` | `room|nonce|clean_text(text)` |
| private-key signing | `signer/service.py:132-135` | in-memory Ed25519 signing after custody access |
| local verification | not performed by `Signer` itself; transport validates returned receipt | no independent canonical signer verification boundary |
| durable signed state | `signer/service.py:95-97` | operation record update and `SIGNED` transition |
| POST boundary | `signer/service.py:98` -> `policy/transport.py:64-95` | `TechnocoreTransport.submit`, HTTPS POST |

## Separation assessment

The protocol primitives can conceptually be extracted: `_sign_with_nonce`
already has no transport reference, while `execute_room` owns lifecycle and
submission. However, a safe detached room surface cannot be added in this
phase because authoritative nonce semantics are `UNKNOWN`, and the current
canonical repository is independently dirty. No canonical code was modified.

No challenge-signing API was designed beyond the conceptual requirement in
the Phase 3A.5 brief. In particular, no encoding or test vector is invented
without first choosing and documenting a stable domain-separated protocol.