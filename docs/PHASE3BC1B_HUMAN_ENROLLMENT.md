# Phase 3B.C1b — Human Enrollment Runbook for an Additional Protected Identity

> **DO NOT RUN THROUGH CLINE.**
> **NO SIGNATURE WILL BE CREATED.**
> **NO NONCE WILL BE RESERVED.**
> **NO TECHNOCORE NETWORK ACTIVITY WILL OCCUR.**

Run the command in this runbook yourself, from a normal PowerShell window you opened by hand.
Cline never runs it. Phase 3B.C1a only landed and validated the entrypoint; **DID B does not exist
yet** and no command in this document was executed during that phase.

The reviewed entrypoint is `technocore-agent-profile-init`, added by canonical commit
`3675aeacdb73656285c4253b6d6d8d937afe25d6` on branch `feat/named-local-identities`. It reuses
`initialize_local_identity`, `DPAPIKeyProvider`, `TrustedPaths` and `canonical_did` unchanged — it is
a caller of the existing custody primitive, not a second custody implementation.

## What the command does and does not do

| Effect | Status |
| --- | --- |
| Creates exactly one new DPAPI-protected Ed25519 key | YES, after you type the confirmation phrase |
| Derives one new public `did:key` | YES |
| Touches DID A (`%LOCALAPPDATA%\TechnocoreAgent` files) | NO |
| Signs anything | NO — no route to `sign_room`, `sign_room_detached`, `execute_room` |
| Reserves a nonce | NO — no route to `NonceStore`; no `nonces.json` is written |
| Contacts Technocore or any network | NO — no transport object is constructed |
| Accepts a filesystem path, drive, or UNC share | NO — only a profile name |
| Accepts `--yes`, `--force`, `--non-interactive`, or an approval env var | NO — those options do not exist |
| Accepts your passphrase on the command line or in the environment | NO — prompted in-process only |
| Overwrites, regenerates or rotates an existing profile | NO — reports `ALREADY_ENROLLED` |

## Prerequisites

1. `technocore-agent-init` has already been run, so `%LOCALAPPDATA%\TechnocoreAgent\local-install.json`
   exists. The additional-identity namespace lives *beneath* the initialized default root, and the
   command refuses with `DEFAULT_IDENTITY_NOT_INITIALIZED` if that marker is missing.
2. A real interactive console. Windows Terminal or `powershell.exe` opened from the Start menu is
   fine. A VS Code task, a CI job, a redirected pipe, a background job and any agent-driven shell are
   all refused with `INTERACTIVE_TTY_REQUIRED` **before** any key is created.
3. The canonical checkout at
   `C:\Users\mertb\Desktop\NODE\technocore-agent-canonical-human-execution`, switched to branch
   `feat/named-local-identities`. That checkout is deliberately left on
   `feat/reviewed-human-detached-execution` (`124d621dd8c68b04bed79744ab332e8305093d02`) after Phase
   3B.C1a, because the Blackbox signing route pins that reviewed signer tree. Switch the branch
   yourself before enrolling, and switch back afterwards.

## The exact command

Open a normal PowerShell window and run:

```powershell
Set-Location 'C:\Users\mertb\Desktop\NODE\technocore-agent-canonical-human-execution'
git checkout feat/named-local-identities
Set-Location .\local-agent
.\.venv\Scripts\python.exe -m technocore_agent.service.profile_init --profile phase3b-counterparty-b
```

When you are done, return the checkout to the reviewed signing baseline so the Blackbox suite stays
green:

```powershell
Set-Location 'C:\Users\mertb\Desktop\NODE\technocore-agent-canonical-human-execution'
git checkout feat/reviewed-human-detached-execution
```


The installed console script `technocore-agent-profile-init --profile phase3b-counterparty-b` is
equivalent when the package is installed on `PATH`.

`--profile` is the only accepted argument. Anything else — `--state C:\anything`, `--root ...`,
`--passphrase ...`, `--yes`, a second positional value — exits with code 2 and creates nothing.

### Profile name rules

3 to 64 characters, lowercase ASCII letters, digits, `-` or `_`, starting and ending with a letter or
digit. Everything else is **refused, never normalized**: `.`, `..`, `../x`, `..\x`, `/x`, `\x`,
`C:\x`, `\\server\share`, `file://x`, `%LOCALAPPDATA%`, `$env:TEMP`, leading or trailing whitespace,
uppercase, dots, colons, non-ASCII, and the reserved names `default`, `primary`, `identity`,
`identities`, `technocoreagent`, `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`.

## Storage namespace

```
%LOCALAPPDATA%\TechnocoreAgent\identities\<profile>
```

The path is derived internally from the profile name. You never supply it. After resolution the
command proves the root is a direct child of `...\TechnocoreAgent\identities` and is not the default
root itself; a reparse point or symlink anywhere on that chain is refused
(`UNSAFE_IDENTITY_PATH`, `IDENTITY_NAMESPACE_ESCAPE`, `PROFILE_ROOT_ESCAPE`,
`DEFAULT_ROOT_COLLISION`).

## What you will see, in order

1. The review screen:

```
TECHNOCORE AGENT — ADDITIONAL PROTECTED IDENTITY

PROFILE:
phase3b-counterparty-b

STATE ROOT:
C:\Users\<you>\AppData\Local\TechnocoreAgent\identities\phase3b-counterparty-b

ACTION:
CREATE ONE NEW PROTECTED DID

SIGNING:
NONE

NONCE:
NONE

NETWORK:
NONE

TECHNOCORE:
NONE

Type exactly: CREATE IDENTITY <CODE>
Confirmation:
```

`<CODE>` is printed on screen. It is a short non-secret value derived from the profile name and the
derived root, so it changes if either changes. This runbook deliberately does not print a code:
**read it from your own screen.** It is a human safety interlock, not authentication. Anything other
than the exact phrase is refused with `WRONG_ENROLLMENT_CONFIRMATION` and no key is created.

2. Two passphrase prompts (new passphrase, then confirmation), read by the existing protected
   in-process prompt. Nothing is echoed. The credential never enters argv, the environment, a file,
   a log, JSON, Cline, or Node. Press `Ctrl+C` at any prompt to abort with nothing enrolled.

3. On success, only public results:

```
PROFILE phase3b-counterparty-b
PUBLIC DID did:key:z6Mk...
PUBLIC KEY FINGERPRINT <sha256 of the public DID>
CUSTODY ROOT C:\Users\<you>\AppData\Local\TechnocoreAgent\identities\phase3b-counterparty-b
PRIVATE_KEY Windows DPAPI protected; not exported
ENROLLED=YES
```

Re-running the same profile prints the same public DID with `ENROLLED=ALREADY_ENROLLED` and touches
nothing on disk.

## After you run it

Report back **only** the public `PUBLIC DID` and `PUBLIC KEY FINGERPRINT` lines. Never paste the
passphrase, the contents of `identity.dpapi`, or any private key material anywhere — including to
Cline.

Nothing about this command binds DID B to a role, a deal, a signature or a payment. Two DIDs on this
machine remain **one human operator**: not two humans, not two organizations, not two economic
counterparties, and not FLOP eligibility. See `docs/PHASE3B_COUNTERPARTY_IDENTITY.md`.
