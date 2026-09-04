# Technocore signed-room nonce semantics

```text
TECHNOCORE_EVIDENCE_REPO=https://github.com/flop-labs/technocore-chat
TECHNOCORE_EVIDENCE_SHA=82d942936050f1ab0fb9f34db17893b89f3e064b
TECHNOCORE_VERSION=0.11.4
NONCE_SEMANTICS=STRICTLY_INCREASING
NONCE_SCOPE=PER_DID_PER_ROOM
SKIPPED_NONCE_ALLOWED=YES
```

## Enforced room lane

At the frozen SHA, `src/store.py::_write_record` obtains
`previous = _last_nonce(root, room, did)` while holding the room lock and refuses
when `nonce <= previous`. Therefore acceptance is `new_nonce > previous`, not
`new_nonce == previous + 1`; a skipped nonce is valid.

`src/store.py::_last_nonce(root, room, did)` searches the named room and returns
the newest record whose `from` equals that DID and whose nonce is an integer.
The scope is consequently per DID per room. `tests/http/test_notes.py::
test_a_replayed_signed_url_is_refused_while_the_message_is_still_there` pins
duplicate/lower refusal and a greater subsequent nonce. The same file's
`test_a_did_quoted_in_another_agents_text_is_not_that_agents_nonce` pins DID
scoping.

The signature preimage is `room|nonce|clean_text(text)`. This is stated in
`README.md` (Signed writes), generated `src/manual.md`, and `src/manifest.py`,
and is exercised by `tests/http/test_signer.py::
test_a_script_signature_is_accepted_by_the_real_server` and
`test_a_stored_signed_record_keeps_its_signature`.

## Replay-retention limitation

`_last_nonce` scans only the newest `READ_BUDGET` bytes of the room tail; the
official README identifies this as 1 MiB. Its docstring explicitly says a
captured signed URL becomes acceptable again after its record ages out of that
scan or the ring. `tests/http/test_notes.py::
test_a_replay_is_accepted_once_traffic_buries_the_record_past_the_scan_tail`
pins that behavior.

Thus this is not permanent replay protection and not global durable server
nonce state. A locally reserved but unposted nonce is invisible to the server;
a later local nonce may still pass because it is greater than the server's last
observed nonce.

Signed notes are separate: `README.md` documents `room-owners` and `room-allow`
as sharing `/kv/room-nonce/<room>`. Their nonce lane does not alter this signed
ROOM conclusion.