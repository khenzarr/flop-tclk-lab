# Getting started with TCLK BLACKBOX

BLACKBOX is a flight recorder for agent deals: it separates a locally signed action from submission, acknowledgement, exact public observation, and a completed Flight Record. The [production app](https://tclk-blackbox.vercel.app) is the browser interface; your local connector is the approval and signing boundary. The production server does not hold your private key.

The current runnable deal mode is **Local Self-Test**. One human operator controls two distinct local cryptographic DIDs. It verifies the workflow and evidence pipeline, **not** participation by two independent people or transfer of economic value. You can inspect the [historical verified reference](https://tclk-blackbox.vercel.app/deal/phase3b-final) without running anything locally.

## Before you begin

- Use Windows PowerShell with Git, Node.js 24, pnpm 11, and PowerShell 7 (`pwsh`) available.
- Have an **existing compatible Technocore DID** and local signer. A real Local Self-Test needs two distinct compatible local DID profiles. If you have none, follow [Technocore DID setup](https://github.com/khenzarr/flop-technocore-did) first. BLACKBOX cannot generate a DID and does not accept a private-key upload.
- Keep signing keys, seeds, mnemonics, passphrases, and protected DPAPI files on your computer. Never paste them into the web app.

## Connect the app to your computer

1. Open **PowerShell** and get the repository:

   ```powershell
   git clone https://github.com/khenzarr/flop-tclk-lab.git
   cd flop-tclk-lab
   ```

2. Install dependencies and build the pinned upstream TCLK runtime:

   ```powershell
   pnpm install --frozen-lockfile
   pwsh -NoProfile -File scripts/bootstrap-upstream.ps1
   ```

   Expect the bootstrap to finish with `Pinned TCLK workspace verified at ...`. It may take time on a fresh checkout because it runs upstream's own gates. `.upstream/tclk/` is ignored; do not commit generated files from it.

3. In that PowerShell window, run:

   ```powershell
   pnpm connector
   ```

   Leave the window open. Expect `BLACKBOX connector ready on http://127.0.0.1:8787`, `Mode: LOCAL REAL EXECUTION`, and a `Pairing file:` path. This command creates a local pairing file. It does not create a DID or sign a deal merely by starting.

4. Open [tclk-blackbox.vercel.app](https://tclk-blackbox.vercel.app) in a browser on **the same computer**. The page should show **Connector found · pairing required**. In **Connect local BLACKBOX**, choose the JSON file at the `Pairing file:` path. The status should become **Connected locally**.

   The pairing file authorizes this browser to speak to the connector at `127.0.0.1`; it is **not** your DID, private key, seed, mnemonic, signer export, or custody backup. Its token is still sensitive local authorization material: do not publish it. The browser keeps it in tab-session storage and **Forget pairing** removes it.

5. Open **Identity**. Your public `did:key:...` should appear under **Primary Identity**, with provider, local custody, and signer status. **Identity Ready** and **Signer Ready** mean the existing local provider is available for signed actions. If several DIDs exist, select the intended primary one explicitly. BLACKBOX does not rotate or replace it.

## First run: Local Self-Test

1. In **Deal Hub**, select **Start a local self-test**. The form is marked **Local Self-Test**. Select two different existing local profiles. If only one compatible DID is available, stop here; independent remote counterparties are not implemented and BLACKBOX should not invent a second identity.
2. Enter the deal amount and asset label, then select **Create isolated self-test session**. This creates local session/commitment material only: no signature, nonce, venue POST, or PaperRail write yet. The asset label is metadata, not a token balance or transfer.
3. On the live deal page, review each next operation. The browser prepares a local action; the **connector terminal** displays the exact phrase for explicit approval. Signing and submitting are separate decisions. A PaperRail write has its own approval. Do not type an approval phrase unless you intend that action.
4. After an action, select **Refresh public evidence**. `SIGNED` does not mean submitted; `ACK_RECEIVED` does not mean observed. An uncertain result is not automatically retried. BLACKBOX advances only when the required exact evidence is available.
5. After all six steps have verified, select **Finalize public record** and **Open Flight Record**. Its playback is read-only. **Records** lists local sessions while paired and always offers the historical reference. The public-safe export records the available operation and observation evidence; inspect it before sharing.

If you only want to explore without live signatures, nonces, POSTs, or PaperRail writes, stop the real connector and run `pnpm connector:simulated` instead. The UI labels that path **SIMULATED / LOCAL TEST**. A simulated record is not live public evidence.

## If something does not connect

| What you see | What to check |
| --- | --- |
| **Connector offline / not found** | Confirm `pnpm connector` is still running on this computer and printed `127.0.0.1:8787`. Allow the browser's local-network permission for BLACKBOX if prompted. Do not expose the connector on a public interface. |
| **Pairing required** | Import the new JSON file whose path the current connector printed. If it expired, restart the connector and import its newly created file. Do not paste the token into a form or chat. |
| **No compatible identity** | Follow [Technocore DID setup](https://github.com/khenzarr/flop-technocore-did), then return to **Identity** and select **Rescan local identities**. No identity is created by the rescan. |
| **Identity locked / signer unavailable** | The public DID may exist while its local signer cannot sign. Resolve availability in the existing local provider; BLACKBOX will not import or replace key material. |
| **Production site cannot reach localhost** | Use the same computer for browser and connector; verify the terminal is open, the production origin is permitted, and the browser's local-network permission is allowed. The default connector allowlist includes `https://tclk-blackbox.vercel.app` exactly, not arbitrary preview domains. |

For operator-level recovery and evidence semantics, see [Deal Hub V1](DEAL_HUB_V1.md). For identity compatibility and custody details, see [Identity Hub](IDENTITY_HUB.md). For the trust boundary, see [architecture](BLACKBOX_ARCHITECTURE.md) and [security boundaries](SECURITY_BOUNDARIES.md).
