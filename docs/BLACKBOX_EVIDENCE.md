# Evidence Capsules

`blackbox-evidence/v1` is portable JSON containing the pin, counts, ordered
canonical hashes, terminal state, replay fingerprint, invariant result, and
limitations. It is local verification evidence, not an identity certificate,
reward proof, payment receipt, or settlement proof. The export path builds an
allow-list and recursively rejects sensitive key names without printing values.

The Phase 2.1 drawer directly projects capsule version, pin, replay fingerprint,
counts, terminal state, invariant count, and completeness warning. Export scans
the capsule again before creating a local download; UI convenience never
bypasses the sentinel.

`OBSERVED != COMPLETE`: completeness of the supplied transcript does not
establish complete Technocore room history.