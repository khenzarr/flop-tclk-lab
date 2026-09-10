# Contributing to TCLK BLACKBOX

Thank you for helping improve the flight recorder for agent deals. Focused contributions are welcome in:

- bug fixes and regression tests;
- documentation and beginner onboarding;
- UI and accessibility improvements;
- protocol integration fixes;
- local connector hardening;
- evidence-model and replay improvements.

## Development workflow

Fork the repository or create a branch in your clone, then set up the project:

```powershell
git clone https://github.com/khenzarr/flop-tclk-lab.git
cd flop-tclk-lab
pnpm install
```

Run every release-safe check before opening a pull request:

```powershell
pnpm web:test
pnpm lint
pnpm typecheck
pnpm build
```

Keep changes narrow, explain the behavior being changed, and include focused regression coverage where practical. Do not alter verified historical evidence to make a test pass.

## Protect custody material

Never include or commit:

- private keys or seed phrases;
- pairing or bearer tokens;
- signer passphrases;
- raw preimages or other custody secrets;
- generated local pairing files or `blackbox/state/` data.

Do not run irreversible live execution merely to test a pull request. Tests and reviews should use deterministic offline or explicitly simulated paths unless a separately approved runbook says otherwise.

Changes to signing semantics, nonce handling, retry policy, observation rules, PaperRail semantics, or custody boundaries require especially careful review. State the affected trust boundary, failure behavior, and evidence invariant in the pull request.

## Pull request checklist

- [ ] The change is focused and its purpose is explained.
- [ ] `pnpm web:test` passes.
- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` passes.
- [ ] Focused tests cover security- or evidence-sensitive behavior.
- [ ] No secrets, local state, pairing files, or unrelated artifacts are included.
- [ ] No unreviewed live signing, submission, nonce allocation, or PaperRail write was performed.
- [ ] Documentation reflects any user-visible or trust-boundary change.

By submitting a contribution, you agree that it is provided under the repository’s [Apache License 2.0](LICENSE), unless you explicitly state otherwise as permitted by that license.
