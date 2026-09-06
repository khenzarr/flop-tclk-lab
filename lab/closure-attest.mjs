// SPDX-License-Identifier: Apache-2.0
//
// PHASE 3B.1-R2 — CANONICAL PRODUCTION DEPENDENCY CLOSURE DIGEST.
//
// Phase 3B.1-R attested the runtime *artifact* (`blackbox-tclk-dist-tree-v1`) and proved it was
// reproducibly built from the adopted source pin — and then the promoted runtime still could not
// load: `dist/transcript.js` carries a bare `import '@scure/base'`, and no production dependency
// closure had ever been promoted alongside the artifact. An attested artifact that cannot execute
// is not an attested runtime.
//
// This module attests the third leg: the packages Node actually resolves at import time.
//
// WHY NOT HASH node_modules
// -------------------------
// A raw filesystem digest of `node_modules` is not an identity of the dependency closure. pnpm
// materialises the tree as junctions/symlinks into a machine-local virtual store
// (`node_modules/.pnpm/...`) whose paths embed the store location, and hard-links content from a
// content-addressable store outside the project. Two honest installs of the identical lockfile on
// two machines therefore differ as filesystems while being byte-identical as *packages*. The
// attestation must bind what is imported, not how the disk was arranged.
//
// ALGORITHM — `blackbox-tclk-prod-closure-v1`
// -------------------------------------------
//   1. Roots = the production dependency edges declared by the attested package itself:
//      `dependencies` + `optionalDependencies` of the promoted package.json. `devDependencies` are
//      never traversed: a build checkout containing vitest must not make vitest part of the
//      production runtime identity.
//   2. Traverse transitively using real Node resolution from each resolved package's REAL path
//      (walk up `node_modules/<name>/package.json`), following each package's own
//      `dependencies` + `optionalDependencies`. What is traversed is what `import` would find.
//   3. Per resolved package instance, bind:
//        name, version, resolution identity (`<name>@<version>`, the pnpm lockfile key),
//        lockfile integrity (the `resolution.integrity` recorded for that key, or `-` if absent),
//        content digest = SHA-256 over the package's own files.
//   4. Package content digest — files under the package root, excluding nested `node_modules`
//        (a nested dependency is a package in its own right and is recorded separately):
//
//          "TCLK_PKG_CONTENT_V1\n"
//          <relative-path> \0 <byte-length> \0 <sha256-hex> \n     (lexical by path)
//
//   5. Closure preimage — records sorted by (name, version, resolutionId):
//
//          "TCLK_PROD_CLOSURE_V1\n"
//          <name> \0 <version> \0 <resolutionId> \0 <integrity> \0 <contentSha256> \n
//
//   6. Digest = SHA-256(preimage), lowercase hex.
//
// EXCLUDED BY CONSTRUCTION: mtimes, permission bits, inode/link counts, absolute paths, the
// virtual-store path, the pnpm store location, the checkout directory name, and the Windows user
// name. None of them is imported; all of them differ between two honest installs. Symlinks and
// junctions are resolved to their real target and then bound by LOGICAL package identity, never by
// the machine-specific path that got us there.
//
// FAIL CLOSED: a package whose realpath escapes its declared root, a file that resolves outside
// the package root, an unresolvable non-optional dependency, or a package instance appearing twice
// with different content all throw rather than degrade the digest.
//
// NOT a TCLK protocol hash. It is a Blackbox-local statement: "the modules my runtime imports are
// exactly the modules I attested". Identifier: BLACKBOX_TCLK_PROD_CLOSURE_SHA256.
//
// Zero dependencies, read-only, no subprocess, no network.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLOSURE_DIGEST_ALGORITHM = 'blackbox-tclk-prod-closure-v1';
const CLOSURE_PREAMBLE = 'TCLK_PROD_CLOSURE_V1\n';
const PACKAGE_PREAMBLE = 'TCLK_PKG_CONTENT_V1\n';

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = p => p.split(sep).join('/');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Lockfile integrity index: pnpm lockfile key -> `resolution.integrity`.
 *
 * Deliberately a narrow textual read of the `packages:` block rather than a YAML dependency: the
 * attestation must not acquire a parser it would then have to attest. Only two shapes exist in a
 * v9 lockfile package entry, `{integrity: ...}` inline and a nested `integrity:` line, and both are
 * matched. A key we cannot find an integrity for is recorded as `-`, never silently as verified.
 */
export function lockfileIntegrityIndex(lockfilePath) {
  const text = readFileSync(lockfilePath, 'utf8');
  const start = text.indexOf('\npackages:');
  const index = new Map();
  if (start < 0) return index;
  let key = null;
  for (const line of text.slice(start).split('\n')) {
    const entry = /^ {2}'?([^'\s][^']*?)'?:\s*$/.exec(line);
    if (entry) {
      key = entry[1];
      continue;
    }
    if (!key) continue;
    const integrity = /integrity:\s*([A-Za-z0-9+/=-]+)/.exec(line);
    if (integrity) {
      index.set(key, integrity[1]);
      key = null;
    }
  }
  return index;
}

/** Files of one package: its own content, never a nested dependency's. */
function packageFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      // Resolve links explicitly: a link must not smuggle unattested bytes in under an attested
      // path, and must not walk us out of the package.
      const real = realpathSync(abs);
      if (real !== root && !real.startsWith(root + sep)) {
        throw new Error(`blackbox: package content escapes its root: ${abs} -> ${real}`);
      }
      if (statSync(real).isDirectory()) {
        walk(real);
        continue;
      }
      const bytes = readFileSync(real);
      out.push({ path: posix(relative(root, abs)), size: bytes.byteLength, sha256: sha256Hex(bytes) });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export const packageContentPreimage = files =>
  PACKAGE_PREAMBLE + files.map(f => `${f.path}\0${f.size}\0${f.sha256}\n`).join('');

export const packageContentDigest = root => {
  const files = packageFiles(root);
  return { sha256: sha256Hex(packageContentPreimage(files)), fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0) };
};

/**
 * Node's own resolution, restricted to package roots: walk up `node_modules/<name>`.
 *
 * This is what makes the closure the *imported* set rather than a hopeful reading of the lockfile.
 * pnpm's virtual store places a package's own dependencies beside it inside
 * `.pnpm/<pkg>/node_modules/`, so walking up from the real path finds exactly the instance the
 * loader would bind.
 */
function resolvePackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const prodEdges = manifest => ({
  ...(manifest.dependencies ?? {}),
  ...(manifest.optionalDependencies ?? {}),
});

/**
 * Attest the production dependency closure of an installed checkout.
 *
 * `installRoot` is the directory holding the attested package.json and its `node_modules`.
 * Traversal starts at that package's own production edges, so the result is the closure of the
 * promoted runtime — not of the workspace, and not of whatever else the checkout happens to hold.
 */
export function attestProdClosure(installRoot, { lockfile = 'pnpm-lock.yaml' } = {}) {
  const root = realpathSync(resolve(installRoot));
  const manifest = readJson(join(root, 'package.json'));
  const integrityOf = lockfileIntegrityIndex(resolve(root, lockfile));

  const rootEdges = prodEdges(manifest);
  const optionalRoots = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  const records = new Map();
  const missingOptional = [];
  const queue = Object.keys(rootEdges).map(name => ({ name, fromDir: root, optional: optionalRoots.has(name) }));

  while (queue.length > 0) {
    const { name, fromDir, optional } = queue.shift();
    const dir = resolvePackageDir(fromDir, name);
    if (dir === null) {
      // An absent optional dependency is a legitimate install outcome and is recorded as such.
      // An absent required dependency is exactly the Phase 3B.1-R blocker: fail closed.
      if (optional) {
        missingOptional.push(name);
        continue;
      }
      throw new Error(`blackbox: production dependency '${name}' is not resolvable from ${fromDir}`);
    }
    const pkg = readJson(join(dir, 'package.json'));
    const resolutionId = `${pkg.name}@${pkg.version}`;
    const existing = records.get(resolutionId);
    const content = existing ? existing.content : packageContentDigest(dir);
    if (existing) {
      if (existing.content.sha256 !== content.sha256) {
        throw new Error(`blackbox: two instances of ${resolutionId} differ in content`);
      }
      continue;
    }
    records.set(resolutionId, {
      name: pkg.name,
      version: pkg.version,
      resolutionId,
      integrity: integrityOf.get(resolutionId) ?? '-',
      content,
    });
    const edges = prodEdges(pkg);
    const optionalEdges = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const dep of Object.keys(edges)) queue.push({ name: dep, fromDir: dir, optional: optionalEdges.has(dep) });
  }

  const packages = [...records.values()]
    .map(r => Object.freeze({
      name: r.name,
      version: r.version,
      resolutionId: r.resolutionId,
      lockIntegrity: r.integrity,
      contentSha256: r.content.sha256,
      fileCount: r.content.fileCount,
      totalBytes: r.content.totalBytes,
    }))
    .sort((a, b) => (a.resolutionId < b.resolutionId ? -1 : a.resolutionId > b.resolutionId ? 1 : 0));

  return Object.freeze({
    algorithm: CLOSURE_DIGEST_ALGORITHM,
    closureSha256: closureDigestOfPackages(packages),
    packageCount: packages.length,
    rootDependencies: Object.freeze(Object.keys(manifest.dependencies ?? {}).sort()),
    optionalRootDependencies: Object.freeze([...optionalRoots].sort()),
    peerRootRequirements: Object.freeze(Object.keys(manifest.peerDependencies ?? {}).sort()),
    missingOptional: Object.freeze(missingOptional.sort()),
    packages: Object.freeze(packages),
  });
}

/** The exact bytes hashed, so the algorithm is testable rather than merely asserted. */
export const closurePreimageOf = packages =>
  CLOSURE_PREAMBLE +
  packages
    .map(p => `${p.name}\0${p.version}\0${p.resolutionId}\0${p.lockIntegrity}\0${p.contentSha256}\n`)
    .join('');

/** Re-digest a recorded inventory without the installed tree present. */
export const closureDigestOfPackages = packages => sha256Hex(closurePreimageOf(packages));

/**
 * Localise a closure mismatch instead of only detecting it.
 *
 * Accepts either a package inventory or a whole attestation report on each side: the two are
 * trivially confusable at the call site, and a comparison helper that throws on the wrong shape
 * is a comparison helper that silently skips a negative control.
 */
export function compareClosures(a, b) {
  const inventory = value => (Array.isArray(value) ? value : value.packages);
  const map = packages => new Map(inventory(packages).map(p => [p.resolutionId, p]));
  const [A, B] = [map(a), map(b)];

  const ids = [...new Set([...A.keys(), ...B.keys()])].sort();
  const onlyInA = [], onlyInB = [], contentDiffers = [], integrityDiffers = [];
  for (const id of ids) {
    const [x, y] = [A.get(id), B.get(id)];
    if (!y) onlyInA.push(id);
    else if (!x) onlyInB.push(id);
    else {
      if (x.contentSha256 !== y.contentSha256) contentDiffers.push(id);
      if (x.lockIntegrity !== y.lockIntegrity) integrityDiffers.push(id);
    }
  }
  const differing = [...onlyInA, ...onlyInB, ...contentDiffers, ...integrityDiffers];
  return Object.freeze({
    identical: differing.length === 0,
    onlyInA: Object.freeze(onlyInA),
    onlyInB: Object.freeze(onlyInB),
    contentDiffers: Object.freeze(contentDiffers),
    integrityDiffers: Object.freeze(integrityDiffers),
    classification: differing.length === 0 ? 'IDENTICAL' : 'CLOSURE_DIFFERS',
  });
}

// CLI: `node lab/closure-attest.mjs <installRoot> [lockfile]` -> JSON on stdout. Read-only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, lockfile = 'pnpm-lock.yaml'] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node lab/closure-attest.mjs <installRoot> [lockfile]');
    process.exit(2);
  }
  console.log(JSON.stringify(attestProdClosure(dir, { lockfile }), null, 2));
}
