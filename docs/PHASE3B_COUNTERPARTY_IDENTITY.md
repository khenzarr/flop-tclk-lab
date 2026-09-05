# Phase 3B Counterparty Identity — Trust Language

**Read this before writing any capsule, README, changelog or marketing text about Phase 3B.**

Phase 3B uses **two distinct cryptographic DIDs controlled by one human operator**. That is the
whole claim. It exists because the adopted TCLK state machine enforces DID-role separation: a single
DID cannot legally occupy both sides of a deal.

It **does NOT demonstrate two independent humans**, two organizations, two economic counterparties,
two wallet owners, a payment, a settlement, or FLOP eligibility.

| Claim | Status |
| --- | --- |
| Two distinct `did:key` identifiers | **VERIFIED** — satisfies the machine's role separation |
| Two independently protected local keys | **VERIFIED** — DPAPI-protected under separate state roots |
| Two humans | **NO** — one operator, one machine, one Windows account |
| Two organizations | **NO** |
| Independent economic counterparty | **NO** |
| Separate wallet owner | **NO** |
| Evidence of payment or settlement | **NO** |
| FLOP eligibility | **NO** |

`sameHumanOperator=true` and `independentHumanCounterparty=false` are recorded in
`evidence/phase3b-counterparty-identity.json` and asserted by `blackbox/tests/phase3bc1.test.mjs`
and `blackbox/tests/phase3bc1b.test.mjs`. Those assertions exist specifically so future edits cannot
quietly upgrade the claim.

## ONE HUMAN OPERATOR — TWO DISTINCT CRYPTOGRAPHIC DIDS

That sentence is the ceiling of the claim. Two keys existing on one Windows account under one
operator's control is a **protocol-role** fact, not a counterparty fact.

## Current state of Phase 3B.C1

**DID B is enrolled and verified.** Phase 3B.C1 is closed.

| Field | Value |
| --- | --- |
| `DID_A` | `did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi` |
| `DID_A_KEY_FINGERPRINT` | `abbce62f4278eb8fa870ca96f1580ffa229aa97a5041c21fe9e74f02d2d141f4` |
| `DID_B` | `did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW` |
| `DID_B_KEY_FINGERPRINT` | `a177dcc27339c364b84844997ec1222ba928f7933d895c83736ec861cb98ee7e` |
| `DID_B_PROFILE` | `phase3b-counterparty-b` |
| `MULTI_IDENTITY_SUPPORTED` | `YES_REVIEWED_NAMED_PROFILE_ENTRYPOINT` |
| `EXISTING_IDENTITY_SELECTION_MODEL` | `ROOT_SCOPED_INTERNAL_PRIMITIVE` |
| `PRODUCTION_MULTI_IDENTITY_ENROLLMENT_PATH` | `REVIEWED_PHASE3BC1A` |
| `SECOND_CUSTODY_IMPLEMENTATION_REQUIRED` | `NO` |
| `HUMAN_ACTION_REQUIRED` | `NO` (enrollment already performed by the operator) |
| `FINAL_STATUS` | `TCLK_PHASE3BC1_COUNTERPARTY_VERIFIED` |

Both fingerprints are `sha256` of the public `did:key` string. Neither is derived from, and neither
reveals, private key material.

### How DID B was created

The operator ran the Phase 3B.C1a reviewed named-profile entrypoint from a normal PowerShell
terminal — `technocore-agent-profile-init --profile phase3b-counterparty-b` — and entered the
credential interactively. Cline never saw the passphrase, never invoked the entrypoint, and never
held custody material.

### How DID B was verified

`lab/identity-fingerprint.mjs --profile phase3b-counterparty-b --pair`, using public metadata only:

- the directory listing of the profile root;
- the public `public_did` field from `local-install.json`;
- a locally recomputed `sha256` of that public DID, compared against the operator-reported
  fingerprint — the expectation is checked, never trusted;
- the **opaque** `sha256` of `identity.dpapi`, treated as ciphertext.

`identity.dpapi` was never unprotected. No private key, seed, passphrase or DPAPI plaintext was
read, derived, compared, exported, printed or logged.

```
PROFILE_EXISTS=YES
DID_B_MATCH=YES
PUBLIC_FINGERPRINT_MATCH=YES
DID_A_UNCHANGED=YES
DISTINCT_DID_CHECK=PASS
PUBLIC_KEY_FINGERPRINT_DISTINCT=PASS
STORAGE_SEPARATION=PASS
```

### Distinctness rests on public DIDs

`canonical_did(key)` derives the `did:key` from public-key material, so two different `did:key`
values are two different keypairs. The two `identity.dpapi` ciphertext digests differ as well, but
that alone proves nothing — DPAPI `protect()` is randomized, so distinct ciphertext is expected even
for identical plaintext. The ciphertext digests corroborate that two separate protected blobs exist;
the DIDs carry the cryptographic distinctness claim.

### Storage separation

| Identity | Custody root | Nonce ledger |
| --- | --- | --- |
| DID A | `%LOCALAPPDATA%\TechnocoreAgent` | present (pre-existing) |
| DID B | `%LOCALAPPDATA%\TechnocoreAgent\identities\phase3b-counterparty-b` | **absent** |

- zero overlapping custody file paths between the two roots;
- DID B has its own `identity.dpapi`;
- DID A's tracked digests are byte-identical to the values recorded in Phase 3B.C1a;
- enrollment created **no** nonce ledger for DID B, so it reserved no nonce;
- DID B's root contains no `operations.json`, `drafts.json`, `approvals.json` or `evidence.jsonl`,
  so no signing, drafting, approval or submission artifact exists for it.

Storage separation was observed at one instant from paths and digests. It is not a live tamper
guarantee and must be re-checked before any public write.

## Frozen role binding

Roles are now **bound to keys** as protocol role assignment.

| Identity | Role |
| --- | --- |
| DID A | `offer.from` / payer / lock / refund |
| DID B | `accept.from` / payee / reveal |

`ROLE_BINDING_FROZEN=YES`

Derived from the adopted TCLK pin `d48e873`: `dist/frames.js` rejects an accept whose `from` equals
`offer.from`; `dist/machine.js` restricts `lock` and `refund` to the payer and `reveal` to the payee.
Putting the refund path on DID A is deliberate — DID A is the identity with the already-proven
detached-signing route and durable one-shot budget.

Role binding proves **only** that the state machine's DID-role separation is satisfiable. It does
not prove two humans, two organizations, independent economic counterparties, wallet ownership,
payment, settlement, or FLOP eligibility.

Any future Phase 3B sequence must preserve `offer.from != accept.from` and every payer/payee
restriction.

## DID B has no signing proof

No signature was produced for DID B, and none is required to close Phase 3B.C1:

```
DID_B_OFFLINE_SIGNATURE_REQUIRED=NO
```

A `did:key` is derived from public-key material alone, so possession of a working DID B **signing**
path is unproven. If a future public write requires DID B to sign, that signing path must be
reviewed as part of the Phase 3B execution path with its own durable one-shot operation budget.

## DID A is untouched

DID A was never rotated, regenerated, migrated, re-passphrased or rewritten. Verification used
public metadata and opaque ciphertext digests only:

- `sha256` of `identity.dpapi` **as ciphertext**, plus its size and mtime. `protect()` is randomized,
  so any rewrite of the blob changes its digest — the check detects exactly the failure it guards.
- `sha256` of `nonces.json`, `operator.json` and `local-install.json`.
- the public `public_did` field from `local-install.json`.

DID A's blob digest still equals the value recorded before the human enrollment
(`8bffdfbc…`), and its public DID is unchanged. The blob was never unprotected. No private key,
seed, passphrase or DPAPI plaintext was read, derived, exported, printed or logged.

## What the earlier audit found

The canonical custody primitives are root-scoped and identity-agnostic:

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

Phase 3B.C1 originally stopped short of creating DID B because the shipped enrollment CLI,
`local_init.main()`, pins the state root and the operator declined to bypass that guard by calling
`initialize_local_identity()` directly. Phase 3B.C1a landed the reviewed named-profile entrypoint
instead, which is what enrolled DID B. No canonical safety guard was bypassed and no second custody
implementation was written.

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

Enrolling DID B changes nothing here. PaperRail itself was not modified in this phase.

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
DPAPI_PLAINTEXT_READ=NO
CREDENTIAL_VISIBLE_TO_CLINE=NO
CREDENTIAL_VISIBLE_TO_NODE=NO
```

No signature was produced for either identity. Neither private key was unlocked. No passphrase was
requested. No nonce ledger was read or altered.

## Custody state is never committed

All real custody state lives under `%LOCALAPPDATA%\TechnocoreAgent`, outside this repository — DID
B's profile root included. No protected blob, operator verifier, nonce ledger or credential is
tracked by git, and none belongs in `.env`. Phase 3B.C1 committed documentation, evidence metadata,
tests and read-only/fixture-only lab probes.
