# Detached room signing boundary

`sign_room_detached(room, text)` validates and cleans input, consumes the
canonical local room nonce, signs `room|nonce|clean_text(text)` inside canonical
custody, and returns the existing `SignedOperation`. It has no Technocore
transport capability.

The result classification is `DETACHED_SIGNED_OPERATION`:

- `NETWORK_SUBMITTED=false`
- `LOCAL_NONCE_CONSUMED=true`
- nonce disposition: reserved locally, not observed by Technocore, not reusable
  locally

Reservation is durable and is not rolled back. This is safe for the signed ROOM
lane because the authoritative rule is strictly increasing per DID per room and
allows gaps. It is not a claim about signed-note semantics.

The Blackbox adapter validates the Airlock approval and BYTE FREEZE, hands the
approved room and text to its fixture-only detached contract, verifies locally,
creates the custody seal, and stops at `POST_ELIGIBLE`. It contains no submit
boundary. `POST_ELIGIBLE` never means `POSTED`, delivered, or accepted.

This surface proves local byte binding, fixture signature validity, local nonce
consumption semantics, and zero transport invocation. It does not prove venue
acceptance, delivery, permanent replay prevention, or any Technocore write.