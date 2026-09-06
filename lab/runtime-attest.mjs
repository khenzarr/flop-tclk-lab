// SPDX-License-Identifier: Apache-2.0
//
// Phase 3B.1-R2: the identity of the TCLK runtime this lab actually EXECUTES.
//
// Phase 3B.1-R proved the promoted `dist/` is a reproducible build of the adopted pin, and that
// was still not enough: `dist/transcript.js` carries a bare `@scure/base` import, so a
// byte-perfect `dist/` whose production dependency closure is absent is an artifact that cannot
// run. "Attested" therefore cannot mean "the compiled bytes are the right compiled bytes".
//
// A runtime identity is the conjunction of five facts, none of which implies another:
//
//   source SHA          which commit the checkout is on
//   lockfile SHA        which dependency resolution that commit declares
//   dist tree SHA       which compiled bytes were promoted
//   prod closure SHA    which dependency package contents are installed next to them
//   entrypoint exists   there is something to import at all
//
// This module computes those five and compares them to a reviewed record. It decides nothing
// else: it does not install, does not build, does not fetch, and does not import. The import is
// the caller's step (lab/upstream.mjs), gated on the verdict returned here — a verifier that
// also loads is a verifier that can be talked into loading.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { attestDistTree } from "./dist-attest.mjs";
import { attestProdClosure } from "./closure-attest.mjs";

/** Versioned so a future change to what "runtime identity" binds cannot be silently retroactive. */
export const RUNTIME_ATTESTATION_ALGORITHM = "blackbox-tclk-runtime-v1";

/**
 * The protocol surface the 13 lab/Blackbox consumers actually reach for.
 *
 * Checked after import: a module that loads but does not export the protocol is a different
 * failure from a module that does not load, and both must refuse. Deliberately a floor, not the
 * full 66-name surface — pinning every name would make an upstream *addition* look like a
 * compromise.
 */
export const EXPECTED_PROTOCOL_EXPORTS = Object.freeze([
  "TCLK_VERSION",
  "TCLK_PREFIX",
  "TCLK_DOMAIN",
  "MAX_FRAME_CHARS",
  "makeOffer",
  "makeAccept",
  "makeHeartbeat",
  "applyFrame",
  "encodeFrame",
  "decodeFrame",
  "validateFrame",
  "canonicalJson",
  "contractId",
  "dealRoom",
  "offerId",
  "foldTranscript",
]);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The checked-out commit, read from git's own files rather than by shelling out to git.
 *
 * A normal clone has a `.git` directory; a linked worktree has a `.git` file containing
 * `gitdir: <path>`. Both resolve; neither is guessed at. Shared with lab/upstream.mjs so the
 * loader and the attestation can never disagree about what "the source SHA" means.
 */
export function cloneHead(cloneDir) {
  const dotGit = join(resolve(cloneDir), ".git");
  if (!existsSync(dotGit)) return "ABSENT";
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return "UNRECOGNISED_GIT_POINTER";
    gitDir = pointer.slice("gitdir: ".length).trim();
  }
  const headPath = join(gitDir, "HEAD");
  if (!existsSync(headPath)) return "ABSENT";
  const head = readFileSync(headPath, "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  const loose = join(gitDir, ...ref.split("/"));
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  const packed = join(gitDir, "packed-refs");
  if (!existsSync(packed)) return "UNRESOLVED_REF";
  const line = readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(" ")[0] : "UNRESOLVED_REF";
}

/** SHA-256 of the declared lockfile bytes, or null when the lockfile is absent. */
export function lockfileSha256(cloneDir, lockfile = "pnpm-lock.yaml") {
  const path = join(resolve(cloneDir), ...lockfile.split("/"));
  return existsSync(path) ? sha256Hex(readFileSync(path)) : null;
}

const check = (expected, actual) => Object.freeze({
  expected,
  actual,
  status: actual !== null && actual === expected ? "PASS" : "FAIL",
});

/**
 * Attest a candidate runtime tree against a reviewed identity record.
 *
 * Every stage is attempted and reported even when an earlier one fails: a report that stops at
 * the first mismatch tells an operator "something is wrong", a full report tells them *what*.
 * `reviewed` is the record from evidence/upstream-baseline.json — the caller supplies it, so a
 * fixture can be attested against the real reviewed values, which is exactly what the negative
 * controls need.
 */
export function attestRuntime(cloneDir, reviewed, { lockfile = "pnpm-lock.yaml" } = {}) {
  const root = resolve(cloneDir);
  const distDir = join(root, "dist");
  const entrypoint = reviewed.dist.entrypoint;
  const entrypointPath = join(distDir, ...entrypoint.split("/"));

  const sourceSha = check(reviewed.sourceCommit, cloneHead(root));
  const lock = check(reviewed.lockfile.sha256, lockfileSha256(root, lockfile));

  let dist = check(reviewed.dist.sha256, null);
  let distFileCount = null;
  if (existsSync(distDir)) {
    const attested = attestDistTree(distDir, { entrypoint });
    dist = check(reviewed.dist.sha256, attested.treeSha256);
    distFileCount = attested.fileCount;
  }

  let closure = check(reviewed.productionDependencyClosure.sha256, null);
  let closurePackages = null;
  let closureError = null;
  try {
    const attested = attestProdClosure(root, { lockfile });
    closure = check(reviewed.productionDependencyClosure.sha256, attested.closureSha256);
    closurePackages = attested.packageCount;
  } catch (error) {
    closureError = error.message;
  }

  const entrypointExists = existsSync(entrypointPath);
  const stages = [sourceSha, lock, dist, closure];
  const attested = stages.every((s) => s.status === "PASS") && entrypointExists;

  return Object.freeze({
    algorithm: RUNTIME_ATTESTATION_ALGORITHM,
    cloneDir: root.split(sep).join("/"),
    sourceSha,
    lockfileSha: lock,
    distTreeSha: dist,
    prodClosureSha: closure,
    distFileCount,
    closurePackageCount: closurePackages,
    closureError,
    runtimeEntrypoint: entrypoint,
    runtimeEntrypointExists: entrypointExists,
    // Import is a separate, later fact: this verdict authorises the attempt, it does not claim it
    // succeeded. RUNTIME_ATTESTED is only reachable through loadAttestedRuntime().
    verdict: attested ? "STATIC_IDENTITY_ATTESTED" : "REFUSED",
  });
}

/** Names a module claims to export that the protocol consumers require and did not get. */
export const missingProtocolExports = (module, expected = EXPECTED_PROTOCOL_EXPORTS) =>
  expected.filter((name) => module === null || module[name] === undefined);

/**
 * The one door to the protocol runtime.
 *
 * Order is the whole point: the four digests and the entrypoint are verified BEFORE `importer`
 * is called, so unattested bytes are never executed; then the loaded surface is checked, so a
 * module that imports but is not the protocol is refused too. On any refusal `module` is null —
 * a caller cannot destructure its way past the gate. `importer` is injected so the failure path
 * ("hashes pass, import still throws") is testable without corrupting a real runtime.
 */
export async function loadAttestedRuntime(cloneDir, reviewed, options = {}) {
  const report = attestRuntime(cloneDir, reviewed, options);
  const base = {
    ...report,
    runtimeImport: "NOT_ATTEMPTED",
    importError: null,
    missingExports: null,
    module: null,
    runtimeAttestation: "REFUSED",
  };
  if (report.verdict !== "STATIC_IDENTITY_ATTESTED") return Object.freeze(base);

  const href = new URL(
    `file:///${join(resolve(cloneDir), "dist", ...reviewed.dist.entrypoint.split("/"))
      .split(sep)
      .join("/")}`,
  ).href;
  const importer = options.importer ?? ((target) => import(target));

  let module = null;
  try {
    module = await importer(href);
  } catch (error) {
    return Object.freeze({
      ...base,
      runtimeImport: "FAIL",
      importError: `${error.code ?? error.name}: ${error.message}`,
    });
  }

  const missing = missingProtocolExports(module, options.expectedExports);
  if (missing.length > 0) {
    return Object.freeze({ ...base, runtimeImport: "FAIL", missingExports: Object.freeze(missing) });
  }

  return Object.freeze({
    ...base,
    runtimeImport: "PASS",
    missingExports: Object.freeze([]),
    module,
    runtimeAttestation: "PASS",
  });
}

/** SOURCE_ATTESTED AND DIST_ATTESTED AND DEPENDENCIES_ATTESTED AND IMPORTABLE. */
export const runtimeAttested = (result) => result.runtimeAttestation === "PASS";
