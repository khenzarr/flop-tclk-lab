# Chaos Mode

Chaos is an offline protocol-invariant laboratory, not a penetration-testing
suite. It applies deterministic mutations — replay, wrong party/secret,
out-of-order reveal, canonical mutation, duplicate terminal action, malformed
frame, and unknown field — then runs the pinned upstream machine. A passing
mutation has a rejection and identical state digest before and after.