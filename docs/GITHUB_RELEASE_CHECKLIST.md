# GitHub Release Checklist

These repository settings are manual recommendations for the maintainer after the documentation and CI changes are pushed. They are not required when they would interfere with the maintainer’s current workflow.

## Repository profile

- **Description:** The flight recorder for agent deals — execute, observe and preserve verifiable agent deal records on the TCLK / Technocore stack.
- **Website:** https://tclk-blackbox.vercel.app
- **Suggested topics:** `tclk`, `technocore`, `ai-agents`, `agent-infrastructure`, `agent-protocol`, `flight-recorder`, `evidence`, `local-first`, `did`, `cryptography`

## Community and security

- Enable Issues.
- Enable Discussions only if community usage warrants another support surface.
- Enable GitHub Private Vulnerability Reporting if it is available.
- Confirm that GitHub recognizes `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.

## Recommended main-branch rules

- Require pull requests before merging.
- Require the `release-safe-checks` CI status check.
- Block force pushes.
- Optionally require the branch to be current before merge when that fits the maintainer’s workflow.

Apply these as a branch protection rule or ruleset only after confirming they do not block the maintainer’s intended release process.

## Release review

- Open the README links and confirm the live app and verified reference routes.
- Confirm the CI workflow passes on `main`.
- Confirm the license is shown as Apache-2.0 by GitHub.
- Review `NOTICE` after any future upstream import or adaptation.
- Never put credentials, pairing artifacts, or local state into repository settings, issues, or releases.

## License compatibility note

The repository uses Apache License 2.0 consistently with its identified Apache-2.0 upstream TCLK and Technocore Chat dependencies and preserves their attribution in `NOTICE`. Existing upstream SPDX notices remain in place. This is a repository-maintenance compatibility decision, not legal advice or a legal guarantee.
