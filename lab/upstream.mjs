// SPDX-License-Identifier: Apache-2.0
//
// Resolve the pinned upstream build.
//
// This lab never reimplements protocol logic. Every primitive exercised here is imported
// from `.upstream/tclk/dist`, produced by upstream's own
// `pnpm -r --include-workspace-root build`. If the clone is missing, unbuilt, or no longer
// sitting on the commit recorded in evidence/upstream-baseline.json, we fail closed rather
// than silently rehearse against something else.

import { existsSync, readFileSync } from "node:fs";
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

export const baseline = JSON.parse(readFileSync(fileURLToPath(BASELINE), "utf8"));

if (!existsSync(fileURLToPath(DIST))) {
  die(
    "the pinned upstream build is missing (.upstream/tclk/dist/index.js)",
    "run scripts/bootstrap-upstream.ps1 — it clones the pinned commit and runs upstream's own gates",
  );
}

/** Read the checked-out commit of the upstream clone without shelling out to git. */
function cloneHead() {
  const gitDir = fileURLToPath(new URL(".git/", CLONE));
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  if (!head.startsWith("ref: ")) return head;
  const ref = head.slice(5).trim();
  const loose = join(gitDir, ...ref.split("/"));
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
  const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(" ")[0] : "unknown";
}

export const head = cloneHead();

if (head !== baseline.commit) {
  die(
    `the upstream clone is at ${head} but the pinned baseline is ${baseline.commit}`,
    "re-pin deliberately (scripts/verify-upstream.ps1) instead of rehearsing against an unrecorded commit",
  );
}

/** The full public surface of the pinned upstream library, read-only. */
export const tclk = await import(DIST.href);
