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
 * Usage:
 *   node lab/identity-fingerprint.mjs --root <stateRoot> [--label NAME] [--save FILE]
 *   node lab/identity-fingerprint.mjs --compare FILE
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Files whose integrity Phase 3B.C1 must prove, in stable order. */
export const TRACKED_FILES = Object.freeze([
  'identity.dpapi',
  'local-install.json',
  'nonces.json',
  'operator.json'
]);

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
