#!/usr/bin/env node
/**
 * Phase 3B.C1 — safe custody-identity fingerprint.
 *
 * Reads ONLY public metadata and opaque ciphertext digests from a canonical
 * local-agent state root:
 *
 *   - `identity.dpapi` is hashed as opaque ciphertext. It is NEVER unprotected,
 *     never decrypted, never parsed. DPAPI `protect()` is randomized, so any
 *     rewrite of a blob changes its ciphertext digest — which is exactly the
 *     mutation this tool must detect.
 *   - `operator.json` is hashed only. Its verifier material is never printed.
 *   - `local-install.json` contributes its public `public_did` field, which the
 *     canonical installer writes as public metadata.
 *   - `nonces.json` is hashed only, to prove no nonce state moved.
 *
 * No private key, seed, passphrase or DPAPI plaintext is read, derived,
 * exported or printed. No signing. No nonce mutation. No network. No transport.
 *
 * Phase 3B.C1b extends this with named-profile verification and a two-identity
 * comparison. Both remain metadata-only: existence, the public DID, the opaque
 * ciphertext digest, nonce-ledger presence and signing-artifact presence. The
 * protected blob is still never unprotected, and no private-key bytes are ever
 * compared — distinctness is proved from public DIDs and opaque digests alone.
 *
 * Usage:
 *   node lab/identity-fingerprint.mjs --root <stateRoot> [--label NAME] [--save FILE]
 *   node lab/identity-fingerprint.mjs --compare FILE
 *   node lab/identity-fingerprint.mjs --profile <name> [--expect-did DID] [--expect-fingerprint HEX]
 *   node lab/identity-fingerprint.mjs --profile <name> --pair
 */


import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';


/** Files whose integrity Phase 3B.C1 must prove, in stable order. */
export const TRACKED_FILES = Object.freeze([
  'identity.dpapi',
  'local-install.json',
  'nonces.json',
  'operator.json'
]);

/**
 * Files the canonical agent writes only as a consequence of signing, drafting,
 * approving or submitting. Enrollment alone must create none of them, so their
 * absence is the metadata-only proof that no operation artifact exists.
 */
export const SIGNING_ARTIFACT_FILES = Object.freeze([
  'operations.json',
  'drafts.json',
  'approvals.json',
  'evidence.jsonl'
]);

/** Reviewed parent namespace for additional named profiles (Phase 3B.C1a). */
export const PROFILE_PARENT_DIRNAME = 'identities';


export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestFile(path) {
  const bytes = readFileSync(path);
  const stats = statSync(path);
  return { sha256: sha256Hex(bytes), bytes: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) };
}

/** Default canonical state root for the primary local identity (DID A). */
export function defaultStateRoot() {
  const base = process.env.LOCALAPPDATA;
  if (!base) throw new Error('REFUSE: LOCALAPPDATA is unavailable');
  return resolve(base, 'TechnocoreAgent');
}

export function fingerprintRoot(root, label = null) {
  const abs = resolve(root);
  if (!existsSync(abs)) {
    return { label, root: abs, present: false, entries: [], files: {}, publicDid: null, publicDidSha256: null, markerSchema: null };
  }
  const entries = readdirSync(abs).sort();
  const files = {};
  for (const name of TRACKED_FILES) {
    const target = join(abs, name);
    files[name] = existsSync(target) ? digestFile(target) : null;
  }
  let publicDid = null;
  let markerSchema = null;
  const marker = join(abs, 'local-install.json');
  if (existsSync(marker)) {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    if (typeof parsed.public_did === 'string') publicDid = parsed.public_did;
    if (typeof parsed.schema === 'string') markerSchema = parsed.schema;
  }
  return {
    label,
    root: abs,
    present: true,
    entries,
    files,
    publicDid,
    publicDidSha256: publicDid ? sha256Hex(publicDid) : null,
    markerSchema
  };
}

/** Compare only integrity-relevant fields; `entries` may legitimately grow. */
function integrityView(snapshot) {
  return JSON.stringify({ files: snapshot.files, publicDid: snapshot.publicDid, markerSchema: snapshot.markerSchema });
}

export function compareSnapshots(before, after) {
  const changed = [];
  for (const name of TRACKED_FILES) {
    const a = before.files?.[name] ?? null;
    const b = after.files?.[name] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(name);
  }
  return {
    unchanged: integrityView(before) === integrityView(after) && before.root === after.root,
    changedFiles: changed,
    didStable: before.publicDid === after.publicDid
  };
}

/**
 * Reviewed named-profile state root: `<LOCALAPPDATA>/TechnocoreAgent/identities/<profile>`.
 * The profile name is treated as a single path segment and is never allowed to
 * escape the parent namespace.
 */
export function profileStateRoot(profile, base = defaultStateRoot()) {
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(profile)) {
    throw new Error('REFUSE: profile name is not a reviewed single-segment name');
  }
  const parent = resolve(base, PROFILE_PARENT_DIRNAME);
  const root = resolve(parent, profile);
  if (!root.startsWith(parent + sep) || resolve(root, '..') !== parent) {
    throw new Error('REFUSE: derived profile root escapes the reviewed namespace');
  }
  return root;
}

/** Which artifact files exist in a root. Contents are never read. */
function presentArtifacts(root) {
  return SIGNING_ARTIFACT_FILES.filter(name => existsSync(join(resolve(root), name)));
}

/** Absolute paths of every custody file this tool knows about that exists in a root. */
function custodyFilePaths(root) {
  const abs = resolve(root);
  return [...TRACKED_FILES, ...SIGNING_ARTIFACT_FILES]
    .map(name => join(abs, name))
    .filter(path => existsSync(path));
}

/**
 * Verify one identity from public metadata only. `identity.dpapi` contributes an
 * opaque ciphertext digest and nothing else; it is never unprotected.
 *
 * Expectations are optional. When supplied they are compared, never trusted:
 * the fingerprint is recomputed locally from the observed public DID.
 */
export function verifyProfileIdentity({ root, label = null, expectDid = null, expectFingerprint = null }) {
  const snapshot = fingerprintRoot(root, label);
  const artifacts = snapshot.present ? presentArtifacts(snapshot.root) : [];
  const blob = snapshot.files['identity.dpapi'] ?? null;
  const didMatch = expectDid === null ? null : snapshot.publicDid === expectDid;
  const fingerprintMatch = expectFingerprint === null
    ? null
    : snapshot.publicDid !== null && sha256Hex(snapshot.publicDid) === expectFingerprint;
  const checks = [
    snapshot.present,
    snapshot.publicDid !== null,
    blob !== null,
    didMatch !== false,
    fingerprintMatch !== false
  ];
  return {
    label,
    root: snapshot.root,
    present: snapshot.present,
    entries: snapshot.entries,
    publicDid: snapshot.publicDid,
    publicDidSha256: snapshot.publicDidSha256,
    markerSchema: snapshot.markerSchema,
    protectedBlobPresent: blob !== null,
    protectedBlobSha256: blob?.sha256 ?? null,
    protectedBlobBytes: blob?.bytes ?? null,
    protectedBlobDecrypted: false,
    didMatch,
    fingerprintMatch,
    nonceLedger: snapshot.files['nonces.json'] ? 'PRESENT' : 'ABSENT',
    signingArtifacts: artifacts,
    verdict: checks.every(Boolean) ? 'PASS' : 'FAIL'
  };
}

/**
 * Compare two identities using public DIDs and opaque digests only. No
 * private-key bytes are read, derived or compared; `identity.dpapi` is
 * distinguished solely by its ciphertext digest.
 */
export function compareIdentities(a, b) {
  const pathsA = a.present ? custodyFilePaths(a.root) : [];
  const pathsB = b.present ? custodyFilePaths(b.root) : [];
  const setB = new Set(pathsB.map(path => path.toLowerCase()));
  const overlapping = pathsA.filter(path => setB.has(path.toLowerCase()));
  const rootA = resolve(a.root);
  const rootB = resolve(b.root);
  const distinctDid = Boolean(a.publicDid) && Boolean(b.publicDid) && a.publicDid !== b.publicDid;
  const distinctFingerprint = Boolean(a.publicDidSha256) && Boolean(b.publicDidSha256)
    && a.publicDidSha256 !== b.publicDidSha256;
  const distinctProtectedBlob = Boolean(a.protectedBlobSha256) && Boolean(b.protectedBlobSha256)
    && a.protectedBlobSha256 !== b.protectedBlobSha256;
  return {
    distinctRoot: rootA !== rootB,
    distinctDid,
    distinctFingerprint,
    distinctProtectedBlob,
    privateKeyBytesCompared: false,
    overlappingCustodyFiles: overlapping.length,
    separateNonceLedgers: !(a.nonceLedger === 'PRESENT' && b.nonceLedger === 'PRESENT'
      && overlapping.length > 0),
    storageSeparated: rootA !== rootB && overlapping.length === 0,
    verdict: distinctDid && distinctFingerprint && distinctProtectedBlob
      && rootA !== rootB && overlapping.length === 0 ? 'PASS' : 'FAIL'
  };
}

function parseArgs(argv) {

  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (typeof args.compare === 'string') {
    const before = JSON.parse(readFileSync(args.compare, 'utf8'));
    const after = fingerprintRoot(before.root, before.label);
    const verdict = compareSnapshots(before, after);
    for (const name of TRACKED_FILES) {
      const flag = verdict.changedFiles.includes(name) ? 'CHANGED' : 'OK';
      console.log(`${name} ${flag}`);
    }
    console.log(`PUBLIC_DID_STABLE=${verdict.didStable ? 'YES' : 'NO'}`);
    console.log(`UNCHANGED=${verdict.unchanged ? 'YES' : 'NO'}`);
    if (!verdict.unchanged) process.exitCode = 1;
    return;
  }

  if (typeof args.profile === 'string') {
    const expectDid = typeof args['expect-did'] === 'string' ? args['expect-did'] : null;
    const expectFingerprint = typeof args['expect-fingerprint'] === 'string'
      ? args['expect-fingerprint']
      : null;
    const b = verifyProfileIdentity({
      root: profileStateRoot(args.profile),
      label: args.profile,
      expectDid,
      expectFingerprint
    });
    const report = { profile: b };
    if (args.pair === true) {
      const a = verifyProfileIdentity({ root: defaultStateRoot(), label: 'default' });
      report.default = a;
      report.comparison = compareIdentities(a, b);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const failed = b.verdict !== 'PASS' || (report.comparison && report.comparison.verdict !== 'PASS');
    if (failed) process.exitCode = 1;
    return;
  }

  const root = typeof args.root === 'string' ? args.root : defaultStateRoot();
  const label = typeof args.label === 'string' ? args.label : null;
  const snapshot = fingerprintRoot(root, label);

  const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (typeof args.save === 'string') writeFileSync(args.save, rendered, { encoding: 'utf8' });
  process.stdout.write(rendered);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('identity-fingerprint.mjs')) {
  main();
}
