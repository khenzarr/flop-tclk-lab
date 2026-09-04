# Detached signer bridge

Blackbox invokes the canonical Python worktree through a one-shot captured stdin/stdout process.
The only operation is `Signer.sign_room_detached(room, text)`. The request carries room, text,
request ID, reviewed commit pin, schema, and an isolated temporary nonce path; it never carries a
key, seed, mnemonic, passphrase, DPAPI blob, or generic Python expression.

The reviewed commit pin is authoritative in Blackbox. The bridge does not embed its own commit
SHA (which would be self-referential); it obtains its repository `HEAD` with `git rev-parse` at
runtime and refuses unless that actual SHA equals the request pin. The parent independently checks
the exact canonical worktree and scoped clean tree before invocation. The response includes the
actual SHA as safe provenance metadata.

The Python entrypoint uses a disposable test key in Phase 3A.7. A future custody-enabled process
must own any trusted prompt itself; Blackbox will not capture credentials or pass them by argument,
environment, JSON, or file. Node captures stdout in memory, parses the allowlisted public operation,
and never logs raw output. There is no submit operation, transport object, or network API in this
bridge. `POST_ELIGIBLE` remains a local artifact state and `POSTED=false`.