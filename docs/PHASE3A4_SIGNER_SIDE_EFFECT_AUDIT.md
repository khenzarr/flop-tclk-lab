# PHASE 3A.4 — CANONICAL SIGNER SIDE-EFFECT AUDIT (GATE A)

    SIGNER_SIDE_EFFECT_CLASS   DURABLE_NONCE_OR_PROTOCOL_STATE
    SIGNER_SAFE_TO_INVOKE      NO
    RESULT                     GATE A REFUSED — NO SIGNATURE ATTEMPTED
    REAL_SIGNATURE_COUNT       0

Gate A of Phase 3A.4 asks one question before anything crosses the custody boundary: does
`Signer.sign_room(room, text)` mutate durable state, or reach a network, on the execution path
that would actually be used? The answer is yes to the first and — on the only *reachable* path —
yes to the second. Under the phase's own rules that is a stop, not a warning, so this phase ends
at the boundary with zero real signatures.

## Scope and method

Traced read-only inside

    C:\Users\mertb\Desktop\NODE\technocore-agent-canonical\canonical\public-release\local-agent

Nothing in that project was modified, executed, or imported. The audit reads source only.

Deliberately **not** inspected, per the phase's custody rules: seed contents, decrypted key
material, DPAPI payload bytes, passphrases, backup secrets, secret environment values. No secret
file was opened, and no secret value appears anywhere in this repository.

Line references are to the state of the canonical tree at audit time.

## Traced call graph

    Signer.sign_room(room, text)                          signer/service.py:56-60
      ├─ NonceStore.reserve(room)                          storage/nonce.py:45-66   ← DURABLE WRITE
      ├─ canonical_message(room, nonce, text)              signer/canonical.py
      │    └─ clean_text(text)                             signer/canonical.py
      ├─ Ed25519PrivateKey.sign(message)                   in-memory, no I/O
      └─ SignedOperation(did, room, nonce, signature, text)

`sign_room` itself, as a function body, is these four steps. It contains no network call and no
transport reference. That is the narrow claim, and it is true.

### The durable write

`NonceStore.reserve()` is not a counter in memory. It:

1. takes a `msvcrt` exclusive file lock,
2. reads `nonces.json`,
3. increments the per-lane reservation counter,
4. writes the file back atomically — `mkstemp` → `write` → `fsync` → `os.replace`
   (`_write_reservation_state`).

Step 4 is an irreversible mutation of the exact durable protocol state a future real Technocore
operation depends on. An offline rehearsal signature would burn a reservation in that file and
leave it burned. The phase brief is explicit that this class must stop before signature, and
equally explicit that a nonce gap must not be waved through without authoritative evidence.

**Why the "fresh lane" argument is not accepted.** The counter is keyed per lane, so a signature
in a never-before-used synthetic room would increment a newly created key rather than the live
one. That is suggestive, not authoritative. The canonical tree contains only the client half of
the protocol; it does not establish whether the venue enforces nonce monotonicity per-DID-global
or per-DID-per-room, nor whether a reserved-but-unposted nonce is inert or leaves a hole a
verifier will later reject. Declaring the burn harmless would be exactly the unsupported
assumption the phase forbids, so the classification stands at
`DURABLE_NONCE_OR_PROTOCOL_STATE`.

## Blocker 2 — no reachable sign-only path

The nonce burn alone is disqualifying. A second, independent blocker means the phase could not
have produced a valid real signature even if the first were resolved.

    Agent-facing IPC             service/runtime.py:183   handle_agent_request
      permitted operations:      submit_draft, get_own_draft_status
      signing operations:        NONE

    Operator path that signs     control/service.py:92-111  ControlPlane.approve_and_execute
      └─ Signer.execute_room(...)
           ├─ consumes the operator approval record
           ├─ writes OperationStore
           ├─ transitions state → SUBMISSION_STARTED
           └─ self._transport.submit(signed)          ← TechnocoreTransport
                └─ POST https://technocore.chat/r/<room>

So: the only route that reaches a signature also posts. `sign_room` is network-free as a
function; the sole *reachable* invocation of it is not. The phase's rule — "if outbound network
capability is coupled to sign_room, STOP" — applies to the reachable path, and it is coupled
there.

Reaching bare `sign_room` from this lab would require constructing `Signer(key, nonces)`
ourselves, which means calling `DPAPIKeyProvider.load_or_create()` — a lower-level key API the
phase forbids the lab to touch. Under the operator account it would also either fail the DPAPI
unwrap (the blob is bound to the service identity) or, if the key path were absent, **generate
and persist a brand-new Ed25519 identity**. Neither outcome yields the canonical DID, so
`SIGNER_DID_MATCH` could never pass. The forbidden route is also the useless route.

## Blocker 3 — the DID is needed before the freeze

A structural consequence worth recording. BYTE FREEZE covers `signerDid`, because the actor DID
is inside the canonical frame bytes and inside `bindingCore`. Freezing bytes therefore requires
knowing the canonical signer's DID *before* any signature is requested. The canonical DID is
derived inside custody from the unwrapped key; obtaining it means touching the key provider this
phase may not touch. A real offline signature would need the DID published through a
non-custodial read surface first.

## Classification table

| Side effect probed | Verdict | Evidence |
| --- | --- | --- |
| Network request inside `sign_room` | NO | no transport reference in `signer/service.py:56-60` |
| Network reachable on the used path | **YES** | `control/service.py:92-111` → `_transport.submit` |
| Technocore posting | **YES (coupled)** | `TechnocoreTransport` POST `/r/<room>` |
| Durable nonce reservation | **YES** | `storage/nonce.py:45-66` atomic write |
| Durable sequence mutation | **YES** | same reservation state |
| Outbound queue mutation | NO in `sign_room`; YES in `execute_room` | `OperationStore` write |
| Room-state mutation | NO in `sign_room`; YES in `execute_room` | `SUBMISSION_STARTED` |
| Persistent signing-state mutation | **YES** | `nonces.json` |
| Receipt consumption | NO | not on this path |
| Replay-counter mutation | **YES** (the nonce *is* the replay counter) | `storage/nonce.py` |
| Irreversible local state mutation | **YES** | `os.replace` over `nonces.json` |
| Subprocess network execution | NO | no subprocess on this path |
| Filesystem writes affecting future signing | **YES** | `nonces.json` |

Permitted to proceed: `SIDE_EFFECT_FREE`, `SAFE_LOCAL_AUDIT_ONLY`. Observed:
`DURABLE_NONCE_OR_PROTOCOL_STATE`. Therefore: **stop before signature.**

## What this lab did instead

Everything up to the boundary, and nothing past it:

- one dedicated synthetic offline rehearsal `accept` built with the adopted pin's own machinery,
  in a room reserved for rehearsal and used nowhere in Phase 3B
  (`blackbox/airlock/rehearsal.mjs`),
- the real Phase 3A.3 flow through schema validation, human interpretation, exact canonical
  bytes, operator approval, BYTE FREEZE, and adapter preflight,
- preflight reaching `HANDOFF_ALLOWED` — proving the request was signature-ready — with no
  transport contacted and no signer invoked,
- a process-local `MAX_REAL_SIGNATURES=1` budget that Gate A never lets anything spend,
- no real-signature evidence artifact: Gate A refused before any signature existed. A
  `phase3a4-real-offline-signature.json` success record must not be created for this run.

The operator command `pnpm airlock:real-offline-sign` exists, prints its banner, and refuses at
Gate A with a non-zero exit. `pnpm test` cannot reach it.

## What would genuinely unblock a future attempt

1. A nonce-neutral rehearsal surface in the canonical project: an injectable ephemeral
   `NonceStore`, or a `sign_room_preview` that signs without touching durable state.
2. A sign-only path that is not coupled to `_transport.submit`, reachable without constructing
   `Signer` by hand.
3. A non-custodial read that publishes the canonical DID so bytes can be frozen against it.
4. Or authoritative venue-side nonce semantics proving a fresh-lane reservation is inert.

Items 1-3 require modifying the canonical project, which this phase forbids. Item 4 requires
upstream evidence this phase does not have. A future phase should obtain one of them before
re-opening Gate B.

## Standing limitations

- This is a source audit. It is not a runtime observation, because the phase's answer was to not
  create one.
- It covers the path traced above. A different entry point could have different effects.
- No claim is made about the venue's server-side behaviour.
