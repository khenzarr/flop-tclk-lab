# Phase 3A.2 — Candidate Drift Decomposition

## Scope and freeze

This review audits only `d48e87343200e3115e243df39e8f295f5ce2e645`, compared with `103a1b960c117c82473ee058b7dca1769e167125`. The historical baseline remains `81a83464bd909fb5cd80de647da4e42fbae177dd`. No moving `main` changes were included.

Candidate object: commit, tree `40a4213797e064ad22955d56af2cb9cfb6a35085`, parent `c72861466f2023e2069a2e8b5b66fe586ac40654`, author `memosr.eth`, authored 2026-09-03, commit message `fix(mcp): isolate a malformed envelope in a window read instead of failing it whole (#52)`. Git signature status: `E` (no trusted/valid signature established by the local Git verifier).

## Commit-by-commit classification

### `989bf899b5f54a05b8af537ce8d2aec350d86595` — WIRE / DECODER / TEST_ONLY

Files: `src/frames.ts`, `src/adaptor.ts`, `src/frames.test.ts` (and associated source/test changes as shown by the candidate diff).

The decoder now enforces the existing 4096-character room-message limit before parsing; the encoder already refused over-cap output. Below and at 4096 remain accepted; 4097 is rejected before body parsing with `tclk: frame exceeds the 4096-char room-message cap (4097)`. This is fail-closed hardening, not a canonical encoding change. Existing Blackbox fixture lines have maximum length 352, so they remain within bounds. The historical pin accepted an over-cap input in the focused probe; the candidate does not. Canonical frame lines, offer IDs, and contract IDs are unchanged.

### `a6391df528f198c14555dda721d44f75e0b1bfe6` — SCHEMA / DECODER / TEST_ONLY

Files: `schema/tclk1-frames.schema.json`, `src/adaptor.ts`, `src/adaptor.test.ts` (plus candidate test updates).

The published schema was brought into alignment with decoder behavior, notably for adaptor signature `s`: values rejected by the runtime decoder are no longer advertised as schema-valid. Focused runtime probes found no acceptance-set change between comparison and candidate for the tested odd, empty, even, uppercase-protocol, and empty identifier/context cases; the candidate rejects the all-zero/even adaptor witness consistently with runtime semantics. Classification: `FAIL_CLOSED_HARDENING`; no Blackbox wire or valid-fixture break observed.

### `9acc318af94e622e0f589010bbca3dec6f9f59fe` — DECODER / TEST_ONLY

Files: `src/hex.ts`, `src/hex.test.ts` (exact candidate diff).

Non-hex, missing `0x` prefix, uppercase `0X` prefix, odd-length, empty, and malformed inputs now use a uniform rejection reason without echoing the rejected value. The accepted language, normalization, uppercase body behavior, and statement-case handling did not change in the probe. Classification: `ERROR_SEMANTICS_ONLY`; acceptance set unchanged, canonical bytes unchanged. Blackbox state-machine behavior is not changed by reason wording alone, and the stable local rejection-reason model is not required for this candidate because current-v2 raw reasons were identical across comparison and candidate.

### `c72861466f2023e2069a2e8b5b66fe586ac40654` — RECEIPT / STATE_MACHINE / TEST_ONLY

Files: `src/state.ts`, `src/receipts.ts`, `src/receipts.test.ts` (and exact candidate diff files).

Receipt rail and reference, when supplied, must match the contract’s rail and `railRef`; mismatched values now refuse closed with explicit reasons. Bare receipts remain accepted. Zero adaptor witnesses are refused rather than treated as usable witnesses. Contradictory receipt outcomes were already refused. Classification: `FAIL_CLOSED_HARDENING` with a deliberate semantic tightening for malformed/contradictory receipt evidence; no canonical frame, offer ID, or contract ID change. Current Blackbox receipt projections and historical evidence capsules remain readable; no valid current-v2 fixture depends on the newly refused values.

### `d48e87343200e3115e243df39e8f295f5ce2e645` — MCP / TEST_ONLY / DOCS_ONLY

Files: `mcp/src/server.ts`, `mcp/src/tools.ts`, `mcp/tests/transport.test.ts`, `mcp/worker/src/tool-manifest.generated.ts`, `CHANGELOG.md`.

A malformed envelope in a window read is isolated instead of failing the entire window. This is local MCP transport fail-closed isolation and does not alter TCLK frame encoding, schema interpretation, receipt semantics, IDs, or Blackbox state transitions. Candidate MCP gates passed: 8 test files, 68 tests.

## Golden-vector and compatibility conclusion

Across `81a8346`, `103a1b9`, and `d48e873`, canonical frame lines, protocol prefix/version/domain, offer IDs, contract IDs, and canonical JSON are identical for the golden vectors. No deliberate protocol version-prefix change occurred. The candidate is wire-format compatible. Historical fixtures remain decodable and structurally valid; the historical normal-refund fixture now fails closed at apply because of the known evaluation-timing migration finding, while happy claim, cancel-before-lock, and adversarial refusal cases preserve their classified outcomes.

Evidence source: `evidence/phase3a2-candidate-audit.json` and offline `lab/candidate-probe.mjs`. No live Technocore activity or real signer was used.
