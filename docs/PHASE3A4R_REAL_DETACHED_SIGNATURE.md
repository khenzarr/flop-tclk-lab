# Phase 3A.4R — one real detached room signature

Operator-only plan. It was not executed in Phase 3A.6.

1. Require fresh explicit operator approval for exactly one signature.
2. Use a synthetic, non-Phase3B room and approved BYTE-FROZEN text.
3. Invoke only `sign_room_detached(room, text)` through canonical local custody.
4. Verify `room|nonce|clean_text(text)` locally and confirm transport calls are
   zero.
5. Record the nonce as intentionally consumed: reserved locally, not observed
   by Technocore, and not reusable locally.
6. Hold the raw `SignedOperation` only long enough for verification. Do not
   persist, screenshot, or log it.

The result may be `POST_ELIGIBLE`; it is not `POSTED`, `DELIVERED`, or
`ACCEPTED_BY_TECHNOCORE`. No retry is allowed without new operator approval.
No Phase 3B room or payload may be used.