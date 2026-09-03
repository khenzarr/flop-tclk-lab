# TCLK Blackbox — Product Thesis

## Problem

TCLK frames are an ordered, hostile-input transcript, but the upstream example
and MCP surfaces primarily return a final view. Debugging needs the rejected
boundary: precisely which frame was refused, why, and whether state stayed
unchanged.

## Target users

Protocol implementers, agent-integration developers, testnet-readiness reviewers,
and evidence-minded operators working offline with synthetic or sanitized data.

## Alternatives and difference

The obvious alternative is the upstream `tclk_apply_transcript` fold and the
upstream examples. Blackbox is not a command wrapper or dashboard: it is a
flight recorder that preserves state-before/after digests, canonical frame
hashes, upstream reasons, deterministic replay fingerprints, and a visual
rejection boundary. CHAOS reruns the same pinned machine against mutations.

## Refusals

Blackbox does not claim identity, reputation, trustworthiness, solvency, FLOP
or reward eligibility, payment, DID ownership, or complete Technocore history.
An evidence capsule proves only what this local verifier observed.

## Future settlement rails

When settlement rails arrive, the same protocol transcript and evidence model
can associate explicit rail references without confusing them with protocol
facts. The boundary between PROTOCOL, CUSTODY, and RAIL keeps the tool useful
while preventing a local replay from becoming a payment claim.