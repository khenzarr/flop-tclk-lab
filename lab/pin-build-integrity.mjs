// SPDX-License-Identifier: Apache-2.0
//
// Phase 3B.1 pre-freeze gate: is the artifact this lab actually EXECUTES a build of the
// adopted TCLK pin?
//
// `lab/upstream.mjs` verifies the upstream *clone's* HEAD against
// evidence/upstream-baseline.json and then imports `.upstream/tclk/dist/index.js`. Those are
// two different objects. Upstream gitignores `dist/`, so it is a local build artifact that no
// SHA check covers: the clone can sit exactly on the pinned commit while `dist/` still holds
// the compiled output of some earlier commit. Every canonical frame, transition and hash this
// lab has produced came out of `dist/`, not out of the pinned sources.
//
// Phase 3B.1 must freeze byte-exact canonical frame templates "using the adopted TCLK
// implementation". That claim is only true if `dist/` is a build of the pin. This module
// answers that one question.
//
// Strictly read-only: static text analysis only. It never imports upstream code (importing
// would execute the very artifact whose provenance is in question), never writes, never
// touches custody, nonces, Technocore or the network.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const CLONE = new URL(".upstream/tclk/", ROOT);
const at = (rel) => fileURLToPath(new URL(rel, CLONE));
const read = (rel) => readFileSync(at(rel), "utf8");

/** Clone HEAD, resolved the way lab/upstream.mjs resolves it: no git shell-out. */
function cloneHead() {
  const dotGit = at(".git");
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) throw new Error(`unrecognised .git pointer in ${dotGit}`);
    gitDir = pointer.slice("gitdir: ".length).trim();
  }
  const head = readFileSync(`${gitDir}/HEAD`, "utf8").trim();
  return head.startsWith("ref: ") ? "SYMBOLIC_REF" : head;
}

/** Balanced-brace slice of the object literal that follows `marker`. */
function objectAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Frame field tables, extracted textually from whichever representation a side uses.
 *
 * The pinned sources keep them in src/frame-fields.generated.ts (generated from
 * schema/tclk1-frames.schema.json); the compiled artifact inlines them in dist/frames.js as
 * `const KEYS`. Both are parsed as text, never evaluated.
 */
function fieldTable(text, marker) {
  const body = objectAfter(text, marker);
  if (body === null) return null;
  const table = {};
  const entry = /"?([a-z]+)"?\s*:\s*\{/g;
  let m;
  while ((m = entry.exec(body)) !== null) {
    const block = objectAfter(body.slice(m.index), `${m[1]}`);
    if (block === null || !/allowed/.test(block)) continue;
    const list = (key) => {
      const hit = new RegExp(`"?${key}"?\\s*:\\s*\\[([^\\]]*)\\]`).exec(block);
      return hit ? [...hit[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    table[m[1]] = { allowed: list("allowed"), required: list("required") };
    entry.lastIndex = m.index + block.length;
  }
  return table;
}

/** Frame types the state machine actually dispatches on. */
const dispatchCases = (text) =>
  [...new Set([...text.matchAll(/case "([a-z]+)":/g)].map((x) => x[1]))].sort();

/** Module basenames, so a .ts/.js extension difference is not mistaken for a real one. */
function moduleNames(dir, ext) {
  return new Set(
    readdirSync(at(dir))
      .filter((f) => f.endsWith(ext) && !f.endsWith(`.d${ext}`))
      .map((f) => f.slice(0, -ext.length)),
  );
}

/**
 * Compare the pinned sources against the compiled artifact the lab imports.
 *
 * Returns a plain, serialisable record. `verdict` is `PIN_BUILD_COHERENT` only when the clone
 * is on the pin AND the artifact carries the pin's modules, dispatch cases and frame field
 * tables. Anything else is a stale or foreign build and no byte-exact freeze may be claimed
 * against it.
 */
export function probePinBuildIntegrity() {
  const baseline = JSON.parse(
    readFileSync(fileURLToPath(new URL("evidence/upstream-baseline.json", ROOT)), "utf8"),
  );

  const srcFrames = read("src/frames.ts");
  const distFrames = read("dist/frames.js");
  const srcCases = dispatchCases(read("src/machine.ts"));
  const distCases = dispatchCases(read("dist/machine.js"));

  const srcMods = moduleNames("src", ".ts");
  const distMods = moduleNames("dist", ".js");
  const missingFromDist = [...srcMods].filter((m) => !distMods.has(m)).sort();
  const missingFromSrc = [...distMods].filter((m) => !srcMods.has(m)).sort();

  const srcTable = fieldTable(read("src/frame-fields.generated.ts"), "FRAME_FIELDS");
  const distTable = fieldTable(distFrames, "const KEYS");

  const frameFieldDeltas = [];
  const names = [
    ...new Set([...Object.keys(srcTable ?? {}), ...Object.keys(distTable ?? {})]),
  ].sort();
  for (const name of names) {
    const built = distTable?.[name];
    const pinned = srcTable?.[name];
    if (!built) {
      frameFieldDeltas.push({ frame: name, delta: "ABSENT_FROM_BUILT_ARTIFACT" });
      continue;
    }
    if (!pinned) {
      frameFieldDeltas.push({ frame: name, delta: "ABSENT_FROM_PINNED_SOURCE" });
      continue;
    }
    for (const key of ["allowed", "required"]) {
      const a = built[key].join(",");
      const b = pinned[key].join(",");
      if (a !== b) {
        frameFieldDeltas.push({ frame: name, delta: `${key}_DIFFERS`, built: a, pinnedSource: b });
      }
    }
  }

  const head = cloneHead();
  const cloneOnPin = head === baseline.commit;
  const casesMatch = srcCases.join(",") === distCases.join(",");
  const coherent =
    cloneOnPin && casesMatch && missingFromDist.length === 0 && frameFieldDeltas.length === 0;

  return {
    pin: baseline.commit,
    cloneHead: head,
    cloneOnPin,
    labResolvesProtocolFrom: "dist/index.js",
    distTrackedByUpstreamGit: /(^|\n)dist\/?(\n|$)/.test(read(".gitignore")) ? false : null,
    pinnedSourceFrameTypes: [
      ...new Set([...srcFrames.matchAll(/type: "([a-z]+)"/g)].map((x) => x[1])),
    ].sort(),
    pinnedSourceMachineCases: srcCases,
    builtArtifactMachineCases: distCases,
    machineCasesMatch: casesMatch,
    modulesMissingFromBuiltArtifact: missingFromDist,
    modulesMissingFromPinnedSource: missingFromSrc,
    pinnedSourceExportsMakeHeartbeat: /export function makeHeartbeat/.test(srcFrames),
    builtArtifactExportsMakeHeartbeat: /function makeHeartbeat/.test(distFrames),
    pinnedSourceUsesGeneratedFieldTable: /frame-fields\.generated/.test(srcFrames),
    builtArtifactHasGeneratedFieldTable: existsSync(at("dist/frame-fields.generated.js")),
    frameFieldDeltaCount: frameFieldDeltas.length,
    frameFieldDeltas,
    builtArtifactMtime: statSync(at("dist/frames.js")).mtime.toISOString(),
    pinnedSourceMtime: statSync(at("src/frames.ts")).mtime.toISOString(),
    distIsABuildOfThePin: coherent,
    verdict: coherent ? "PIN_BUILD_COHERENT" : "STALE_BUILD__EXECUTED_PROTOCOL_IS_NOT_THE_PIN",
  };
}

/**
 * The Phase 3B.1 freeze gate.
 *
 * A byte-exact manifest may only be frozen against an implementation whose provenance is
 * established. Callers must consult this before writing any artifact that claims frozen
 * canonical bytes or a canonical/template hash.
 */
export function freezeAllowed(report = probePinBuildIntegrity()) {
  return report.verdict === "PIN_BUILD_COHERENT";
}

if (import.meta.url === `file:///${process.argv[1].split("\\").join("/")}`) {
  const report = probePinBuildIntegrity();
  for (const [key, value] of Object.entries(report)) {
    if (key === "frameFieldDeltas") continue;
    console.log(`${key}=${Array.isArray(value) ? value.join(",") : value}`);
  }
  for (const delta of report.frameFieldDeltas) console.log(`  DELTA ${JSON.stringify(delta)}`);
  console.log(`FREEZE_ALLOWED=${freezeAllowed(report) ? "YES" : "NO"}`);
  process.exitCode = freezeAllowed(report) ? 0 : 1;
}
