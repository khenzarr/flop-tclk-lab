// SPDX-License-Identifier: Apache-2.0
//
// Resolve the pinned upstream RUNTIME — the single door to the protocol.
//
// This lab never reimplements protocol logic. Every primitive exercised here is imported from
// `.upstream/tclk/dist`, produced by upstream's own build at the pinned commit.
//
// Phase 3B.1 promoted a `dist/` from the wrong commit and nothing noticed, because "the clone is
// on the right SHA" says nothing about the compiled bytes beside it. Phase 3B.1-R then proved the
// replacement `dist/` was a reproducible build of the pin — and it still could not load, because
// `dist/transcript.js` imports `@scure/base` and no production dependency closure had been
// promoted. Two different holes, both invisible to a commit check.
//
// So this module no longer asks "is the clone on the pinned commit?". It requires ALL of:
//
//   SOURCE_SHA               the checkout is on the reviewed commit
//   LOCKFILE_SHA             the dependency resolution is the reviewed one
//   DIST_TREE_SHA            the compiled bytes are the reviewed artifact
//   PROD_CLOSURE_SHA         the packages Node will resolve are the reviewed packages
//   RUNTIME_ENTRYPOINT_EXISTS
//
// and only then imports, and only then checks the imported surface really is the protocol. Any
// failure exits non-zero before a consumer receives a module. Nothing here installs, builds or
// fetches: a loader that repairs its own gate is not a gate.

import { existsSync, readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";

import { cloneHead, loadAttestedRuntime } from "./runtime-attest.mjs";


const ROOT = new URL("../", import.meta.url);
const CLONE = new URL(".upstream/tclk/", ROOT);
const DIST = new URL("dist/index.js", CLONE);
const BASELINE = new URL("evidence/upstream-baseline.json", ROOT);

function die(message, hint) {
  console.error(`lab: ${message}`);
  if (hint) console.error(`lab: ${hint}`);
  process.exit(1);
}

if (!existsSync(fileURLToPath(BASELINE))) {
  die("evidence/upstream-baseline.json is missing", "run scripts/verify-upstream.ps1 first");
}

const pinned = JSON.parse(readFileSync(fileURLToPath(BASELINE), "utf8"));

// Deliberate, fail-closed comparison override. Phase 3A-2 has to replay the same fixtures
// against a DIFFERENT upstream commit to tell drift from regression, and it must do that
// through the real replay code rather than a second implementation of it. Both variables are
// required together, the named clone's HEAD must equal the SHA the caller asserts, and the
// resolved commit is what every downstream artifact reports — so an override can never be
// mistaken for the pin. Unset, nothing changes.
// An empty value counts as unset: a child process cannot delete an inherited variable, only
// blank it, and "" must not be read as "override to the repository root".
const unset = (value) => (value === undefined || value.trim() === "" ? null : value.trim());
const overrideDir = unset(process.env.FLOPLAB_UPSTREAM_DIR);
const overrideSha = unset(process.env.FLOPLAB_UPSTREAM_SHA);

if ((overrideDir === null) !== (overrideSha === null)) {
  die(
    "FLOPLAB_UPSTREAM_DIR and FLOPLAB_UPSTREAM_SHA must be set together",
    "an override without an asserted SHA is exactly the silent drift this guard exists to prevent",
  );
}

const CLONE_IN_USE = overrideDir === null ? CLONE : new URL(`${overrideDir}/`, ROOT);
const DIST_IN_USE = overrideDir === null ? DIST : new URL("dist/index.js", CLONE_IN_USE);

if (!existsSync(fileURLToPath(DIST_IN_USE))) {
  die(
    `the upstream build is missing (${fileURLToPath(DIST_IN_USE)})`,
    "run scripts/bootstrap-upstream.ps1 — it clones the pinned commit and runs upstream's own gates",
  );
}


// The single implementation of "which commit is this clone on" lives in runtime-attest.mjs, so the
// gate and the loader can never disagree about it.
export const head = cloneHead(fileURLToPath(CLONE_IN_USE));


const expected = overrideSha ?? pinned.commit;
if (head !== expected) {
  die(
    `the upstream clone is at ${head} but ${overrideSha ? "the asserted comparison SHA" : "the pinned baseline"} is ${expected}`,
    "re-pin deliberately (scripts/verify-upstream.ps1) instead of rehearsing against an unrecorded commit",
  );
}

/**
 * What every downstream artifact reports as its upstream provenance.
 *
 * Under an override this is NOT the pin: the commit is the asserted comparison SHA, the
 * version is read from that clone, and `comparisonOverride` marks the artifact so no capsule,
 * evidence file, or Airlock envelope can pass a comparison run off as a pinned run.
 */
export const baseline = overrideSha === null
  ? pinned
  : {
      ...pinned,
      commit: head,
      packageVersion: JSON.parse(
        readFileSync(fileURLToPath(new URL("package.json", CLONE_IN_USE)), "utf8"),
      ).version,
      comparisonOverride: true,
      pinnedCommit: pinned.commit,
    };

/**
 * The reviewed runtime identity, and the gate that must pass before any import.
 *
 * Under a comparison override the reviewed identity by definition does NOT apply — the whole point
 * is to execute a different commit — so the static identity gate is skipped and the result is
 * labelled `COMPARISON_OVERRIDE`, never `PASS`. The asserted-SHA check above still holds, the
 * artifact is still marked `comparisonOverride`, and no override path can report itself attested.
 */
const reviewed = pinned.runtimeAttestation ?? null;

if (overrideSha === null && reviewed === null) {
  die(
    "evidence/upstream-baseline.json carries no runtimeAttestation block",
    "the loader will not import an unattested runtime — restore the reviewed identity, do not delete the gate",
  );
}

const attestation = overrideSha === null
  ? await loadAttestedRuntime(fileURLToPath(CLONE_IN_USE), reviewed)
  : null;

if (attestation !== null && attestation.runtimeAttestation !== "PASS") {
  // Report every leg, so a refusal names the failing one instead of "something is wrong".
  const legs = [
    ["SOURCE_SHA", attestation.sourceSha.status],
    ["LOCKFILE_SHA", attestation.lockfileSha.status],
    ["DIST_TREE_SHA", attestation.distTreeSha.status],
    ["PROD_CLOSURE_SHA", attestation.prodClosureSha.status],
    ["RUNTIME_ENTRYPOINT_EXISTS", attestation.runtimeEntrypointExists ? "PASS" : "FAIL"],
    ["RUNTIME_IMPORT", attestation.runtimeImport],
  ];
  for (const [name, status] of legs) console.error(`lab: ${name}=${status}`);
  if (attestation.closureError) console.error(`lab: closure: ${attestation.closureError}`);
  if (attestation.importError) console.error(`lab: import: ${attestation.importError}`);
  if (attestation.missingExports?.length) {
    console.error(`lab: missing protocol exports: ${attestation.missingExports.join(", ")}`);
  }
  die(
    "the promoted TCLK runtime is NOT attested — refusing to hand a module to protocol consumers",
    "rebuild and re-promote from the pinned commit (lab/runtime-attest.mjs explains each leg); the loader will not install, build or repair anything itself",
  );
}

/** SOURCE_ATTESTED AND DIST_ATTESTED AND DEPENDENCIES_ATTESTED AND IMPORTABLE. */
export const runtimeAttestation = attestation === null ? "COMPARISON_OVERRIDE" : "PASS";

/** The reviewed runtime identity actually enforced for this process, for artifacts to record. */
export const runtimeIdentity = attestation === null
  ? Object.freeze({ runtimeAttestation, comparisonOverride: true, sourceCommit: head })
  : Object.freeze({
      runtimeAttestation,
      algorithm: attestation.algorithm,
      sourceCommit: attestation.sourceSha.expected,
      lockfileSha256: attestation.lockfileSha.expected,
      distTreeSha256: attestation.distTreeSha.expected,
      prodClosureSha256: attestation.prodClosureSha.expected,
      distFileCount: attestation.distFileCount,
      closurePackageCount: attestation.closurePackageCount,
      entrypoint: attestation.runtimeEntrypoint,
    });

/**
 * The full public surface of the resolved upstream library, read-only.
 *
 * Reached only through the gate above: the attested path reuses the module the attestation itself
 * imported (importing twice would leave a window in which the bytes could change between the two),
 * and the override path imports the clone whose SHA the caller asserted.
 */
export const tclk = attestation === null ? await import(DIST_IN_USE.href) : attestation.module;