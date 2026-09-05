"""Phase 3B.C1 — custody multi-identity isolation probe (fixture storage only).

Proves, using the EXACT reviewed canonical custody primitives and real Windows
DPAPI, that two distinct state roots yield two independent protected identities.

Safety envelope:
  * Operates only inside a throwaway temp directory. Never touches the real
    %LOCALAPPDATA%\\TechnocoreAgent* roots.
  * Creates disposable fixture keys. No operator passphrase, no enrollment.
  * Prints public DIDs and ciphertext digests only. Never prints, returns or
    persists private-key bytes, seeds or DPAPI plaintext.
  * No signing. No nonce reservation. No transport. No network. No submission.

Run:
  cd <canonical>/local-agent
  set PYTHONPATH=src
  .venv\\Scripts\\python.exe <blackbox>/lab/custody-isolation-probe.py
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path

from technocore_agent.service.runtime import DPAPIKeyProvider, TrustedPaths
from technocore_agent.signer.service import canonical_did


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _enrol(root: Path) -> tuple[str, TrustedPaths]:
    paths = TrustedPaths.under(root)
    root.mkdir(parents=True, exist_ok=True)
    key = DPAPIKeyProvider(paths.protected_key).load_or_create()
    try:
        return canonical_did(key), paths
    finally:
        del key


def main() -> None:
    sandbox = Path(tempfile.mkdtemp(prefix="phase3bc1-isolation-"))
    try:
        did_one, paths_one = _enrol(sandbox / "fixtureOne")
        did_two, paths_two = _enrol(sandbox / "fixtureTwo")

        blob_one = _digest(paths_one.protected_key)
        blob_two = _digest(paths_two.protected_key)

        # Re-open the first identity: an existing blob must load, never rewrite.
        reopened, _ = _enrol(sandbox / "fixtureOne")
        blob_one_after = _digest(paths_one.protected_key)

        # No path may be shared between the two identity namespaces.
        fields = ("drafts", "approvals", "operations", "nonces", "evidence", "operator", "protected_key")
        overlap = sorted(
            name
            for name in fields
            if getattr(paths_one, name) == getattr(paths_two, name)
        )

        report = {
            "probe": "phase3bc1-custody-isolation",
            "fixtureOneDid": did_one,
            "fixtureTwoDid": did_two,
            "distinctDid": did_one != did_two,
            "distinctProtectedBlob": blob_one != blob_two,
            "reopenPreservesDid": reopened == did_one,
            "reopenPreservesBlobBytes": blob_one == blob_one_after,
            "overlappingPaths": overlap,
            "namespaceIsolated": overlap == [],
            "nonceLedgerCreated": paths_one.nonces.exists() or paths_two.nonces.exists(),
            "operatorEnrolled": paths_one.operator.exists() or paths_two.operator.exists(),
            "privateKeyExported": False,
            "signaturesPerformed": 0,
            "noncesConsumed": 0,
        }
        checks = (
            report["distinctDid"]
            and report["distinctProtectedBlob"]
            and report["reopenPreservesDid"]
            and report["reopenPreservesBlobBytes"]
            and report["namespaceIsolated"]
            and not report["nonceLedgerCreated"]
            and not report["operatorEnrolled"]
        )
        report["result"] = "PASS" if checks else "FAIL"
        print(json.dumps(report, indent=2, sort_keys=True))
        if not checks:
            raise SystemExit(1)
    finally:
        shutil.rmtree(sandbox, ignore_errors=True)
        print(f"SANDBOX_REMOVED {not sandbox.exists()}")


if __name__ == "__main__":
    main()
