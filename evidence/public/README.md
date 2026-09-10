# Phase 3B final public evidence

This directory contains a deterministic, public-safe projection of the authoritative machine-local Phase 3B production evidence.

It proves that the six manifest-bound operations have the receipt and public-observation evidence stated in the capsule. It does not prove human identity, wallet ownership, independent counterparties, payment, reputation, eligibility, or FLOP identity.

- Source manifest root: `887eb9996c701260e5d78f1798b6577f62575db20a625bcaee7b12523d3ecd2f`
- Regenerate: `pnpm evidence:public:final`
- Verify: compute SHA-256 over `phase3b-final-public-capsule.json` and compare it with `phase3b-final-public-capsule.sha256`.
