// PHASE 3B.1-R2 — complete executable-runtime attestation and post-gate manifest freeze.
// Offline fixtures only: no custody, signer, nonce store, transport, network or public write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { attestRuntime, loadAttestedRuntime } from '../../lab/runtime-attest.mjs';
import { runtimeAttestation, runtimeIdentity } from '../../lab/upstream.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const at = (...parts) => resolve(REPO, ...parts);
const reviewed = JSON.parse(readFileSync(at('evidence', 'upstream-baseline.json'), 'utf8')).runtimeAttestation;
const manifest = JSON.parse(readFileSync(at('evidence', 'phase3b-exact-manifest.json'), 'utf8'));
const fixture = at('.upstream', 'tclk');

const withRuntimeCopy = fn => {
  const root = mkdtempSync(resolve(tmpdir(), 'blackbox-runtime-negative-'));
  try {
    cpSync(resolve(fixture, 'package.json'), resolve(root, 'package.json'));
    cpSync(resolve(fixture, 'pnpm-lock.yaml'), resolve(root, 'pnpm-lock.yaml'));
    cpSync(resolve(fixture, 'dist'), resolve(root, 'dist'), { recursive: true });
    mkdirSync(resolve(root, '.git'));
    writeFileSync(resolve(root, '.git', 'HEAD'), `${reviewed.sourceCommit}\n`);
    for (const name of reviewed.productionDependencyClosure.rootDependencies) {
      const parts = name.split('/');
      const target = resolve(root, 'node_modules', ...parts);
      mkdirSync(resolve(target, '..'), { recursive: true });
      cpSync(resolve(fixture, 'node_modules', ...parts), target, { recursive: true, dereference: true });
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('promoted runtime binds source, lockfile, dist, production closure and actual import', () => {
  assert.equal(runtimeAttestation, 'PASS');
  assert.deepEqual(runtimeIdentity, {
    runtimeAttestation: 'PASS',
    algorithm: 'blackbox-tclk-runtime-v1',
    sourceCommit: reviewed.sourceCommit,
    lockfileSha256: reviewed.lockfile.sha256,
    distTreeSha256: reviewed.dist.sha256,
    prodClosureSha256: reviewed.productionDependencyClosure.sha256,
    distFileCount: reviewed.dist.fileCount,
    closurePackageCount: reviewed.productionDependencyClosure.packageCount,
    entrypoint: 'index.js',
  });
});

test('every static mismatch refuses before importer invocation', async () => {
  for (const [leg, mutate] of [
    ['source', r => ({ ...r, sourceCommit: '0'.repeat(40) })],
    ['lockfile', r => ({ ...r, lockfile: { ...r.lockfile, sha256: '0'.repeat(64) } })],
    ['dist', r => ({ ...r, dist: { ...r.dist, sha256: '0'.repeat(64) } })],
    ['closure', r => ({ ...r, productionDependencyClosure: { ...r.productionDependencyClosure, sha256: '0'.repeat(64) } })],
  ]) {
    let calls = 0;
    const result = await loadAttestedRuntime(at('.upstream', 'tclk'), mutate(reviewed), { importer: async () => { calls += 1; return {}; } });
    assert.equal(result.runtimeAttestation, 'REFUSED', leg);
    assert.equal(result.runtimeImport, 'NOT_ATTEMPTED', leg);
    assert.equal(calls, 0, leg);
    assert.equal(result.module, null, leg);
  }
});

test('tampered dist and installed dependency content are independently detected', () => withRuntimeCopy(root => {
  const distFile = resolve(root, 'dist', 'index.js');
  writeFileSync(distFile, `${readFileSync(distFile, 'utf8')}\n// negative control\n`);
  let report = attestRuntime(root, reviewed);
  assert.equal(report.distTreeSha.status, 'FAIL');
  assert.equal(report.verdict, 'REFUSED');

  cpSync(resolve(fixture, 'dist'), resolve(root, 'dist'), { recursive: true, force: true });
  const dep = resolve(root, 'node_modules', '@scure', 'base', 'index.js');
  writeFileSync(dep, `${readFileSync(dep, 'utf8')}\n// negative control\n`);
  report = attestRuntime(root, reviewed);
  assert.equal(report.distTreeSha.status, 'PASS');
  assert.equal(report.prodClosureSha.status, 'FAIL');
  assert.equal(report.verdict, 'REFUSED');
}));

test('an attested identity still refuses an import exception or missing protocol exports', async () => {
  const importFailure = await loadAttestedRuntime(at('.upstream', 'tclk'), reviewed, { importer: async () => { throw new Error('fixture import failure'); } });
  assert.equal(importFailure.runtimeImport, 'FAIL');
  assert.equal(importFailure.runtimeAttestation, 'REFUSED');
  assert.match(importFailure.importError, /fixture import failure/);

  const surfaceFailure = await loadAttestedRuntime(at('.upstream', 'tclk'), reviewed, { importer: async () => ({ TCLK_VERSION: '1' }) });
  assert.equal(surfaceFailure.runtimeImport, 'FAIL');
  assert.ok(surfaceFailure.missingExports.includes('applyFrame'));
  assert.equal(surfaceFailure.module, null);
});

test('protocol consumers have one runtime import door', () => {
  const hits = [];
  for (const dir of ['blackbox', 'lab']) {
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:mjs|js)$/.test(entry.name)) {
          const text = readFileSync(child, 'utf8');
          const imports = text.matchAll(/\bimport\s*\(\s*([^\n)]+)\s*\)/g);
          if ([...imports].some(match => /(?:\.upstream[\\/]tclk|DIST_IN_USE)/.test(match[1]))) hits.push(child);
        }
      }
    };
    walk(at(dir));
  }
  assert.deepEqual(hits.map(path => path.slice(REPO.length + 1).replaceAll('\\', '/')), ['lab/upstream.mjs']);
});

test('frozen manifest derives from attested runtime and remains inert', () => {
  assert.equal(manifest.frozen, true);
  assert.equal(manifest.provenance.runtimeAttestation, 'PASS');
  assert.equal(manifest.provenance.sourceSha, reviewed.sourceCommit);
  assert.equal(manifest.provenance.lockfileSha256, reviewed.lockfile.sha256);
  assert.equal(manifest.provenance.distTreeSha256, reviewed.dist.sha256);
  assert.equal(manifest.provenance.productionClosureSha256, reviewed.productionDependencyClosure.sha256);
  assert.deepEqual(manifest.fixtureReplay.trajectory, ['proposed', 'accepted', 'locked', 'claimed']);
  assert.equal(manifest.frameSet.signedRoomWrites, 4);
  assert.equal(manifest.frameSet.unsignedPaperRailNoteWrites, 2);
  assert.equal(manifest.frameSet.totalPublicWrites, 6);
  assert.deepEqual(manifest.frameSet.paperRailWrites.map(write => write.operation), ['lock', 'claim']);
  for (const write of manifest.frameSet.paperRailWrites) {
    assert.equal(write.signed, false);
    assert.equal(write.worldWritable, true);
    assert.equal(write.authorshipProof, 'NONE');
    assert.equal(write.evidenceClass, 'UNSIGNED_RAIL_OBSERVATION');
    assert.equal(write.valueMoved, false);
  }
  assert.equal(manifest.safety.realCanonicalKeyAccessed, false);
  assert.equal(manifest.safety.realSignaturePerformed, false);
  assert.equal(manifest.safety.realNonceConsumed, false);
  assert.equal(manifest.safety.networkCalls, 0);
  assert.equal(manifest.safety.technocoreReads, 0);
  assert.equal(manifest.safety.technocoreWrites, 0);
  assert.equal(manifest.safety.publicActions, 0);
  assert.equal(manifest.safety.secretsInArtifact, false);
  assert.equal(JSON.stringify(manifest).includes('abababab'), false);
});