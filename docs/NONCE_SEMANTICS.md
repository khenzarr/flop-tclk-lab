# Technocore Nonce Semantics — Phase 3A.5

## Result

`NONCE_SEMANTICS=UNKNOWN`

This checkout does not contain authoritative Technocore server validation
logic, official nonce-acceptance tests, or a protocol specification that
defines the venue's replay rule. The client-side `NonceStore` is not evidence
of server semantics. Consequently this phase does **not** create a postable
detached room-signing path and does not reserve a live operation nonce.

## Evidence reviewed

- `local-agent/src/technocore_agent/storage/nonce.py:45-72` — client-side
  atomic per-lane counter/reservation; this describes local allocation only.
- `local-agent/src/technocore_agent/signer/service.py:56-60` —
  `sign_room` reserves the local counter before signing.
- `local-agent/src/technocore_agent/signer/service.py:90-104` — the executed
  path binds/reserves a nonce, signs, marks submission started, and submits.
- `local-agent/src/technocore_agent/policy/transport.py:64-95` — client POST
  construction; it contains no authoritative server acceptance rule.
- `local-agent/tests/` — tests cover local durability, uniqueness,
  concurrency, transport receipt matching, and failure recovery; no official
  server tests establish first, duplicate, lower, skipped, or much-higher
  nonce acceptance.

The current canonical source therefore does not establish whether the venue
requires `EXACT_NEXT`, accepts any `STRICTLY_INCREASING` nonce, requires only
`UNIQUE_ONLY`, or applies another rule.

## Required unanswered cases

| Question | Authoritative answer |
| --- | --- |
| First nonce | UNKNOWN |
| Duplicate nonce | UNKNOWN |
| Lower nonce | UNKNOWN |
| Skipped nonce | UNKNOWN |
| Much-higher nonce | UNKNOWN |
| Concurrent operations | UNKNOWN |
| Nonce scope | UNKNOWN — per-DID, per-room, per-DID+room, global, or other |
| Highest-seen persistence | UNKNOWN |
| Rejected/unposted signature consumption | UNKNOWN |
| Local reservation without POST | No venue-visible effect can be established from this checkout |

## Safety consequence

Because skipped-nonce safety is unproven, a detached `SignedOperation` using a
real room nonce would be unsafe to expose as postable. No real nonce was
reserved and no signature was performed in Phase 3A.5.

A future phase may research current server source, official tests, or the
protocol specification using read-only access. It must not infer semantics
from a successful client-side fixture or from the local counter model.