# Phase 3A.9 — Human execution runbook

This is a **human-in-the-loop safety mechanism**, not cryptographic identity
authentication. It prevents unattended real-custody execution and binds local
confirmation to the exact byte-frozen request.

1. Stop/close Cline execution for the real-signing step.
2. Open a normal, interactive PowerShell terminal (not a pipe, redirect, CI job,
   task runner, or ChatGPT/Cline terminal).
3. Run:

   ```powershell
   cd C:\Users\mertb\Desktop\NODE\flop-tclk-lab
   git rev-parse HEAD
   pnpm airlock:real-detached-sign
   ```

4. Inspect every displayed binding value and the full request fingerprint.
5. In the future real-enabled phase, manually type the displayed
   `SIGN ONCE <4-HEX-CODE>` phrase. It cannot be supplied as an argument or
   environment variable. Blank input or Ctrl+C cancels.
6. If canonical custody asks for a credential, type it directly into the
   canonical child process. Never paste or disclose it to ChatGPT/Cline; Node
   does not capture or proxy child stdin.
7. Do not rerun after one signing attempt. The budget is one and retry is
   disabled.
8. Return only a sanitized final report to ChatGPT/Cline: no credential, key,
   raw signature, or raw SignedOperation.

The Phase 3A.9 implementation stops before approval/custody and performs no
real signature, nonce reservation, Technocore read/write, or posting.