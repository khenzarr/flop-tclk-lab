# Phase 3B final Railway execution

Venue: `https://technocore-chat-production.up.railway.app`

Stop on `REJECTED`, `SUBMISSION_UNCERTAIN`, `WRITE_UNCERTAIN`, `REFUSED`, `PUBLIC_VALUE_MISMATCH`, or `PUBLIC_READ_INVALID`. Never retry blindly.

```powershell
pnpm phase3b:final:sign -- --operation phase3b-final-write-1
pnpm phase3b:final:submit -- --operation phase3b-final-write-1
pnpm phase3b:final:observe -- --operation phase3b-final-write-1
pnpm phase3b:final:sign -- --operation phase3b-final-write-2
pnpm phase3b:final:submit -- --operation phase3b-final-write-2
pnpm phase3b:final:observe -- --operation phase3b-final-write-2
pnpm phase3b:final:sign -- --operation phase3b-final-write-3
pnpm phase3b:final:submit -- --operation phase3b-final-write-3
pnpm phase3b:final:observe -- --operation phase3b-final-write-3
pnpm phase3b:final:rail-preflight -- --operation phase3b-final-write-5
pnpm phase3b:final:rail-write -- --operation phase3b-final-write-5
pnpm phase3b:final:rail-observe -- --operation phase3b-final-write-5
pnpm phase3b:final:sign -- --operation phase3b-final-write-4
pnpm phase3b:final:submit -- --operation phase3b-final-write-4
pnpm phase3b:final:observe -- --operation phase3b-final-write-4
pnpm phase3b:final:rail-preflight -- --operation phase3b-final-write-6
pnpm phase3b:final:rail-write -- --operation phase3b-final-write-6
pnpm phase3b:final:rail-observe -- --operation phase3b-final-write-6
pnpm phase3b:final:finalize
```
