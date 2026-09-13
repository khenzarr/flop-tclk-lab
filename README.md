# TCLK BLACKBOX

**The flight recorder for agent deals.**

Run a signed TCLK deal through a local custody boundary, check what actually becomes public, and keep a verifiable Flight Record. BLACKBOX keeps these states distinct:

> **SIGNED ≠ SUBMITTED ≠ ACK_RECEIVED ≠ OBSERVED_PUBLIC ≠ COMPLETE**

[![CI](https://github.com/khenzarr/flop-tclk-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/khenzarr/flop-tclk-lab/actions/workflows/ci.yml) [![Apache-2.0](https://img.shields.io/github/license/khenzarr/flop-tclk-lab?label=License)](LICENSE) [![Live App](https://img.shields.io/badge/Live%20App-Open-90d892)](https://tclk-blackbox.vercel.app)

[Live app](https://tclk-blackbox.vercel.app) · [Beginner guide](docs/GETTING_STARTED.md) · [Verified historical reference](https://tclk-blackbox.vercel.app/deal/phase3b-final) · [Repository](https://github.com/khenzarr/flop-tclk-lab)

## What BLACKBOX does

A successful HTTP response is not proof that a signed action appeared in a public room. BLACKBOX separates local signing, one-shot submission, venue acknowledgement, exact public observation, and completion. Its Deal Hub lets an operator review each step, inspect uncertain outcomes, and preserve the resulting public-safe evidence trail.

The current actionable deal mode is **Local Self-Test**: one human operator controls two distinct local cryptographic DIDs. This checks the execution and evidence pipeline; it does **not** establish two independent human counterparties or economic settlement. You can inspect the [completed Phase 3B reference](https://tclk-blackbox.vercel.app/deal/phase3b-final) without starting a deal. That route is a historical public reference, not a live current deal.

## Quick Start (Windows / PowerShell)

You need Git, Node.js 24, pnpm 11, PowerShell 7 (`pwsh`), and **an existing compatible Technocore DID**. A real Local Self-Test needs two distinct compatible local DID profiles controlled by the same operator. If you do not have a DID yet, follow [Technocore DID setup](https://github.com/khenzarr/flop-technocore-did), then return here. BLACKBOX does not create or import private keys.

1. Open **PowerShell**. Clone the repository and enter it:

   ```powershell
   git clone https://github.com/khenzarr/flop-tclk-lab.git
   cd flop-tclk-lab
   ```

2. Install this repo's dependencies and its pinned TCLK upstream build:

   ```powershell
   pnpm install --frozen-lockfile
   pwsh -NoProfile -File scripts/bootstrap-upstream.ps1
   ```

   The bootstrap clones the exact commit pinned by `evidence/upstream-baseline.json` into ignored `.upstream/tclk/` and runs its own verification gates. Do not commit that directory.

3. In the same terminal, start the **Local Connector** and leave it open:

   ```powershell
   pnpm connector
   ```

   Expect `BLACKBOX connector ready on http://127.0.0.1:8787` and a `Pairing file:` path. The connector also reports its mode and expiry. Local signing approvals appear in this terminal later.

4. Open the [live BLACKBOX app](https://tclk-blackbox.vercel.app). Under **Connect local BLACKBOX**, choose the JSON file at the printed pairing path. This file authorizes this browser to talk to the connector on your computer. **It is not your DID, private key, seed, mnemonic, signer export, or custody backup.** Treat its token as local authorization material; never post it or paste private material into the website. The status should change from **Connector found · pairing required** to **Connected locally**.

5. Open **Identity**. The existing DID should appear as your **Primary Identity** with provider, local custody, and signer status. For signed actions, confirm **Identity Ready / Signer Ready**. If no compatible identity is detected, use **How to create a Technocore DID** and then **Rescan local identities**. If the signer is locked or unavailable, resolve that in the existing local provider; BLACKBOX will not replace the DID.

6. From **Deal Hub**, choose **Start a local self-test**. The form is explicitly labeled **Local Self-Test**; select two distinct local profiles. Creating a session does not sign, submit, allocate a real nonce, or write PaperRail. For each subsequent action, review it in the browser, then approve the exact phrase shown by the local terminal. Signing and submitting have separate approvals. Use **Refresh public evidence** to look for the exact record. Do not infer success from `SIGNED` or `ACK_RECEIVED`.

7. When all six evidence gates are verified, finalize the record and choose **Open Flight Record**. The **Records** page lists local sessions while paired and always links the historical reference. The completed Flight Record is read-only and has a public-safe evidence export. Review any exported artifact before sharing it.

For screenshots-free troubleshooting and the optional clearly labeled simulated mode, use the [beginner guide](docs/GETTING_STARTED.md). The guide does not ask you to run a live deal just to inspect the product.

## Deal and evidence lifecycle

`OFFER → ACCEPT → LOCK → RAIL LOCK → REVEAL → RAIL CLAIM`

Venue actions track signing, submission, acknowledgement, and exact retained public observation separately. The two PaperRail stages require both a successful local write receipt and a later exact public-value match. An ambiguous network result remains uncertain; BLACKBOX does not automatically retry a one-shot write. A Flight Record keeps the signed operation identity, state progression, public observations, verification results, and applicable recovery/rail evidence in a public-safe projection. A reference record is available at [`/deal/phase3b-final`](https://tclk-blackbox.vercel.app/deal/phase3b-final); its six verified steps are historical evidence, not a promise about a new run.

## Architecture and trust

```text
BLACKBOX Web (Vercel / browser; public-safe UI)
             │ pairing-authenticated localhost request
             ▼
Local Connector (127.0.0.1; approval and custody boundary)
             │ uses an existing local Technocore DID / signer
             ▼
Signed TCLK action → Technocore venue → exact public observation
                                           │
                                           ▼
                              BLACKBOX Flight Record
```

The production server does not hold your private key. The browser uses a short-lived pairing file to reach the loopback-only connector; private signing material stays with the existing local provider. The pairing token is authorization to the connector, **not** a signing credential, and should still be protected. See [architecture](docs/BLACKBOX_ARCHITECTURE.md), [identity boundary](docs/IDENTITY_HUB.md), and [security policy](SECURITY.md).

A valid signature proves control of the corresponding cryptographic key for the signed message. It does **not** prove a human identity, wallet ownership, independent counterparties, reputation, economic value, FLOP ownership, reward eligibility, or successful settlement. Public observation proves only the exact content observed at the stated venue; it does not upgrade those other claims.

**PaperRail is unsigned, world-writable, and non-value-bearing.** It is not a payment rail or proof of payment; the current BLACKBOX evidence model records `valueMoved=false` for its operations. A public rail value plus a local receipt is evidence of those specific observations, not a transfer of funds.

## Current release

**Available now:** production web UI, localhost connector and pairing, existing-DID discovery/reuse and primary selection, local signer boundary, Deal Hub Local Self-Test, read-only Technocore view, exact public observation, dynamic Flight Records, public-safe export, the verified Phase 3B reference, and an explicit simulated local test mode.

**Not available yet:** BLACKBOX DID creation, private-key import, browser/hosted signing, independent remote counterparties, FLOP testnet transfers or balances, reward/airdrop tracking, and stress orchestration. The asset label in a self-test is deal metadata, not evidence of token movement.

## Development

After the Quick Start install/bootstrap steps, `pnpm dev` serves the web build at `http://127.0.0.1:4173/`. Use `pnpm connector:simulated` only when you want a visibly labeled local fixture run without live signatures, nonces, POSTs, or PaperRail writes; do not present its record as live public evidence.

```powershell
pnpm test
pnpm web:test
pnpm lint
pnpm typecheck
pnpm build
```

The pinned upstream build is required for some checks; the bootstrap above is the canonical setup. Implementation and operator details live in [Deal Hub V1](docs/DEAL_HUB_V1.md), [Identity Hub](docs/IDENTITY_HUB.md), and [Flight Record evidence](docs/BLACKBOX_EVIDENCE.md). Historical execution scripts are not beginner onboarding commands.

## Upstream and license

TCLK BLACKBOX is an **independent external project**, not an official FLOP Labs product. It builds against [TCLK](https://github.com/flop-labs/tclk) and [Technocore Chat](https://github.com/flop-labs/technocore-chat); those links do not imply endorsement. See [NOTICE](NOTICE) for attribution, [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community conduct, and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Licensed under [Apache-2.0](LICENSE).
