# Phase 3B s2 superseding execution

This is the only command sequence for the fresh `phase3b-s2` lineage. It performs no automatic retry. Stop immediately on `REJECTED`, `SUBMISSION_UNCERTAIN`, `WRITE_UNCERTAIN`, `REFUSED`, `PUBLIC_VALUE_MISMATCH`, or `PUBLIC_READ_INVALID`.

The signer obtains and durably reserves a safe nonce inside the existing trusted production signer only after both human approval gates. No nonce is supplied on the command line.

```powershell
pnpm phase3b:s2:sign -- --operation phase3b-s2-write-1
pnpm phase3b:s2:submit -- --operation phase3b-s2-write-1
pnpm phase3b:s2:observe -- --operation phase3b-s2-write-1

pnpm phase3b:s2:sign -- --operation phase3b-s2-write-2
pnpm phase3b:s2:submit -- --operation phase3b-s2-write-2
pnpm phase3b:s2:observe -- --operation phase3b-s2-write-2

pnpm phase3b:s2:sign -- --operation phase3b-s2-write-3
pnpm phase3b:s2:submit -- --operation phase3b-s2-write-3
pnpm phase3b:s2:observe -- --operation phase3b-s2-write-3

pnpm phase3b:s2:rail-preflight -- --operation phase3b-s2-write-5
pnpm phase3b:s2:rail-write -- --operation phase3b-s2-write-5
pnpm phase3b:s2:rail-observe -- --operation phase3b-s2-write-5

pnpm phase3b:s2:sign -- --operation phase3b-s2-write-4
pnpm phase3b:s2:submit -- --operation phase3b-s2-write-4
pnpm phase3b:s2:observe -- --operation phase3b-s2-write-4

pnpm phase3b:s2:rail-preflight -- --operation phase3b-s2-write-6
pnpm phase3b:s2:rail-write -- --operation phase3b-s2-write-6
pnpm phase3b:s2:rail-observe -- --operation phase3b-s2-write-6

pnpm phase3b:s2:finalize
```
