# Phase 3A.5 Signer Surface Contract Review

## Decision

```text
NONCE_SEMANTICS=UNKNOWN
BLACKBOX_ADAPTER_COMPATIBILITY=BLOCKED
DETACHED_CUSTODY_CHALLENGE=DESIGN-ONLY / NOT INVOKED
DETACHED_ROOM_OPERATION=BLOCKED
LIVE_ONLY_SIGNING=EXISTING CANONICAL BEHAVIOR ONLY
```

The Phase 3A.3 adapter must not claim `POST_ELIGIBLE` for a new surface. It
may continue to exercise sanitized mock and dry-run boundaries, but it must
not call the canonical signer, unwrap custody, reserve a real nonce, or send
transport traffic.

## Proposed future challenge boundary

A future canonical implementation may expose a clearly named,
non-postable `sign_detached_challenge` operation. It must:

- accept approved, byte-frozen challenge bytes;
- use the existing protected custody path only;
- sign a separately specified domain-separated preimage;
- have no `NonceStore` dependency and no `TechnocoreTransport` dependency;
- return public verification material only; and
- be impossible for the adapter to reinterpret as a Technocore room operation.

This phase intentionally does not choose an encoding or invoke it. A
cryptographically valid signature is not a Technocore operation signature.

## Phase 3A.4 replacement plan

`Phase 3A.4R = BLOCKED_PENDING_AUTHORITATIVE_NONCE_SEMANTICS`.

If server evidence later proves a safe detached room nonce rule, reassess for
one real detached room signature with no POST. Otherwise implement and review
the domain-separated custody challenge first, then run one real challenge
with no POST. Either test must state that it proves custody integration and
local verification only; it does not prove venue acceptance, replay behavior,
or transport delivery.

No Phase 3B work or real signature is authorized by this document.