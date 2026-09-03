# Replay Determinism

For this version, `blackboxReplayHash` is
`sha256("FLOPLAB::blackbox::replay::v1|" + canonicalJson(evidence))`.
`evidence` contains the pinned upstream SHA/package, explicit simulated
`nowMs`, and ordered step verdicts/digests. Wall-clock generation time and
secrets are excluded. Canonical frame hashes are SHA-256 of the UTF-8 bytes
returned by upstream `encodeFrame`; malformed frames have no canonical hash.

The same lines, time, and pinned implementation therefore yield the same
fingerprint. A replay is complete only for its provided input, never a claim
about a complete Technocore room history.