# Phase 3A.10.3 — Human execution runbook

**RUN MANUALLY IN NORMAL POWERSHELL. DO NOT RUN THROUGH CLINE.
ONE REAL SIGNATURE ONLY. ONE LOCAL NONCE WILL BE CONSUMED. NO RETRY.
NO TECHNOCORE SUBMISSION.**

These are **human-in-the-loop safety mechanisms**, not cryptographic identity
authentication. They prevent unattended real-custody execution and bind each
confirmation to the exact byte-frozen request. The real route is executable in
source; it is deliberately not automatable.

## Two direct human checkpoints

| # | Where | What you type | Bound to |
| - | ----- | ------------- | -------- |
| 1 | Blackbox terminal | `SIGN ONCE <4-HEX>` | request fingerprint |
| 2 | Canonical child terminal | `SIGN DETACHED <8-HEX>` | frozen request frame |

Checkpoint 2 is an independent gate inside the canonical process: it refuses
without its own interactive TTY, attests the reviewed commit, and requires the
phrase before any custody provider is constructed. Neither phrase can come from
argv, an environment variable, the request file, or a previous run. The request
file is transport, never authorization.

A custody credential prompt, if the DPAPI provider raises one, comes **after**
both checkpoints and belongs to the canonical child's own terminal.

## Procedure

1. Stop/close Cline execution for the real-signing step.
2. Open a normal, interactive PowerShell terminal (not a pipe, redirect, CI job,
   task runner, or ChatGPT/Cline terminal).
3. Run:

   ```powershell
   cd C:\Users\mertb\Desktop\NODE\flop-tclk-lab
   git rev-parse HEAD
   pnpm airlock:real-detached-sign
   ```

4. Inspect every displayed binding value and the full request fingerprint:
   room, signer DID, canonical hash, canonical commit, TCLK pin, Phase 3B
   non-reuse.
5. **Checkpoint 1.** Type the displayed `SIGN ONCE <4-HEX>` phrase exactly.
   Blank input or Ctrl+C cancels. A wrong phrase refuses; there is no retry.
6. The route rechecks every binding value after approval. Any mutation between
   approval and handoff voids the approval before custody.
7. **Checkpoint 2.** The canonical child displays its own confirmation
   (`CANONICAL PROTECTED CUSTODY / DETACHED ROOM SIGNATURE / NO NETWORK
   SUBMISSION`, room, frame fingerprint, `LOCAL NONCE: WILL BE CONSUMED`,
   `MAX SIGNATURES: 1`). Type the displayed `SIGN DETACHED <8-HEX>` phrase
   exactly into that same terminal.
8. If canonical custody asks for a credential, type it directly into the
   canonical child process. Never paste or disclose it to ChatGPT/Cline; Node
   does not capture or proxy child stdin.
9. The route signs once via `Signer.sign_room_detached`, verifies the signature
   locally, prints binding values plus `POSTED=false`, and stops. No submission
   path exists on this route.
10. Do not rerun. The budget is one, it is consumed before the signer is
    contacted, and retry is disabled.
11. Return only a sanitized final report to ChatGPT/Cline: no credential, key,
    raw signature, or raw SignedOperation.

## Cancelling safely

Cancelling at checkpoint 1 touches no custody and consumes no nonce.
Cancelling at checkpoint 2 refuses before the custody provider is constructed.
After checkpoint 2 is accepted, assume the local nonce is consumed even if a
later step fails: a signature that fails afterwards has still been produced.

Phase 3A.10.3 itself performed no real signature, reserved no real nonce,
accessed no real key, and made no Technocore read or write. Validation ran the
same production control flow with fixture custody and fixture input providers.
