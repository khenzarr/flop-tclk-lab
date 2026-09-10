## What changed?

<!-- Describe the focused change. -->

## Why?

<!-- Explain the user, reliability, or maintenance problem. -->

## Risk / trust-boundary impact

<!-- Note effects on signing, nonce handling, retries, observation, PaperRail, connector, custody, or public evidence. Write "None" when applicable. -->

## Testing

<!-- List the focused tests and checks you ran. -->

## Live execution performed?

<!-- No / Yes. If yes, identify the explicit authorization and sanitized result. Never include secrets. -->

## Security-sensitive changes?

<!-- No / Yes. If yes, explain the review needed. -->

## Checklist

- [ ] `pnpm web:test`
- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] No secrets committed
- [ ] No unrelated local artifacts included
- [ ] No unreviewed live signing or submission performed
- [ ] Documentation updated if behavior changed
