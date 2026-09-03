# Upstream Drift — Phase 3A

Machine-readable companion: `evidence/upstream-drift-phase3a.json`.

The old Blackbox pin was not assumed current. `.upstream` was refreshed against
live `origin/main` before anything else in this phase ran.

## Current upstream

| Field | Value |
|---|---|
| Remote | `https://github.com/flop-labs/tclk` |
| Branch | `main` |
| HEAD | `103a1b960c117c82473ee058b7dca1769e167125` |
| HEAD date | 2026-09-03T15:34:07+08:00 |
| Package | `@flop-labs/tclk` 0.1.0 |
| Package manager | `pnpm@11.25.0` |
| Access | read-only fetch; no push, no PR, no issue, no upstream edit |

Old pin `81a83464bd909fb5cd80de647da4e42fbae177dd` (2026-09-02) is retained on
disk so A/B replay against both trees stays possible.

## Distance

10 commits, 39 files changed.

| Commit | Subject | Class |
|---|---|---|
| `103a1b9` | fix: close live-wire conformance gaps (#42) | PROTOCOL_SEMANTICS_CHANGED |
| `162b331` | feat: authenticate complete transcript records (#40) | REQUIRES_ADAPTATION |
| `1ced9a1` | chore: align changelog and required CI (#39) | SAFE_FOR_BLACKBOX |
| `8872fab` | fix(adaptor): reject out-of-range scalar (#27) | SAFE_FOR_BLACKBOX |
| `563bcbf` | fix(technocore): reject malformed note metadata (#35) | SAFE_FOR_BLACKBOX |
| `4b8f2c6` | fix(examples): default-venue fallback, Windows syntax (#19) | SAFE_FOR_BLACKBOX |
| `1459b78` | fix(locks): unknown lock kind verifies nothing (#15) | SAFE_FOR_BLACKBOX |
| `04c7911` | fix(locks): reject malformed deadline inputs (#34) | SAFE_FOR_BLACKBOX |
| `f3eb89c` | fix(machine): reject non-finite/negative clock (#14) | SAFE_FOR_BLACKBOX |
| `528190f` | fix: validate PaperRail statements during decode (#29) | SAFE_FOR_BLACKBOX |

New surfaces: `src/transcript.ts`, `src/rails.ts`,
`src/frame-fields.generated.ts`, `schema/tclk1-frames.schema.json`,
`examples/audit-export.mjs`, plus live-wire / transcript / schema-conformance
test files.

## The two classifications that matter

### `103a1b9` — PROTOCOL_SEMANTICS_CHANGED

`applyFrame` now rejects `lock` when the refund window is already open
(`nowMs >= refundAfterMs`). Previously such a lock was accepted.

This is a **fail-closed tightening of an existing transition**, not a wire
change. A frame that encoded to bytes X still encodes to bytes X; what changed
is whether the machine will accept it at a given clock. Our Phase 2 fixture set
contains one lock authored with a refund window that is already open at lock
time, which the old pin accepted and current head refuses.

Because this alters an *accepted* replay outcome, Blackbox is **not** repinned in
this phase. Repinning would silently rewrite a Phase 2.1 accepted fingerprint.

### `162b331` — REQUIRES_ADAPTATION

`foldTranscript` no longer accepts bare frame lines. It requires complete signed
transcript records (`line`, `room`, `seq`, venue timestamp, `sender`, `nonce`,
`signature`) and verifies both the signature and the sender binding.
`tclk_apply_transcript` lost its fallback clock.

Consequence for us: any future real transcript import must carry the full record
shape. Our live-import adapter (`blackbox/core/live-import.mjs`) is built to that
shape and stays inert until Phase 3B is approved.

## CHANGELOG `[Unreleased]`

Added — schema-owned `tclk/1` frame field contract, canonical settlement-rail
registry, order-independent rail matching, SPEC drift check in CI, signed
heartbeat frame for non-authoritative liveness, hosted no-custody MCP deployment
that refuses to bind signing or payment keys.

Changed — `foldTranscript` consumes complete signed transcript records;
`tclk_read_room` returns that shape with `full:true`; `tclk_apply_transcript`
accepts only records.

Fixed — `applyFrame` rejects `lock` when the refund window is already open;
reveal/refund builders carry the preceding lock's rail reference.

## Open upstream work relevant to our surfaces

Indexed for risk assessment only. **Nothing was opened, commented on, or
modified upstream in this phase**, per the phase separation rule.

- Frames / canonicalization: PR #60, #59, #16; issues #48, #26
- State machine: PR #32; issues #41, #36, #12
- MCP signing: PR #55, #54
- Live deal: PR #56, #45; issues #3, #2
- Rails: PR #21
- Transcript audit: PR #62, #52; issue #61
- Receipt semantics: PR #51; issue #5
- Protocol direction: PR #58; issue #57

Material to Phase 3B: **#61, #3, #2, #45, #56.**

Issue #61 claims the SPEC §2 room binding is unsatisfiable on the shared venue
and that `foldTranscript` therefore rejects every live deal. If that holds, a
public rehearsal would produce a transcript we cannot fold — an unusable
evidence chain. #3, #2, #45 and #56 describe venue-level failure modes (room
cap, 5xx handling, unbounded attempts) that one intentional deal would plausibly
hit. Phase 3B is gated on the room-binding question having an upstream answer.

## Stop conditions

| Condition | Result |
|---|---|
| Canonical wire format changed incompatibly | No |
| Existing state semantics changed incompatibly | No — tightening, attributed |
| Current-head clean checkout gates failed | No — 158/158 pass |
| STOP triggered | No |

Overall: **REQUIRES_ADAPTATION**, `BLACKBOX_REPINNED=NO`.
