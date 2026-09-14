# W2 optional validation-result publication

W2 is an optional, manual extension of an existing completed W1 Flight Record. It does not rerun W1, change the W1 artifact, create a TCLK deal, claim contribution value, or publish automatically.

Implementation status: W2 is enabled only when the local signer repository is exactly the reviewed immutable commit `ceee25b573c9385e79b50b46ddd044204185aa3e` and its relevant custody tree is clean. A missing, wrong, or dirty signer pin keeps W2 unavailable without affecting W1. No W2 action is automatic; preparation, signing, submission, and observation remain separately initiated.

## Frozen implementation addendum

- `ROOM_BINDING=TECHNOCORE_NATIVE_SIGNATURE_BINDING`: Technocore signs the exact UTF-8 bytes `<room>|<nonce>|<text>`.
- `VENUE_BINDING=BLACKBOX_ASSERTION_APPLICATION_BINDING`: `venueOrigin` is inside the signed W2 assertion.
- `VENUE_TRANSPORT_NATIVE_BINDING=NO`: before POST, BLACKBOX requires the approved venue, assertion venue, and actual HTTP destination origin to be identical.
- A W2 nonce is decimal text matching `^(?:0|[1-9][0-9]{0,18})$`. It is never converted through JavaScript `Number`; padding, signs, exponents, decimal points, and whitespace are refused.
- Public observation uses exact origin, room, DID, nonce lexeme, text, signature, and offline signature verification. Zero matches means `NOT_OBSERVED`; one or more means `OBSERVED_PUBLIC`; more than one also records `DUPLICATE_PUBLIC_MATCH`. A duplicate is an anomaly, not extra work, and does not erase observation.

The exact assertion is printable ASCII `blackbox-w2 ` followed by recursively key-sorted compact JSON. It commits to the immutable W1 evidence artifact without embedding the transcript or clear room. A local terminal approval binds the exact assertion, room, venue, DID, reserved nonce, operation identity, and expiry before signing. Signing does not authorize submission. Submission has a separate exact approval and one durable attempt that is spent before the socket call; no timeout, 5xx, reset, restart, or missing acknowledgement permits a retry.

An application acknowledgement only means the contacted TLS venue returned an exact posted-record response. It is not public observation. An ambiguous result is recovered only by explicit read-only observation of the same signed operation. Completion requires the unchanged W1 commitment, a locally verified signature, a durably spent submit attempt, and at least one exact retained public match.

Cancellation never releases a reserved nonce. A signed but unsubmitted operation remains in the local audit record. W2 has no batch, background, scheduled, automatic, or remote-content-triggered publication.

> This is a self-published assertion that the named DID signed a BLACKBOX W1 result. It does not prove independent contribution, external demand, quality, economic value, reward eligibility, FLOP ownership, or independent peer acceptance.
