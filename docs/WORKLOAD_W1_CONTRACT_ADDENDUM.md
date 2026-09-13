# W1 contract addendum — implementation precedence

This addendum supersedes only the conflicting W1 discovery-contract details in reports 07–10 outside this repository. `technocore-transcript-validation/v1` remains local-only. No W1 signing, nonce allocation, public submission, PaperRail write, contribution score, or FLOP behavior.

## Deterministic workload identity

`workloadId` is lowercase hex SHA-256 of the following exact bytes: UTF-8 `blackbox:technocore-transcript-validation:v1`, then for each of the three ASCII components `inputSha256` (64 lowercase hex), `verifierId`, `checkProfileId`, an unsigned 32-bit big-endian byte length followed by that component's UTF-8 bytes. No separators or machine-dependent values. The domain is fixed. Room, generation, file path, execution time, random/session/pairing identifiers are **not included**. Identical bytes + verifier/profile produce the same ID even if room or generation context differs. The signature check still requires the supplied room; different room contexts can produce different verdict revisions for the same workload identity. A rerun or context change is never another work unit. Implementation digest identifies a result run, not workload identity.

## Room and raw-byte privacy

Room is local context. Public-safe evidence defaults to `roomDisplay: "REDACTED"` and **omits the clear room and any room hash**. SHA-256 of a low-entropy room name is pseudonymous, not secret; no public room commitment is required in W1. The local connector owns file selection and raw bytes on `127.0.0.1`. The production origin only receives a public-safe descriptor/result; no production-origin file picker, transcript upload, arbitrary path API, or raw transcript in a browser response. An external re-verifier needs separately supplied original bytes and room, and the artifact must say so.

## Error boundary

Preflight/resource-policy rejection produces `INPUT_REJECTED` and **no transcript verdict**: `INPUT_TOO_LARGE`, `TOO_MANY_RECORDS`, `LINE_TOO_LARGE`, `INVALID_UTF8`, `UNSUPPORTED_INPUT_ENVELOPE` (including BOM, mixed endings, invalid room/header and unsupported media type). A runtime timeout, memory exhaustion or unexpected verifier failure produces `INTERNAL_ERROR` (`VERIFIER_TIMEOUT`, `RESOURCE_EXHAUSTED`, `UNEXPECTED_VERIFIER_FAILURE`) and no verdict. These are not `VALID`, `INVALID`, or `INDETERMINATE`. Malformed admitted JSONL remains a decisive `INVALID` content check under report 07. Local diagnostic details never enter public-safe responses.

## Parser and verifier pin

Standard `JSON.parse` alone is insufficient because it discards duplicate members and rounds large numeric nonces. W1 must reject duplicate object names and preserve raw integer lexemes before semantic coercion with a small bounded parser or equivalent deterministic preparse. Source pin is computed from the ordered checked-in manifest `blackbox/airlock/signer.mjs`, `blackbox/workloads/transcript-validation/json.mjs`, `pin.mjs`, `verifier.mjs`: decode each UTF-8 source file and normalize CRLF or CR to LF, SHA-256 those canonical source bytes, then SHA-256 the domain `blackbox:w1:source-manifest:v1` followed by each repository-relative UTF-8 POSIX path's unsigned 32-bit big-endian length, the path bytes, and the 32 raw digest bytes. This keeps the pin stable across platform checkout line endings. No absolute path, mtime or build directory. Public evidence includes `verifierId`, `checkProfileId`, package/implementation version, implementation digest, `technocoreRef=20a4457b89ba11254f4aa48217b066884a148d98`, and `tclkRef` only if a TCLK check is actually run (not in base W1 profile).

## Flight Record and publication boundary

W1 uses the existing Flight Record **container** with a distinct `LOCAL_VALIDATION` computation presentation. It must not imitate deal transport states. `SIGNED`, `SUBMITTED`, `ACK_RECEIVED`, and `OBSERVED_PUBLIC` are absent. W2 may add optional publication evidence later without mutating the W1 input hash or result. All W1 transcript content is inert data and cannot authorize a tool, shell command, URL fetch, signature, or write.
