// PHASE 3B.1-R — CANONICAL RUNTIME-ARTIFACT TREE DIGEST.
//
// The lab verifies the upstream *clone's* git HEAD and then executes `.upstream/tclk/dist/index.js`.
// Upstream gitignores `dist/`, so the executed bytes were, until this module existed, bound to
// nothing at all: a source pin says what was *reviewed*, never what is *run*. Phase 3B.1 halted on
// exactly that gap, having found an executed artifact that predated the adopted pin.
//
// This module supplies the missing half of the trust chain: a deterministic content digest over the
// runtime artifact tree, so an attested SOURCE SHA and an attested DIST TREE DIGEST can be required
// together.
//
// ALGORITHM — `blackbox-tclk-dist-tree-v1`
//
//   1. Walk every regular file under the artifact root, recursively.
//   2. Relative paths, POSIX-normalised (`\` -> `/`), sorted by UTF-8 code unit order.
//   3. Preimage:
//
//          "TCLK_DIST_TREE_V1\n"
//          <relative-path> \0 <byte-length> \0 <sha256-hex-of-bytes> \n     (per file, in order)
//
//   4. Digest = SHA-256(preimage), lowercase hex.
//
// Binds path, length and content bytes of every runtime-relevant file. Filesystem mtimes, inode
// numbers, permission bits, directory entries and the absolute location of the tree are all
// deliberately excluded: none of them is executed, and all of them differ between two honest clean
// builds of identical source. Nothing else is excluded — no `.js.map` carve-out, no `.d.ts`
// carve-out — because a silent exclusion is how an attestation gets weakened without anyone
// deciding to weaken it.
//
// NOT a TCLK protocol hash. It is not a frame hash, not a contract id, not a manifest root, and it
// has no meaning to any peer. It is a Blackbox-local statement of the form "the artifact I executed
// is byte-identical to the artifact I attested". Its identifier is BLACKBOX_TCLK_DIST_TREE_SHA256.
//
// Zero dependencies, read-only, no subprocess, no network.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';

export const DIST_DIGEST_ALGORITHM = 'blackbox-tclk-dist-tree-v1';
const PREAMBLE = 'TCLK_DIST_TREE_V1\n';

/** Lexical order over the POSIX-normalised path, so ordering is a property of the tree, not the OS. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

function walk(root, dir, out) {
  // withFileTypes avoids a second stat per entry; symlinks are resolved explicitly below so that a
  // link cannot smuggle unattested bytes into the tree under an attested path.
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(dir, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(abs).isDirectory());
    if (isDir) {
      walk(root, abs, out);
      continue;
    }
    const bytes = readFileSync(abs);
    out.push({
      path: relative(root, abs).split(sep).join('/'),
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }
  return out;
}

/**
 * Per-file inventory of an artifact tree: the auditable expansion of the digest.
 *
 * Kept separate from the digest so a mismatch can be *localised* ("which file differs") rather than
 * only detected. A single opaque hash tells you the build is not reproducible; the inventory tells
 * you whether the difference is runtime semantics or metadata.
 */
export function inventory(distDir) {
  const root = resolve(distDir);
  if (!existsSync(root)) throw new Error(`blackbox: artifact tree is absent: ${root}`);
  if (!statSync(root).isDirectory()) throw new Error(`blackbox: artifact tree is not a directory: ${root}`);
  return walk(root, root, []).sort(byPath);
}

/** The exact bytes that are hashed. Exported so the algorithm is testable, not just assertable. */
export const preimageOf = files =>
  PREAMBLE + files.map(f => `${f.path}\0${f.size}\0${f.sha256}\n`).join('');

/** Digest an already-computed inventory: lets a recorded inventory be re-digested without the tree. */
export const treeDigestOfInventory = files => sha256Hex(preimageOf(files));

/**
 * Attest an artifact tree on disk.
 *
 * `entrypoint` is asserted as a *member of the digested tree*, not merely as a file that exists:
 * an entrypoint outside the attested set would be executable bytes that the digest does not cover.
 */
export function attestDistTree(distDir, { entrypoint = 'index.js' } = {}) {
  const files = inventory(distDir);
  const entry = files.find(f => f.path === entrypoint);
  return Object.freeze({
    algorithm: DIST_DIGEST_ALGORITHM,
    treeSha256: treeDigestOfInventory(files),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    entrypoint,
    entrypointPresent: Boolean(entry),
    entrypointSha256: entry?.sha256 ?? null,
    files: Object.freeze(files.map(Object.freeze)),
  });
}

/**
 * Compare two inventories and classify the difference.
 *
 * `runtimeSemantic` is the answer to the only question that can authorise a normalisation: does the
 * difference touch bytes Node executes or a type/schema surface, or only a non-runtime side artifact?
 * Classification never *acts* on that answer — Part 6 requires a human decision — it only stops the
 * two categories from being confused with each other.
 */
export function compareInventories(a, b) {
  const map = files => new Map(files.map(f => [f.path, f]));
  const [A, B] = [map(a), map(b)];
  const paths = [...new Set([...A.keys(), ...B.keys()])].sort();
  const onlyInA = [], onlyInB = [], contentDiffers = [];
  for (const path of paths) {
    const [x, y] = [A.get(path), B.get(path)];
    if (!y) onlyInA.push(path);
    else if (!x) onlyInB.push(path);
    else if (x.sha256 !== y.sha256 || x.size !== y.size) contentDiffers.push(path);
  }
  const differing = [...onlyInA, ...onlyInB, ...contentDiffers];
  // Executed JavaScript and the emitted type/schema surface are runtime-relevant. An external source
  // map is the one artifact that is provably not executed. Anything unrecognised counts as runtime:
  // fail closed on classification too, or the classifier becomes the weak link.
  const nonRuntime = /\.(?:js\.map|d\.ts\.map)$/;
  const runtimeSemantic = differing.filter(p => !nonRuntime.test(p));
  return Object.freeze({
    identical: differing.length === 0,
    onlyInA: Object.freeze(onlyInA),
    onlyInB: Object.freeze(onlyInB),
    contentDiffers: Object.freeze(contentDiffers),
    differingPaths: Object.freeze(differing),
    runtimeSemanticPaths: Object.freeze(runtimeSemantic),
    classification: differing.length === 0
      ? 'IDENTICAL'
      : runtimeSemantic.length > 0
        ? 'RUNTIME_SEMANTIC'
        : 'NON_RUNTIME_METADATA',
  });
}

// CLI: `node lab/dist-attest.mjs <distDir> [entrypoint]` -> JSON on stdout. Read-only by construction.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/'))) {
  const [dir, entrypoint = 'index.js'] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node lab/dist-attest.mjs <distDir> [entrypoint]');
    process.exit(2);
  }
  const report = attestDistTree(dir, { entrypoint });
  console.log(JSON.stringify(report, null, 2));
}
