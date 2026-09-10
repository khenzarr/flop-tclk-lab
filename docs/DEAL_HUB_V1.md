# TCLK BLACKBOX Deal Hub V1

Deal Hub turns the existing verified Flight Recorder into a local-first operating surface. A human can create an isolated deal session, supervise its six actions, verify public evidence, finalize the record, and export a public-safe capsule.

## Start locally

Open two terminals in the repository:

```powershell
pnpm connector
```

```powershell
pnpm dev
```

Open `http://127.0.0.1:4173/`. The connector prints the path of a short-lived pairing JSON file. Import that file in Deal Hub. The token is held only in browser session storage and is forgotten when that tab session ends or when **Forget pairing** is selected.

For a separately hosted web build, explicitly allow its exact origin before starting the connector:

```powershell
$env:BLACKBOX_WEB_ORIGIN='https://your-exact-origin.example'
pnpm connector
```

The V1 connector itself remains bound to `127.0.0.1:8787`.

To exercise the complete UI without live actions, use `pnpm connector:simulated` instead. Its first venue submit deliberately enters a labeled uncertain state, observation proves it absent, and the next reviewed recovery succeeds. The simulated banner remains visible throughout.

## Operator journey

1. Use **Start a deal** and select the two distinct local DID profiles.
2. Enter amount and asset. Creation writes an isolated local session but performs no real signature, nonce allocation, venue POST, or PaperRail write.
3. On the live record, **Review** freezes the next action. **Open terminal approval** starts its local terminal approval flow.
4. A signed action remains visibly signed, not submitted. A venue acknowledgement remains acknowledged, not observed. A PaperRail receipt remains a receipt, not an exact public match.
5. Use **Refresh public evidence** separately. Only the required exact observation unlocks the next operation.
6. Finalize only after all six evidence gates are verified, then export the public-safe JSON record.

There is no automatic retry. A timeout or 5xx becomes `SUBMISSION_UNCERTAIN`; the operator must observe first. An explicit 4xx becomes `REJECTED`. Recovery submission is offered only after bounded observation proves the exact record absent, and it receives a new durable one-shot budget while old attempts remain immutable.

## Custody and connector boundary

- Private keys, seeds, signer passphrases, DPAPI plaintext, raw deal preimages, and raw signatures never enter the browser.
- Pairing uses a random bearer token in a short-lived local file. The token is not printed, put in a URL, or written to browser persistent storage.
- Privileged endpoints require that bearer token and an exact allowed `Origin`. Private Network Access preflight is supported for the loopback boundary.
- The connector rejects arbitrary routes, request bodies above 32 KiB, expired pairing, excessive requests, and origins outside its allowlist.
- All signing and irreversible writes remain behind explicit local terminal approval and durable one-shot budgets.
- Session state is stored under the ignored `blackbox/state/deal-hub/` tree. Each deal has its own directory, secret record, operations, attempts, and final public capsule.

## Evidence semantics

The six V1 operations are `OFFER`, `ACCEPT`, `LOCK`, `RAIL_LOCK`, `REVEAL`, and `RAIL_CLAIM`. Signed venue operations require an exact retained public record. Rail operations require both a write receipt and an exact public value match. These are the same completion boundaries shown by the approved `/deal/phase3b-final` reference.

PaperRail is not a payment rail. It is unsigned and world-writable, and it proves neither human identity nor wallet ownership. Deal Hub records exactly what was observed without upgrading those facts into economic settlement or counterparty reputation.

## V1 scope and V1.1 extension

V1 is deliberately honest: one human operator controls two distinct cryptographic DIDs. It does not claim independent human counterparties.

The session model is generic and isolated, so multiple deals can coexist safely, but V1 does not orchestrate them globally. V1.1 can add remote counterparty pairing and a multi-deal scheduler as separate trust and coordination layers without weakening the current evidence gates.

## Simulated test mode

The connector supports an injected simulated executor for focused automated tests. Any simulated browser session is labeled `SIMULATED / LOCAL TEST` on the creation and live surfaces and in its exported capsule. Simulated state must never be presented as live public evidence.
