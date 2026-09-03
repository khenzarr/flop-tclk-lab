# Chaos Mode

Chaos is an offline protocol-invariant laboratory, not a penetration-testing
suite. It applies deterministic mutations — replay, wrong party/secret,
out-of-order reveal, canonical mutation, duplicate terminal action, malformed
frame, and unknown field — then runs the pinned upstream machine. A passing
mutation has a rejection and identical state digest before and after.

Phase 2.1 presents these fixtures as `CHAOS LAB`: mutation, expected invariant,
actual pinned-upstream result, before/after state, state mutation, and PASS/FAIL.
The rejection boundary comes from replay evidence; expected results never
replace the actual upstream result.