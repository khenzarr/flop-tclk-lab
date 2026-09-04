# Phase 3A.5 Signer Surface Contract Review

## Decision

```text
NONCE_SEMANTICS=STRICTLY_INCREASING
NONCE_SCOPE=PER_DID_PER_ROOM
SKIPPED_NONCE_ALLOWED=YES
BLACKBOX_ADAPTER_COMPATIBILITY=FIXTURE-ONLY DETACHED SURFACE
DETACHED_CUSTODY_CHALLENGE=NOT INVOKED
DETACHED_ROOM_OPERATION=IMPLEMENTED FOR FIXTURE TESTS; REAL CUSTODY NOT INVOKED
LIVE_ONLY_SIGNING=EXISTING CANONICAL BEHAVIOR PRESERVED
```

The Phase 3A.3 adapter now labels its fixture result
`DETACHED_SIGNED_OPERATION`, with `NETWORK_SUBMITTED=false` and
`LOCAL_NONCE_CONSUMED=true`. It still does not call the canonical signer,
unwrap custody, reserve a real nonce, or send transport traffic.

## Proposed future challenge boundary

A canonical implementation exposes a clearly named, non-postable
`sign_room_detached(room, text)` operation. It must:

- accept approved, byte-frozen challenge bytes;
- use the existing protected custody path only;
- sign a separately specified domain-separated preimage;
- reserve and consume the existing local room nonce, without a
  `TechnocoreTransport` dependency;
- return public verification material only; and
- be impossible for the adapter to reinterpret as a Technocore room operation.

The exact room preimage is `room|nonce|clean_text(text)`. A cryptographically
valid detached signature is not evidence of submission or server acceptance.

## Phase 3A.4 replacement plan

`Phase 3A.4R = OPERATOR-ONLY PLAN; NOT EXECUTED`.

The official server rule permits any nonce greater than the last nonce found in
bounded recent room history. Therefore a locally reserved but unposted nonce is
not server-visible and a later larger nonce remains eligible. This does not
provide permanent replay protection or globally durable server nonce state.
The operator-only run must use a synthetic room, exactly one signature, no
transport, no persistence, and new approval for every retry.

No Phase 3B work or real signature is authorized by this document.