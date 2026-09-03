// SPDX-License-Identifier: Apache-2.0
//
// Phase 3A-2 Blackbox ⇄ upstream compatibility matrix.
//
// Runs lab/compat-probe.mjs twice — once against the pinned commit, once against a candidate
// upstream head — and diffs the two surface documents. The candidate is addressed through the
// documented FLOPLAB_UPSTREAM_DIR / FLOPLAB_UPSTREAM_SHA override, so both runs go through the
// real replay code and the real upstream build. Neither run writes to the upstream clones.
//
//   node lab/compat-matrix.mjs <candidateDir> <candidateSha>
//
// Verdicts:
//
//   EQUIVALENT             surface identical
//   EXPECTED_PROVENANCE    differs only because the recorded upstream SHA differs (re-pin
//                          changes provenance-bound fingerprints by construction)
//   EXPANDED_SAFE          public surface grew, nothing removed or redefined
//   DEADLINE_RULE_TIGHTENED  a precondition got stricter at a deadline boundary while the
//                          lawful ordering of the same path is byte-for-byte unchanged
//   BEHAVIOUR_CHANGED      protocol-observable difference — never auto-accepted

//
// Exit codes: 0 compatible, 2 requires adaptation, 1 incompatible. Anything other than 0
// means the pin does not move on this run. Re-pinning is a human decision; this tool only
// supplies the evidence for it.


import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const PROBE = fileURLToPath(new URL("compat-probe.mjs", import.meta.url));

const [candidateDir, candidateSha] = process.argv.slice(2);
if (!candidateDir || !candidateSha) {
  console.error("usage: node lab/compat-matrix.mjs <candidateDir> <candidateSha>");
  process.exit(1);
}

function probe(env) {
  const out = execFileSync(process.execPath, [PROBE], {
    cwd: fileURLToPath(ROOT),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const pinnedRun = probe({ FLOPLAB_UPSTREAM_DIR: "", FLOPLAB_UPSTREAM_SHA: "" });
const candidateRun = probe({
  FLOPLAB_UPSTREAM_DIR: candidateDir,
  FLOPLAB_UPSTREAM_SHA: candidateSha,
});

const oldSha = pinnedRun.upstream.commit;
const newSha = candidateRun.upstream.commit;
if (newSha !== candidateSha) {
  console.error(`compat: candidate clone resolved to ${newSha}, expected ${candidateSha}`);
  process.exit(1);
}

/**
 * Provenance-bound values differ between commits by construction: they hash the upstream SHA
 * itself. Everything else is protocol-observable.
 */
const PROVENANCE_KEYS = new Set(["replayFingerprint"]);

/** Deep structural diff, returning dotted paths of differing leaves. */
function diffPaths(a, b, path = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const scalar = (v) => v === null || typeof v !== "object";
  if (scalar(a) || scalar(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path, old: a, new: b });
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) {
      out.push({ path: `${path}.length`, old: a.length, new: b.length });
      return out;
    }
    a.forEach((item, i) => diffPaths(item, b[i], `${path}[${i}]`, out));
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  }
  return out;
}

/** Classify one named surface. */
function classify(name, a, b) {
  const diffs = diffPaths(a, b);
  if (diffs.length === 0) {
    return { surface: name, verdict: "EQUIVALENT", differences: [] };
  }
  const onlyProvenance = diffs.every((d) => {
    const leaf = d.path.split(".").pop() ?? "";
    return PROVENANCE_KEYS.has(leaf) || d.path.endsWith("upstream.sha") || d.path.endsWith("upstream.commit");
  });
  return {
    surface: name,
    verdict: onlyProvenance ? "EXPECTED_PROVENANCE" : "BEHAVIOUR_CHANGED",
    differences: diffs.slice(0, 12),
    differenceCount: diffs.length,
  };
}

const exportsAdded = candidateRun.surfaces.exports.filter((e) => !pinnedRun.surfaces.exports.includes(e));
const exportsRemoved = pinnedRun.surfaces.exports.filter((e) => !candidateRun.surfaces.exports.includes(e));

/**
 * A purely additive export list is not a compatibility event: nothing the Blackbox already
 * imports has been removed or redefined. Removals are, and stay BEHAVIOUR_CHANGED.
 */
const exportsRow = (() => {
  const row = classify("exports", pinnedRun.surfaces.exports, candidateRun.surfaces.exports);
  if (row.verdict === "EQUIVALENT") return row;
  if (exportsRemoved.length === 0) {
    return { surface: "exports", verdict: "EXPANDED_SAFE", added: exportsAdded, removed: [] };
  }
  return { ...row, added: exportsAdded, removed: exportsRemoved };
})();

/**
 * Did the lawful ordering of the lock → refund path survive? This is the question that decides
 * whether a deadline change is an adaptation or a broken refund path, so it is computed before
 * any row is classified and reported on its own.
 */
const lawfulOrderingPreserved =
  JSON.stringify(pinnedRun.surfaces.timeModel.progressiveClock) ===
  JSON.stringify(candidateRun.surfaces.timeModel.progressiveClock);

/**
 * The time-model surface exists to *detect* deadline changes, so a difference here is a
 * finding, not automatically a fault. It is only downgraded when the difference is confined to
 * the flat-clock run — i.e. the strictness moved, the lawful ordering did not.
 */
const timeModelRow = (() => {
  const row = classify("timeModel", pinnedRun.surfaces.timeModel, candidateRun.surfaces.timeModel);
  if (row.verdict === "EQUIVALENT") return row;
  const flatOnly = row.differences.every((d) => d.path.startsWith("flatClockAtRefundBoundary"));
  if (flatOnly && lawfulOrderingPreserved) {
    return { ...row, verdict: "DEADLINE_RULE_TIGHTENED" };
  }
  return row;
})();

const rows = [
  exportsRow,
  classify("canonicalization", pinnedRun.surfaces.canonicalization, candidateRun.surfaces.canonicalization),
  classify("contract", pinnedRun.surfaces.contract, candidateRun.surfaces.contract),
  timeModelRow,
  classify("paperRail", pinnedRun.surfaces.paperRail, candidateRun.surfaces.paperRail),

  ...Object.keys(pinnedRun.surfaces.fixtures).map((name) =>
    classify(`fixture:${name}`, pinnedRun.surfaces.fixtures[name], candidateRun.surfaces.fixtures[name]),
  ),
];


/**
 * The load-bearing question, stated separately from the row verdicts: does the same transcript
 * still produce the same protocol outcome under the candidate commit?
 */
const fixtureNames = Object.keys(pinnedRun.surfaces.fixtures);
const behaviourIdentical = fixtureNames.every(
  (name) =>
    pinnedRun.surfaces.fixtures[name].replayFingerprintSansUpstream ===
    candidateRun.surfaces.fixtures[name].replayFingerprintSansUpstream,
);
const provenanceRotated = fixtureNames.every(
  (name) =>
    pinnedRun.surfaces.fixtures[name].replayFingerprint !==
    candidateRun.surfaces.fixtures[name].replayFingerprint,
);

const changed = rows.filter((r) => r.verdict === "BEHAVIOUR_CHANGED");

/**
 * Attribution, not excuse-making.
 *
 * A fixture that diverges is only downgraded from "incompatible" to "requires adaptation" when
 * the divergence is mechanically explained by a *tightened precondition our own fixture clock
 * trips*, and the lawful ordering of the same path is untouched. Concretely, all of:
 *
 *   - the transcript bytes are identical (no canonicalization involvement),
 *   - the first step that flipped accepted → rejected carries a rejection reason that the
 *     candidate produces under a flat clock at the refund boundary but NOT under a
 *     progressive clock, and
 *   - the candidate's progressive-clock run is identical to the pinned one.
 *
 * Anything else stays BEHAVIOUR_CHANGED and blocks.
 */
const reasonsIn = (run) => [run.accept, run.lock, run.refund].map((s) => s.reason).filter(Boolean);
const flatOnlyReasons = new Set(
  reasonsIn(candidateRun.surfaces.timeModel.flatClockAtRefundBoundary).filter(
    (reason) => !reasonsIn(candidateRun.surfaces.timeModel.progressiveClock).includes(reason),
  ),
);
function attributeFixture(name) {

  const a = pinnedRun.surfaces.fixtures[name];
  const b = candidateRun.surfaces.fixtures[name];
  if (JSON.stringify(a.lineHashes) !== JSON.stringify(b.lineHashes)) return null;
  const flipped = a.steps.find((step, i) => step.ok === true && b.steps[i]?.ok === false);
  if (!flipped) return null;
  const reason = b.steps[flipped.index].reason;
  if (!flatOnlyReasons.has(reason)) return null;
  return { fixture: name, flippedStep: flipped.index, frameType: flipped.type, reason };
}

const attributions = changed
  .filter((r) => r.surface.startsWith("fixture:"))
  .map((r) => attributeFixture(r.surface.slice("fixture:".length)));
const unexplained = changed.filter(
  (r) => !r.surface.startsWith("fixture:") || attributeFixture(r.surface.slice("fixture:".length)) === null,
);
const deadlineAttributed = attributions.filter(Boolean);

const verdict =
  changed.length === 0 && behaviourIdentical
    ? "BLACKBOX_COMPATIBLE"
    : unexplained.length === 0 && lawfulOrderingPreserved && exportsRemoved.length === 0
      ? "REQUIRES_ADAPTATION"
      : "BLACKBOX_INCOMPATIBLE";

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  safe: true,
  oldPin: { commit: oldSha, packageVersion: pinnedRun.upstream.packageVersion },
  candidate: { commit: newSha, packageVersion: candidateRun.upstream.packageVersion, dir: candidateDir },
  wireFormatCompatible:
    rows.find((r) => r.surface === "canonicalization")?.verdict === "EQUIVALENT",
  stateMachineCompatible: rows
    .filter((r) => r.surface.startsWith("fixture:") || r.surface === "contract")
    .every((r) => r.verdict !== "BEHAVIOUR_CHANGED"),
  lawfulOrderingPreserved,
  fixtureBehaviourIdentical: behaviourIdentical,
  provenanceFingerprintsRotated: provenanceRotated,
  exportsAdded,
  exportsRemoved,
  deadlineAttributedDivergences: deadlineAttributed,
  unexplainedSurfaces: unexplained.map((r) => r.surface),
  rows,
  verdict,
};


mkdirSync(fileURLToPath(new URL("evidence/", ROOT)), { recursive: true });
writeFileSync(
  fileURLToPath(new URL("evidence/blackbox-upstream-compat.json", ROOT)),
  JSON.stringify(report, null, 2) + "\n",
);

console.log(
  JSON.stringify(
    {
      verdict: report.verdict,
      oldPin: oldSha.slice(0, 8),
      candidate: newSha.slice(0, 8),
      wireFormatCompatible: report.wireFormatCompatible,
      stateMachineCompatible: report.stateMachineCompatible,
      fixtureBehaviourIdentical: behaviourIdentical,
      provenanceFingerprintsRotated: provenanceRotated,
      lawfulOrderingPreserved,
      exportsAdded: report.exportsAdded,
      exportsRemoved: report.exportsRemoved,
      behaviourChangedSurfaces: changed.map((r) => r.surface),
      deadlineAttributedDivergences: deadlineAttributed,
      unexplainedSurfaces: report.unexplainedSurfaces,
    },
    null,
    2,
  ),
);

// 0 compatible · 2 requires adaptation · 1 incompatible. Only 0 permits a re-pin.
if (report.verdict === "BLACKBOX_COMPATIBLE") process.exit(0);
process.exit(report.verdict === "REQUIRES_ADAPTATION" ? 2 : 1);


