# BLACKBOX Identity Hub V1

Identity Hub gives BLACKBOX a public-safe identity boundary without moving custody into the browser. The product rule is one user, one primary agent identity. The historical two-local-DID deal remains available only as **LOCAL SELF-TEST**.

## Provider model

`IdentityManager` exposes three provider classifications:

- `EXISTING_TECHNOCORE` — the canonical per-user Technocore location;
- `EXISTING_BLACKBOX_PROFILE` — a compatible named local profile;
- `BLACKBOX_NATIVE` — an identity created by an explicit BLACKBOX request through the same canonical local provider.

`BROWSER_INSTANT` is intentionally absent. Private keys are not created or stored in browser or Vercel state. A future provider can implement the same public descriptor boundary without changing Deal Hub consumers.

## Discovery and compatibility

Discovery is read-only and limited to known locations:

1. `%LOCALAPPDATA%\TechnocoreAgent\local-install.json`;
2. one directory level under `%LOCALAPPDATA%\TechnocoreAgent\identities\<profile>\local-install.json`.

The manager reads the public marker and checks only whether required protected-provider files exist. It never reads `identity.dpapi` or `operator.json` contents. A marker is accepted only when it uses `technocore-local-install-v1` and contains a valid Ed25519 `did:key` in the format already enforced by the BLACKBOX airlock.

The same canonical DID found through multiple locations is returned once. Compatible provider sources are retained on that record. If exactly one DID is found, it becomes the effective primary. If several are found, an existing saved choice is used; otherwise the configured `default` profile is preferred when its DID matches. If neither applies, the user must select the primary explicitly.

Discovery never creates, rotates, decrypts, rewrites or migrates a key. A locked or unavailable signer is reported as such and never causes replacement.

## Public descriptor

The browser receives only:

```json
{
  "did": "did:key:...",
  "fingerprint": "sha256-of-public-did",
  "provider": "EXISTING_TECHNOCORE",
  "providers": ["EXISTING_TECHNOCORE"],
  "custodyMode": "LOCAL",
  "signerAvailable": true,
  "displayName": "My agent identity",
  "isPrimary": true,
  "status": "IDENTITY_READY"
}
```

Private key bytes, protected blobs, passphrases, seeds, pairing tokens, signer secrets and filesystem paths are excluded. Primary-selection and creation-action records are public metadata stored under the already ignored `blackbox/state/` tree.

## Native creation

Creation is a two-step, local-only action:

1. the authenticated connector prepares a one-time non-secret action;
2. execution requires the human-owned terminal and an exact approval phrase;
3. the canonical Windows local initializer prompts for protection credentials directly in that terminal, creates or reuses its persistent DPAPI-protected identity, and writes its public marker;
4. BLACKBOX reads only that public marker and returns the public descriptor.

The connector refuses preparation when any compatible identity already exists. It also rechecks discovery before execution. This prevents an action prepared earlier from creating a second identity after another provider has appeared. The canonical initializer is idempotent, so restarts rediscover the same DID.

“Use existing identity” performs a fresh scan of supported local providers. It is not a private-key upload and the browser has no sensitive file importer.

## Deal Hub boundary

Deal Hub consumes provider-neutral deal profiles. The primary identity is presented as “Agent A / Me.” The second local profile is used only by **LOCAL SELF-TEST**, where one operator controls both DIDs. The verified Phase 3B reference retains its original `ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS` trust statement.

Independent remote counterparties are a future provider/protocol integration. Identity Hub does not invent invitations, wallet binding, FLOP spend, reputation, points or eligibility.

## Read-only Technocore tools

`/technocore` shows the current BLACKBOX execution venue and completed local Flight Records linked to the discovered DID. It does not scrape or claim complete public history. Its signature verifier uses the existing BLACKBOX canonical message and Ed25519 `did:key` verification code. A valid result proves cryptographic key control for that message only.

The contribution capability is described as available through the compatible local provider, but V1 exposes no contribution write control. Any future contribution must preserve prepare, local review, signing, separate submit approval and public observation.

## Acceptance checklist

Existing machine (read-only until the user chooses a normal product action):

1. Start `pnpm connector` and pair BLACKBOX.
2. Open `/identity` and confirm the previously recorded exact `did:key` is detected.
3. Confirm no new identity directory or marker was created.
4. Confirm the page contains only the public descriptor.
5. Restart the connector and confirm the exact DID is unchanged.
6. Confirm the signer remains available through its existing provider.
7. Confirm Deal Hub labels the primary as Agent A / Me and keeps the second profile under LOCAL SELF-TEST.
8. Confirm the verified reference and dynamic Flight Records still open.

Isolated new-user test:

1. Point a test-only connector fixture at a temporary empty identity store.
2. Confirm `NO_IDENTITY` and that nothing is created automatically.
3. Prepare and explicitly approve one test identity creation.
4. Confirm the public DID is persistent and private fixture material is absent from the API.
5. Restart against the same temporary store and confirm the same DID is rediscovered.
6. Confirm a second creation is refused, then delete the temporary fixture.

## Reference and attribution

The capability and compatibility design was derived from the Apache-2.0 project [flop-technocore-did](https://github.com/khenzarr/flop-technocore-did), especially its canonical public marker, Windows DPAPI custody model and local initializer. BLACKBOX adapts the behavior through its existing JavaScript connector and airlock boundary; it does not copy the reference dashboard or private-key implementation.
