# PHASE 3A.10.4 — Durable one-shot real-execution budget, and the retirement of Phase 3A4R4

Status: Blackbox only. No canonical change. No real signature, nonce, or Technocore activity was
performed in this phase.

## 1. The finding

`MAX_REAL_SIGNATURES=1` (`blackbox/airlock/budget.mjs`, `RealSignatureBudget`) was **process-local**.
It stopped a second signature inside one invocation. It did not stop the operator from restarting
the command, because every fresh process constructed a fresh permit book and handed itself a fresh
permit.

Classification: **CROSS_PROCESS_REAL_SIGNATURE_BUDGET_BYPASS**.

Sanitized historical truth, as reported by the human operator and not rewritten:

| | run 1 | run 2 |
| --- | --- | --- |
| local nonce consumed | 1 | 2 |
| local verification | PASS | PASS |
| posted | false | false |
| transport objects | 0 | 0 |
| network submission | NONE | NONE |

    REAL_SIGNATURE_ATTEMPTS_OBSERVED = 2
    LOCAL_NONCES_OBSERVED_CONSUMED   = 1, 2
    HISTORICAL_PUBLIC_SUBMISSIONS    = 0

So `CRYPTOGRAPHIC_SIGNING_PROOF=PASS` and `CROSS_PROCESS_ONE_SHOT_BUDGET=FAILED` are both true. The
defect is in Blackbox execution-budget **persistence**, not in canonical signing semantics: the
preimage, the nonce rules, the SignedOperation shape, and the detached (network-free) boundary all
behaved as designed, twice.

No raw signature or SignedOperation is available from either run, none was requested, and none is
persisted. The sanitized record is `evidence/phase3a104-cross-process-budget-finding.json`. It is a
Blackbox-side operator-execution record. **It is not server evidence** and asserts nothing about any
public or Technocore state.

## 2. Budget scope, before and after

| | before | after |
| --- | --- | --- |
| scope | process-local permit book | durable, machine-wide, per operation identity |
| survives restart | no | yes |
| survives crash | n/a | yes, as SPENT |
| second process | gets a fresh permit | refused by the kernel |
| storage | memory | one marker file per budget identity |
| contains secrets | n/a | no |

`RealSignatureBudget` is retained: it is still a correct in-run loop/retry guard, and old evidence
refers to it. It is simply no longer the outer boundary. The outer boundary is now durable.

## 3. The primitive — `blackbox/airlock/attempt-budget.mjs`

One irreversible transition, `AVAILABLE -> SPENT`, carried by the atomic exclusive creation of a
marker file (`openSync(path, 'wx')`, i.e. `O_CREAT|O_EXCL`, mode `0600`, then `fsync`).

Identity is `purpose + operationClass + subject`, where `subject` is the approved request
fingerprint when the budget is bound to one approved request, or `null` when it covers the operation
class as a whole. The identity is hashed (SHA-256) into a `budgetId`; the marker filename is a
purpose slug plus the leading 32 hex characters of that id. Identity tokens are restricted to
`/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/`, so no identity can traverse or escape the state root.

Why exclusive-create rather than read-then-write:

* **Existence of the marker IS the SPENT state.** There is no read-then-decide-then-write window,
  therefore no TOCTOU race to lose.
* **The kernel arbitrates.** `O_CREAT|O_EXCL` is atomic on NTFS and on POSIX filesystems, so exactly
  one caller wins — whether the loser is a loop in this process, a second invocation, or a
  simultaneous double-launch. Nothing depends on advisory locking, which Windows does not offer in
  the shape we would need.
* **Every non-`ENOENT` outcome is SPENT.** Present, truncated, malformed, schema-mismatched,
  identity-mismatched, foreign, unreadable, or not-a-regular-file all refuse. Absence is the only
  open state, which is the documented initialization semantics: a missing marker (and a missing
  root) is `AVAILABLE`.

The state root is a code constant, `blackbox/state/attempt-budget/`, never argv, an environment
variable, or a CLI flag; a caller-selectable root in production would be a
rename-your-way-out-of-the-budget bypass. Tests pass an explicit fixture root under the OS temporary
directory. The root is deliberately **not** inside the DPAPI custody root
(`%LOCALAPPDATA%\TechnocoreAgent`); this module never reads or writes protected custody state. The
directory is git-ignored: spend state is machine-local, and committing it would let a clone arrive
pre-spent or let a revert appear to un-spend a budget.

There is no `release`, `reset`, `rollback`, or `unspend` function, and there must never be one. An
un-spend API is exactly the bypass this module exists to close.

### Ordering rule

The budget is acquired **immediately before the irreversible signer boundary and never after it**.
Acquisition throws on refusal instead of returning `false`, because a caller who ignored a boolean
would perform the irreversible operation a second time, and this is the one guard that must not be
ignorable. Spending on success instead would license unlimited retries, which is precisely how the
process-local budget failed.

### Crash semantics, exactly

| crash point | resulting state | why |
| --- | --- | --- |
| before the exclusive create | `AVAILABLE` | nothing irreversible happened either |
| after create, before write | `SPENT` (`SPENT_STATE_TRUNCATED`) | zero-length marker still refuses |
| after create, mid-write | `SPENT` (`SPENT_STATE_UNREADABLE`) | partial marker still refuses |
| after the irreversible operation | `SPENT` | marker was already created and fsynced |

The marker is created and fsynced before the operation and no code path removes it, so a killed,
aborted, or power-lost process can never present the budget as `AVAILABLE` again.

Durability is against process restart and crash. It is **not** a defence against an operator who
deliberately deletes local state. That is a visible human act, and any operation whose closure must
survive it is closed in source instead — which is what Phase 3A4R4 now is.

### What the marker contains

`schema`, `state: "SPENT"`, `budgetId`, `purpose`, `operationClass`, `subject`, `acquiredAt`, `pid`,
and two fixed strings. No key, passphrase, signature, SignedOperation, credential, or preimage. No
field of it is an authorization: a marker cannot grant anything, it can only refuse. It is a spend
record, not a permit.

## 4. Retirement of the Phase 3A4R4 real command

`pnpm airlock:real-detached-sign` can no longer produce a Phase 3A4R4 real signature.
`assertPhase3a4r4RealPathClosed()` runs in `runDetachedSigningRoute` **before** the approval prompt,
the canonical child, custody, the nonce, and signing, and throws:

    PHASE3A4R4_CLOSED
    REAL_EXECUTION_BUDGET_EXHAUSTED

The closure is unconditional in source (`PHASE3A4R4_CLOSURE`, `reopenable: false`) rather than
represented by durable state, for one reason: a source constant cannot be cleared by deleting a
local file. Historical operator execution already happened — twice — so the honest representation is
"closed", not "one attempt remaining".

Preserved deliberately:

* fixture testing capability — the same production control flow still runs end to end under fixture
  custody, so every gate keeps its automated proof;
* the canonical signer, its preimage, its nonce semantics, and the SignedOperation schema — all
  untouched.

Phase 3B must **not** revive this command. It gets a separately reviewed Phase 3B operation path,
its own budget identity, and its own approval. `docs/PHASE3A4R4_HUMAN_EXECUTION.md` remains accurate
as history; this document is the closure.

## 5. Tests — `blackbox/tests/phase3a104.test.mjs`

Temporary fixture roots under the OS temporary directory only. Cross-process facts are proven with
short Node children that import only this dependency-free module (a documented `lint.mjs` subprocess
exception; no network, no custody, no canonical worktree).

1. first acquisition succeeds;
2. second acquisition in the same process refuses;
3. second acquisition after a real process restart refuses (`CROSS_PROCESS_ONE_SHOT_TEST`);
4. six simultaneous launches yield exactly one winner (`CONCURRENT_ONE_SHOT_TEST`);
5. a child killed immediately after acquisition leaves the budget SPENT (`CRASH_FAIL_CLOSED_TEST`);
6. truncated, malformed, foreign-identity, wrong-schema, and directory-shaped state all fail closed;
7. missing marker and missing root are `AVAILABLE`, per documented initialization semantics;
8. the fixture signing path consumes exactly one durable budget and verifies locally;
9. a second fixture run with the same durable root cannot reach the signer at all;
10. the Phase 3A4R4 real path is closed, unconditionally, before every gate
    (`PHASE3A4R4_RETIREMENT_TEST`), and the real durable budget is never even initialized;
11. no test can invoke real custody: real custody refuses in source, and the runner owns no
    interactive terminal;
12. no raw-output leak: neither the route's output, its result, nor the durable marker contains the
    signature the run produced, or any secret-shaped field;
13. no network path in the changed modules;
14. no submit path: nothing is posted, submitted, or turned into a transport object.
