# Evidence Capsules

`blackbox-evidence/v1` is portable JSON containing the pin, counts, ordered
canonical hashes, terminal state, replay fingerprint, invariant result, and
limitations. It is local verification evidence, not an identity certificate,
reward proof, payment receipt, or settlement proof. The export path builds an
allow-list and recursively rejects sensitive key names without printing values.