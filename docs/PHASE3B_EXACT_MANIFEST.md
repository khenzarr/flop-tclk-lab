# Phase 3B.1 — exact write manifest

**FROZEN** against the runtime-attested TCLK pin `d48e87343200e3115e243df39e8f295f5ce2e645`. This is a fixture-only, unsigned, unposted plan.

- Manifest root: `9be158c613e68533a1700fdb2e08fac1adcacba16370551a98403b7d10922d8f`
- Runtime attestation: `PASS`
- Source SHA: `d48e87343200e3115e243df39e8f295f5ce2e645`
- Lockfile SHA: `94bce4421a367073e906119bcc8e702395972406200852acee0c1d74411e7233`
- Dist tree SHA: `01cd72e1b9a518d5caa7f2c279a021182c37b5dfee3da804f26893e7f90ce27b`
- Production closure SHA: `undefined`
- Canonical signing commit: `124d621dd8c68b04bed79744ab332e8305093d02`
- Canonical enrollment commit: `3675aeacdb73656285c4253b6d6d8d937afe25d6`
- Technocore evidence: `82d942936050f1ab0fb9f34db17893b89f3e064b`
- Public footprint: 4 signed TCLK room writes + 2 unsigned PaperRail KV note writes = 6
- PaperRail trust: every note mutation is SIGNED=false, WORLD_WRITABLE=true, AUTHORSHIP_PROOF=NONE, EVIDENCE_CLASS=UNSIGNED_RAIL_OBSERVATION
- Fixture trajectory: `proposed → accepted → locked → claimed`
- Safety: no key access, signature, nonce reservation, transport, network, public action or value movement.

The reveal preimage and execution id are deliberately absent. This artifact is not an authorization to execute a public write.
