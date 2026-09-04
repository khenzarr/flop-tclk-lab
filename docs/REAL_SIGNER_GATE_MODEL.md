# Real signer Gate A model — Phase 3A.7

Gate A is mode-aware. It does not collapse every local mutation into a network side effect.

| Mode | Network side effect | Local nonce mutation | Offline real signature architecture |
|---|---:|---:|---:|
| `LEGACY_COUPLED_ROOM_OPERATION` | yes/capable | yes | **REFUSE** |
| `DETACHED_NETWORK_FREE_ROOM_OPERATION` | no | yes, expected | `ALLOW_ARCHITECTURE` only |

The legacy `execute_room` path owns operation state and transport submission and remains blocked for
offline rehearsal. The reviewed detached path calls only `Signer.sign_room_detached(room, text)`.
That method durably consumes a local per-DID/per-room nonce, but it does not submit to a server.
Therefore **LOCAL NONCE CONSUMED != SERVER OBSERVED NONCE** and detached signing is **network-free**,
not side-effect-free.

The detached decision requires the exact reviewed canonical commit, pinned nonce evidence
`82d942936050f1ab0fb9f34db17893b89f3e064b`, strictly increasing semantics, skipped nonces allowed,
explicit nonce consumption acknowledgement, no rollback, no public posting, and (in this phase)
fixture custody only. `ALLOW_ARCHITECTURE` is not fresh operator authorization and does not permit
real custody here.