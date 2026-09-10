# TCLK BLACKBOX

**The flight recorder for agent deals.**

[![GitHub Stars](https://img.shields.io/github/stars/khenzarr/flop-tclk-lab?style=flat-square&label=Stars)](https://github.com/khenzarr/flop-tclk-lab/stargazers)
[![License: Apache-2.0](https://img.shields.io/github/license/khenzarr/flop-tclk-lab?style=flat-square&label=License)](LICENSE)
[![CI](https://github.com/khenzarr/flop-tclk-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/khenzarr/flop-tclk-lab/actions/workflows/ci.yml)
[![Live App](https://img.shields.io/badge/Live_App-Open-90d892?style=flat-square)](https://tclk-blackbox.vercel.app)
[![Last Commit](https://img.shields.io/github/last-commit/khenzarr/flop-tclk-lab?style=flat-square&label=Last%20commit)](https://github.com/khenzarr/flop-tclk-lab/commits/main)

Two agents made a deal. BLACKBOX shows what actually happened.

BLACKBOX records each important stage instead of collapsing the entire deal into one “success” state:

> **SIGNED ≠ SUBMITTED ≠ ACKNOWLEDGED ≠ OBSERVED ≠ COMPLETE**

An action being signed does not mean it was sent. Being sent does not mean it was accepted or publicly observed. BLACKBOX keeps those states separate, records failures, and completes a deal only when its required evidence is present.

[Open the live app](https://tclk-blackbox.vercel.app) · [Verified reference](https://tclk-blackbox.vercel.app/deal/phase3b-final) · [Developer on X](https://x.com/cryptokhenzar) · [GitHub](https://github.com/khenzarr) · [Repository](https://github.com/khenzarr/flop-tclk-lab)

Built by [@cryptokhenzar](https://x.com/cryptokhenzar)

**[Live App](https://tclk-blackbox.vercel.app) · [Quick Start](#quick-start--no-prior-blackbox-knowledge-required) · [How it Works](#how-it-works) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)**

## Contents

- [What is TCLK BLACKBOX?](#what-is-tclk-blackbox)
- [What can I do with BLACKBOX?](#what-can-i-do-with-blackbox)
- [The six-step deal lifecycle](#the-six-step-deal-lifecycle)
- [Quick Start](#quick-start--no-prior-blackbox-knowledge-required)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Security model](#security-model)
- [V1 limitations](#v1-limitations)
- [FLOP testnet roadmap](#flop-testnet-roadmap)
- [Current status](#current-status)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What is TCLK BLACKBOX?

TCLK BLACKBOX is like an aircraft flight recorder for agent deals. It preserves the sequence of actions and the evidence needed to understand the outcome later.

A normal integration may treat `HTTP 200` as success. BLACKBOX asks more useful questions:

- Was the action prepared?
- Was it signed?
- Was it submitted?
- Did the server acknowledge it?
- Did the expected public record actually appear?
- Is all required evidence present?

Failures and uncertain results stay in the record too. An acknowledgement is useful evidence, but it is not substituted for a required public observation.

## What can I do with BLACKBOX?

### Deal Hub

The Deal Hub is the operator’s working surface. You can:

- connect a local BLACKBOX agent and signer;
- create an isolated deal;
- choose the two local cryptographic profiles used by V1;
- review irreversible actions before they happen;
- approve signing and submission separately in the local terminal;
- watch evidence appear step by step;
- recover safely from an ambiguous failure when the recorded state permits it;
- complete the deal and generate its Flight Record.

### Flight Record

The Flight Record is read-only playback of a completed deal. You can:

- replay all six events;
- inspect public evidence, timestamps, sequence numbers, and hashes;
- inspect PaperRail receipts and exact public observations;
- export a public-safe evidence capsule.

The app also includes a [verified reference record](https://tclk-blackbox.vercel.app/deal/phase3b-final), so the completed experience can be inspected without starting a deal.

## The six-step deal lifecycle

1. **OFFER** — Agent A publishes the proposed deal terms. BLACKBOX waits for the exact expected public record.
2. **ACCEPT** — Agent B accepts those terms with its own cryptographic DID. The acceptance is tracked independently from the offer.
3. **LOCK** — Agent A publishes the protocol lock needed for the agreed exchange. Signed, submitted, acknowledged, and observed remain separate states.
4. **RAIL LOCK** — BLACKBOX writes the expected lock commitment to PaperRail, preserves the local receipt, then checks for the exact public value.
5. **REVEAL** — Agent B publishes the reveal required by the deal. BLACKBOX verifies the expected public observation before progressing.
6. **RAIL CLAIM** — BLACKBOX writes the claim-state commitment to PaperRail, preserves the receipt, and verifies the exact public value.

RAIL LOCK and RAIL CLAIM use PaperRail evidence. PaperRail is **unsigned**, **world-writable**, and **not a payment rail**. It is not proof of wallet ownership, human identity, or economic settlement. A rail operation completes only after both a successful local write receipt and a later exact public observation are present.

## How does BLACKBOX contribute to Technocore?

Technocore provides the underlying public communication and storage primitives. BLACKBOX builds an independent end-user workflow and real multi-step workload on top of that stack.

BLACKBOX contributes by:

- turning protocol primitives into a usable deal workflow;
- creating real multi-step agent workloads;
- verifying public observations instead of trusting acknowledgements;
- preserving failure and recovery history;
- exercising Technocore behavior under real product conditions;
- producing evidence that helps debug infrastructure behavior when it differs from expectations.

BLACKBOX is an independent project; this repository does not claim it is part of the official Technocore project. BLACKBOX V1 currently uses the working Technocore venue at `https://technocore-chat-production.up.railway.app`.

## Quick Start — no prior BLACKBOX knowledge required

These steps assume Windows 11 and PowerShell. Keep commands in their own terminal windows where noted.

### 1. Install prerequisites

Install [Git](https://git-scm.com/download/win), [Node.js](https://nodejs.org/), and pnpm. Check what is already installed:

```powershell
git --version
node --version
pnpm --version
```

If pnpm is missing after Node.js is installed:

```powershell
npm install --global pnpm
```

### 2. Download BLACKBOX

Git is preferred because it makes future updates straightforward:

```powershell
git clone https://github.com/khenzarr/flop-tclk-lab.git
cd flop-tclk-lab
```

If you are uncomfortable with Git, GitHub’s **Code → Download ZIP** option also works. Extract the ZIP and open PowerShell inside the extracted folder.

### 3. Install dependencies

```powershell
pnpm install
```

### 4. Start the local connector

```powershell
pnpm connector
```

Keep this terminal open. The connector listens only on `127.0.0.1:8787`, generates a short-lived pairing JSON file, and prints that file’s path. Never paste the pairing token publicly. Private keys remain local.

### 5. Open BLACKBOX

Open [https://tclk-blackbox.vercel.app](https://tclk-blackbox.vercel.app). The expected initial status is:

```text
CONNECTOR FOUND • PAIRING REQUIRED
```

The browser talks to the connector on your own computer; the Vercel server does not connect to it. If your browser asks for local-network access, allow it for BLACKBOX if you want to use the local connector.

### 6. Import the pairing file

Click **Import Pairing File** and choose the JSON file whose path was printed by the connector. Do not manually copy the token. A successful connection displays:

```text
CONNECTED LOCALLY • LOCAL REAL EXECUTION
```

### 7. Start a deal

Click **START A DEAL**.

V1 uses **ONE HUMAN OPERATOR** and **TWO DISTINCT CRYPTOGRAPHIC DIDs**. Agent A and Agent B are separate cryptographic profiles controlled by the same person, not two independent people.

### 8. Define the deal

Enter the amount and asset label. Current examples may use `TCLK`, but that label is deal metadata and a pre-testnet placeholder. It does not prove that a real TCLK or FLOP token transfer occurred. PaperRail activity does not move token value.

### 9. Create the isolated deal session

Click **Create isolated deal session**. This creates local session and commitment material. It does not immediately sign, submit, consume every action, or run the deal automatically.

### 10. Review and approve each action

For a signed operation, the browser guides you through two separate decisions:

```text
REVIEW LOCAL SIGNATURE
→ OPEN TERMINAL APPROVAL
→ SIGNED
→ REVIEW SUBMIT
```

The terminal prints the exact approval phrase to type. Submission requires its own phrase beginning with `SUBMIT ONCE ...`. BLACKBOX intentionally separates signing from submitting and never treats a signature as permission to post.

PaperRail writes have a separate terminal approval beginning with `PAPERRAIL WRITE ONCE ...`.

### 11. Refresh public evidence

`ACK_RECEIVED` is not complete. Use **Refresh public evidence** so BLACKBOX can look for the exact expected public record. The operation progresses to `VERIFIED` only when its required evidence is found.

### 12. Complete all six steps

Continue through OFFER, ACCEPT, LOCK, RAIL LOCK, REVEAL, and RAIL CLAIM. The final state is:

```text
FLIGHT RECORD COMPLETE
6 actions recorded
6 actions verified
0 unresolved
```

### 13. Open the Flight Record

Click **OPEN FLIGHT RECORD**. The resulting event playback is read-only; it cannot sign, submit, allocate a nonce, or write PaperRail.

### 14. Export evidence

Use **OPEN EVIDENCE** to inspect the public projection and **EXPORT PUBLIC CAPSULE** to download it. The capsule is designed to be shareable: it excludes private keys, seeds, passphrases, raw preimages, pairing tokens, and other custody secrets. Review any artifact before publishing it.

## How it works

```text
Browser / Vercel
      │
      │ safe action request
      ▼
Local BLACKBOX Connector
      │
      │ explicit human approval
      ▼
Local signer / agent
      │
      ▼
Technocore venue
      │
      ▼
Public observation
      │
      ▼
BLACKBOX Flight Record
```

**PRIVATE KEYS NEVER GO TO VERCEL.**

The production web app runs at `https://tclk-blackbox.vercel.app`, while the browser connects to `http://127.0.0.1:8787` on the same computer. Different users and public IP addresses do not change this: `127.0.0.1` always means the current user’s own machine.

## Troubleshooting

### CONNECTOR OFFLINE

Run:

```powershell
pnpm connector
```

Confirm the terminal says:

```text
BLACKBOX connector ready on http://127.0.0.1:8787
```

If the browser requests permission to access the local network, allow it for BLACKBOX. Do not disable browser security globally.

### CONNECTOR FOUND • PAIRING REQUIRED

This is healthy. Import the newly generated pairing JSON file whose path appears in the connector terminal.

### Pairing expired

Restart the connector and import the new file:

```powershell
pnpm connector
```

### Port 8787 already in use

Inspect the listener in PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen
```

Note its `OwningProcess` value, then inspect that exact process before deciding what to do:

```powershell
Get-Process -Id 1234
```

Replace `1234` with the process ID you observed. Do not stop an unknown process blindly.

### Production site cannot reach the connector

The production origin `https://tclk-blackbox.vercel.app` is allowed by default. Origin matching is exact: wildcard sites and arbitrary Vercel preview deployments are refused.

For a custom deployment, set only its exact origin before starting the connector:

```powershell
$env:BLACKBOX_WEB_ORIGIN = 'https://blackbox.example.com'
pnpm connector
```

To allow multiple exact origins, separate them with commas. Never use `*`. If BLACKBOX moves to a custom domain, add that exact origin to the connector allowlist.

### Browser refuses the local connection

Your browser may require explicit local-network access permission for a secure website to contact `127.0.0.1`. Allow the permission for BLACKBOX if desired. Do not weaken global browser security or expose the connector on a public network interface.

## Security model

- The web app provides orchestration and visualization; sensitive custody stays local.
- The connector binds to loopback (`127.0.0.1`) only.
- Approved browser origins are matched exactly. No wildcard origin is trusted.
- The pairing token is short-lived, stored in session storage by the browser, and never printed by the connector.
- Privileged connector endpoints require authentication.
- Irreversible actions require explicit terminal approval.
- Signing and submitting are separate approvals.
- Submission has a one-shot budget and no automatic POST retry.
- An ambiguous network result becomes `SUBMISSION_UNCERTAIN`; an explicit 4xx becomes `REJECTED`.
- Exact public observation is required wherever the operation definition calls for it.
- The public capsule excludes custody secrets.

BLACKBOX proves only the recorded sequence and the evidence stated in its capsule. It does not infer facts that the evidence cannot establish.

## V1 limitations

- V1 uses one human operator controlling two distinct cryptographic DIDs.
- It is not yet an independent remote-counterparty product.
- PaperRail is unsigned and world-writable; it is not payment or economic settlement.
- BLACKBOX does not prove human identity or wallet ownership.
- BLACKBOX does not prove reputation or FLOP eligibility.
- No workflow or record guarantees airdrop qualification.

## FLOP testnet roadmap

FLOP-specific logic is **not implemented yet**. When official FLOP testnet mechanics are available, BLACKBOX is designed to support a future high-throughput Testnet / Stress Mode:

```text
Multi-deal orchestrator
        ↓
many isolated real deal sessions
        ↓
official FLOP-consuming actions
        ↓
spend / throughput / failure telemetry
        ↓
Flight Record evidence at scale
```

The current `TCLK` asset label is not real FLOP spend, and PaperRail must never be counted as FLOP spend. A future implementation must use official chain, token, contract, and wallet configuration; real consumption must come from the official FLOP-consuming primitive. BLACKBOX will not invent spend counters or promise airdrop qualification while those specifications are unavailable.

## Current status

| Surface | Status |
| --- | --- |
| Production | Live |
| Deal Hub V1 | Available |
| Verified reference record | Available |
| Local connector | Available |
| FLOP testnet integration | Roadmap |

Completed and available today:

- BLACKBOX execution and evidence engine;
- local signing and custody boundary;
- Deal Hub V1 and the production web app;
- a real Hub-created deal acceptance test;
- six-step deal completion;
- dynamic, read-only Flight Records;
- public-safe capsule export.

Inspect the [verified six-step reference](https://tclk-blackbox.vercel.app/deal/phase3b-final).

## Development

```powershell
pnpm dev
pnpm connector
pnpm connector:simulated
pnpm web:test
pnpm lint
pnpm typecheck
pnpm build
```

`pnpm connector:simulated` exercises the labeled local test path. It does not create real signatures, allocate real nonces, POST live operations, or write PaperRail. Historical Phase 3B commands remain implementation tools rather than beginner onboarding commands.

### Project structure

```text
blackbox/  Execution, evidence, connector, and custody-boundary logic
web/       Deal Hub and Flight Record interface
evidence/  Versioned evidence and public-safe capsules
docs/      Security, protocol, compatibility, and operational notes
schemas/   Machine-readable artifact contracts
```

## Contributing

Focused fixes, tests, documentation, UI improvements, connector hardening, and evidence-model contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Do not report exploitable vulnerabilities or active credentials in a public issue. Follow the private-reporting guidance in [SECURITY.md](SECURITY.md).

## License

TCLK BLACKBOX is licensed under the [Apache License 2.0](LICENSE).

TCLK and Technocore Chat are upstream FLOP Labs projects licensed under Apache-2.0. Their attribution is preserved in [NOTICE](NOTICE). This identifies upstream work and does not imply ownership, endorsement, or official FLOP Labs status.

## Product principle

**START THE DEAL · WATCH IT HAPPEN · VERIFY EVERY STEP · KEEP THE PROOF**

TCLK BLACKBOX is the flight recorder for agent deals.
