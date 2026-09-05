# Phase 3B Counterparty Identity — Trust Language

**Read this before writing any capsule, README, changelog or marketing text about Phase 3B.**

The planned Phase 3B rehearsal uses **two distinct cryptographic DIDs controlled by one human
operator**. That is the whole claim. It exists because the adopted TCLK state machine enforces
DID-role separation: a single DID cannot legally occupy both sides of a deal.

It **does NOT demonstrate two independent humans**, two organizations, two economic counterparties,
two wallet owners, a payment, a settlement, or FLOP eligibility.

| Claim | Status |
| --- | --- |
| Two distinct `did:key` identifiers | Intended, satisfies the machine's role separation |
| Two independently protected local keys | Intended, DPAPI-protected under separate state roots |
| Two humans | **NO** — one operator, one machine, one Windows account |
| Two organizations | **NO** |
| Independent economic counterparty | **NO** |
| Separate wallet owner | **NO** |
| Evidence of payment or settlement | **NO** |
| FLOP eligibility | **NO** |

`sameHumanOperator=true` and `independentHumanCounterparty=false` are recorded in
`evidence/phase3b-counterparty-identity.json` and asserted by `blackbox/tests/phase3bc1.test.mjs`.
Those assertions exist specifically so future edits cannot quietly upgrade the claim.

## Current state of Phase 3B.C1

**DID B does not exist.** Phase 3B.C1 stopped before creating it.

| Field | Value |
| --- | --- |
| `DID_A` | `did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi` |
| `DID_B` | not created |
| `MULTI_IDENTITY_SUPPORTED` | `YES_AT_CUSTODY_PRIMITIVE_LEVEL` |
| `EXISTING_IDENTITY_SELECTION_MODEL` | `ROOT_SCOPED_INTERNAL_PRIMITIVE` |
| `PRODUCTION_MULTI_IDENTITY_ENROLLMENT_PATH` | `NOT_REVIEWED` |
| `SECOND_CUSTODY_IMPLEMENTATION_REQUIRED` | `NO` |
| `HUMAN_ACTION_REQUIRED` | `YES` |
| `FINAL_STATUS` | `TCLK_PHASE3BC1_HUMAN_ENROLLMENT_REQUIRED` |

### What the audit found

The canonical custody primitives at `124d621` are already root-scoped and identity-agnostic:

- `TrustedPaths.under(root)` derives every state file — `identity.dpapi`, `nonces.json`,
  `operations.json`, `drafts.json`, `approvals.json`, `evidence.jsonl`, `operator.json` — from a
  single root. Two roots give two fully independent namespaces, including independent nonce ledgers.
- `DPAPIKeyProvider(path).load_or_create()` writes only when the protected blob is absent. An
  existing identity is loaded, never rewritten.
- `storage/dpapi.py` protects each file separately, so there is no shared container to collide over.
- `canonical_did(key)` derives the `did:key` from public key material only — no signature, no nonce.

`lab/custody-isolation-probe.py` proved this empirically with real Windows DPAPI and two **throwaway
fixture keys** in a temp directory that was deleted afterwards: distinct DIDs, distinct ciphertext
blobs, zero overlapping paths, reopen-is-stable, and no nonce ledger created.

### Why it stopped

The shipped enrollment CLI, `local_init.main()`, pins the state root:

```
if args.state.resolve() != expected:
    parser.error("local state must be exactly ...")
```

The library function `initialize_local_identity(state_root, ...)` accepts any root; only the argparse
wrapper refuses one. Enrolling DID B by calling that function directly would have bypassed an
intentional CLI safety boundary. **The operator declined that bypass, and the decision stands:**
custody capability at the primitive level is not the same thing as a reviewed production enrollment
path, and Phase 3B.C1 was not authorized to create one.

No canonical code was modified. No second custody implementation was written.

### Required follow-up (Phase 3B.C1a)

A narrow, separately reviewed, human-only multi-identity enrollment entrypoint that:

- reuses `DPAPIKeyProvider` and `initialize_local_identity` unchanged;
- leaves the default canonical identity path and its single-root guard intact;
- requires an explicit named identity/profile;
- constrains the storage root to a reviewed namespace under `%LOCALAPPDATA%`;
- refuses path traversal and arbitrary filesystem roots;
- refuses to write into or adjacent to an existing identity's files;
- requires interactive human credential entry;
- never exposes the passphrase or private key to Cline or Node;
- performs no signing, no nonce reservation, no transport, no network activity.

Only after that lands should Phase 3B.C1 be re-run to enrol DID B.

## Frozen role design

Roles are frozen as a **design decision only**. Neither role is bound to a key, because only one
identity exists.

| Identity | Role |
| --- | --- |
| DID A | `offer.from` / payer / lock / refund |
| DID B | `accept.from` / payee / reveal |

Derived from the adopted TCLK pin `d48e873`: `dist/frames.js` rejects an accept whose `from` equals
`offer.from`; `dist/machine.js` restricts `lock` and `refund` to the payer and `reveal` to the payee.
Putting the refund path on DID A is deliberate — DID A is the identity with the already-proven
detached-signing route and durable one-shot budget.

Any future Phase 3B sequence must preserve `offer.from != accept.from` and every payer/payee
restriction.

## DID A is untouched

DID A was never rotated, regenerated, migrated, re-passphrased or rewritten. Verification used
public metadata and opaque ciphertext digests only:

- `sha256` of `identity.dpapi` **as ciphertext**, plus its size and mtime. `protect()` is randomized,
  so any rewrite of the blob changes its digest — the check detects exactly the failure it guards.
- `sha256` of `nonces.json`, `operator.json` and `local-install.json`.
- the public `public_did` field from `local-install.json`.

The blob was never unprotected. No private key, seed, passphrase or DPAPI plaintext was read,
derived, exported, printed or logged. `lab/identity-fingerprint.mjs --compare` reported
`UNCHANGED=YES` after all probing.

## PaperRail trust rule

Carried forward from the Phase 3B.0 audit and binding on all future work:

The two PaperRail KV notes are **UNSIGNED** and **WORLD_WRITABLE**. Any Blackbox ingestion of them
must classify them as:

```
UNSIGNED_RAIL_OBSERVATION
```

They must **never** be used as proof of authorship, party identity, payment, settlement, or signed
protocol intent. Anyone can write them; nothing binds them to a key. They are observations of a
public scratch surface, nothing more.

PaperRail itself was not modified in this phase.

## Safety envelope actually held

```
REAL_SIGNATURE_PERFORMED=NO
REAL_NONCE_CONSUMED=NO
LIVE_TECHNOCORE_READS=NONE
LIVE_TECHNOCORE_WRITES=NONE
TRANSPORT_CALLS=0
NETWORK_CALLS=0
SUBMISSION_CALLS=0
PUBLIC_ACTIONS=0
PRIVATE_KEY_EXPORTED=NO
PRIVATE_KEY_PRINTED=NO
CREDENTIAL_VISIBLE_TO_CLINE=NO
CREDENTIAL_VISIBLE_TO_NODE=NO
```

No signature was produced for any identity. A DID is derived from public key material alone, so a
working signing path for a future DID B remains unproven and belongs to a later phase with its own
durable one-shot budget.

## Custody state is never committed

All real custody state lives under `%LOCALAPPDATA%\TechnocoreAgent`, outside this repository. No
protected blob, operator verifier, nonce ledger or credential is tracked by git, and none belongs in
`.env`. Phase 3B.C1 committed documentation, evidence metadata, tests and two read-only/fixture-only
lab probes.
