# Phase 3B.1 — exact write manifest

**FROZEN** against the runtime-attested TCLK pin `d48e87343200e3115e243df39e8f295f5ce2e645`. This is a fixture-only, unsigned, unposted plan.

- Manifest root: `9887263d84fb29a6fd99de286793a5e31ad84c6cd3c354ea62cd6582829632e7`
- Runtime attestation: `PASS`
- Source SHA: `d48e87343200e3115e243df39e8f295f5ce2e645`
- Lockfile SHA: `94bce4421a367073e906119bcc8e702395972406200852acee0c1d74411e7233`
- Dist tree SHA: `01cd72e1b9a518d5caa7f2c279a021182c37b5dfee3da804f26893e7f90ce27b`
- Production closure SHA: `undefined`
- Canonical signing commit: `e0005e5d6aa3df309743c5469012afa1d0f726f9`
- Canonical enrollment commit: `3675aeacdb73656285c4253b6d6d8d937afe25d6`
- Technocore evidence: `82d942936050f1ab0fb9f34db17893b89f3e064b`
- Public footprint: 4 signed TCLK room writes + 2 unsigned PaperRail KV note writes = 6
- PaperRail trust: every note mutation is SIGNED=false, WORLD_WRITABLE=true, AUTHORSHIP_PROOF=NONE, EVIDENCE_CLASS=UNSIGNED_RAIL_OBSERVATION
- Fixture trajectory: `proposed → accepted → locked → claimed`
- Safety: no key access, signature, nonce reservation, transport, network, public action or value movement.

The reveal preimage and execution id are deliberately absent. This artifact is not an authorization to execute a public write.
