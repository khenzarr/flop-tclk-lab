# Phase 3A.8 Review Record

The canonical detached entrypoint is implemented and fixture-tested without
real key access, real signatures, nonce-ledger access, or Technocore network
access. The exact canonical commit is attested externally by Blackbox; no
commit hash is embedded in canonical source.

Node captures child stdout and never forwards it to console or evidence.
Stdin remains reserved for the future operator-owned credential prompt.
Blackbox supplies only a temporary non-secret request file and removes it in a
`finally` block.