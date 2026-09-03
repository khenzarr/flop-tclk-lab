// SPDX-License-Identifier: Apache-2.0
//
// Resolve the pinned upstream build.
//
// This lab never reimplements protocol logic. Every primitive exercised here is imported
// from `.upstream/tclk/dist`, produced by upstream's own
// `pnpm -r --include-workspace-root build`. If the clone is missing, unbuilt, or no longer
// sitting on the commit recorded in evidence/upstream-baseline.json, we fail closed rather
// than silently rehearse against something else.

import { existsSync, readFileSync, statSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { join } from "node:path";

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


/**
 * Read the checked-out commit of the upstream clone without shelling out to git.
 *
 * `git worktree` clones carry a `.git` *file* pointing at the parent repository, so resolve
 * that indirection before looking for refs.
 */
function cloneHead(clone) {
  const dotGit = fileURLToPath(new URL(".git", clone));
  // A normal clone has a `.git` directory; a linked worktree has a `.git` file whose contents
  // are `gitdir: <path>`. Both must resolve, and neither may be guessed at.
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) die(`unrecognised .git pointer in ${dotGit}`);
    gitDir = pointer.slice("gitdir: ".length).trim();
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();

  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  const loose = join(gitDir, ...ref.split("/"));
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
  const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(" ")[0] : "unknown";
}

export const head = cloneHead(CLONE_IN_USE);

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

/** The full public surface of the resolved upstream library, read-only. */
export const tclk = await import(DIST_IN_USE.href);


