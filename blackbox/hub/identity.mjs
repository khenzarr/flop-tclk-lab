import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { initializeCanonicalLocalIdentity } from '../airlock/detached-bridge.mjs';
import { canonicalMessage, publicKeyFromDidKey, verifyEd25519 } from '../airlock/signer.mjs';
import { HUB_ROOT, PROFILES, listSessions } from './session.mjs';

export const IDENTITY_PROVIDERS = Object.freeze({
  BLACKBOX_NATIVE: 'BLACKBOX_NATIVE',
  EXISTING_TECHNOCORE: 'EXISTING_TECHNOCORE',
  EXISTING_BLACKBOX_PROFILE: 'EXISTING_BLACKBOX_PROFILE',
});
export const IDENTITY_STATUSES = Object.freeze({
  NO_IDENTITY: 'NO_IDENTITY',
  IDENTITY_DISCOVERED: 'IDENTITY_DISCOVERED',
  IDENTITY_READY: 'IDENTITY_READY',
  IDENTITY_LOCKED: 'IDENTITY_LOCKED',
  SIGNER_UNAVAILABLE: 'SIGNER_UNAVAILABLE',
  IDENTITY_NEEDS_LOCAL_APPROVAL: 'IDENTITY_NEEDS_LOCAL_APPROVAL',
  MULTIPLE_IDENTITIES_FOUND: 'MULTIPLE_IDENTITIES_FOUND',
});

const MARKER_SCHEMA = 'technocore-local-install-v1';
const PRIMARY_SCHEMA = 'tclk-blackbox/primary-identity/v1';
const CREATION_SCHEMA = 'tclk-blackbox/identity-creation/v1';
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function defaultIdentityRoot() {
  if (!process.env.LOCALAPPDATA) return null;
  return resolve(process.env.LOCALAPPDATA, 'TechnocoreAgent');
}

function publicDescriptor(identity, primaryDid) {
  return Object.freeze({
    did: identity.did,
    fingerprint: sha256(identity.did),
    provider: identity.provider,
    providers: Object.freeze([...identity.providers]),
    custodyMode: 'LOCAL',
    signerAvailable: identity.signerAvailable,
    displayName: identity.displayName,
    isPrimary: identity.did === primaryDid,
    status: identity.status,
  });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function regularFile(path) {
  try { const value = await lstat(path); return value.isFile() && !value.isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function regularDirectory(path) {
  try { const value = await lstat(path); return value.isDirectory() && !value.isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function candidate(root, profileId, provider, nativeDid) {
  if (!(await regularDirectory(root))) return null;
  const markerPath = resolve(root, 'local-install.json');
  if (!(await regularFile(markerPath))) return null;
  const marker = await readJson(markerPath);
  if (marker?.schema !== MARKER_SCHEMA || typeof marker.public_did !== 'string') return null;
  try { publicKeyFromDidKey(marker.public_did); } catch { return null; }
  const keyPresent = await regularFile(resolve(root, 'identity.dpapi'));
  const operatorPresent = await regularFile(resolve(root, 'operator.json'));
  const signerAvailable = keyPresent && operatorPresent;
  const status = signerAvailable ? IDENTITY_STATUSES.IDENTITY_READY
    : keyPresent ? IDENTITY_STATUSES.IDENTITY_LOCKED : IDENTITY_STATUSES.SIGNER_UNAVAILABLE;
  return {
    did: marker.public_did,
    profileId,
    provider: nativeDid === marker.public_did ? IDENTITY_PROVIDERS.BLACKBOX_NATIVE : provider,
    providers: [provider],
    displayName: profileId === 'default' ? 'My agent identity' : profileId,
    signerAvailable,
    status,
  };
}

export class IdentityManager {
  constructor({ root = HUB_ROOT, identityRoot = defaultIdentityRoot(), now = () => Date.now(), random = randomBytes,
    creator = initializeCanonicalLocalIdentity, approval = promptIdentityCreation } = {}) {
    this.root = root; this.identityRoot = identityRoot; this.now = now; this.random = random; this.creator = creator; this.approval = approval;
  }

  async discover() {
    const primaryRecord = await readJson(resolve(this.root, 'identity-primary.json'));
    const nativeRecord = await readJson(resolve(this.root, 'identity-native.json'));
    const found = [];
    if (this.identityRoot) {
      const main = await candidate(this.identityRoot, 'default', IDENTITY_PROVIDERS.EXISTING_TECHNOCORE, nativeRecord?.did);
      if (main) found.push(main);
      const profilesRoot = resolve(this.identityRoot, 'identities');
      let entries = [];
      try { entries = await readdir(profilesRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && PROFILE_NAME.test(entry.name)) {
        const item = await candidate(resolve(profilesRoot, entry.name), entry.name, IDENTITY_PROVIDERS.EXISTING_BLACKBOX_PROFILE, nativeRecord?.did);
        if (item) found.push(item);
      }
    }
    const deduped = new Map();
    for (const item of found) {
      const current = deduped.get(item.did);
      if (!current) deduped.set(item.did, item);
      else {
        current.providers = [...new Set([...current.providers, ...item.providers])];
        current.signerAvailable ||= item.signerAvailable;
        if (item.profileId === 'default') current.profileId = 'default';
        if (item.provider === IDENTITY_PROVIDERS.BLACKBOX_NATIVE) current.provider = item.provider;
      }
    }
    const identities = [...deduped.values()];
    let primaryDid = identities.some(item => item.did === primaryRecord?.did) ? primaryRecord.did : null;
    if (!primaryDid && identities.length === 1) primaryDid = identities[0].did;
    if (!primaryDid) {
      const configuredDefault = PROFILES.find(profile => profile.id === 'default');
      if (configuredDefault && identities.some(item => item.did === configuredDefault.did)) primaryDid = configuredDefault.did;
    }
    const status = identities.length === 0 ? IDENTITY_STATUSES.NO_IDENTITY
      : identities.length > 1 && !primaryDid ? IDENTITY_STATUSES.MULTIPLE_IDENTITIES_FOUND
        : identities.find(item => item.did === primaryDid)?.status ?? IDENTITY_STATUSES.IDENTITY_DISCOVERED;
    return Object.freeze({
      status,
      identityCount: identities.length,
      primaryDid,
      identities: Object.freeze(identities.map(item => publicDescriptor(item, primaryDid))),
    });
  }

  async selectPrimary(did) {
    const state = await this.discover();
    if (!state.identities.some(identity => identity.did === did)) throw new Error('IDENTITY_NOT_DISCOVERED');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(resolve(this.root, 'identity-primary.json'), `${JSON.stringify({ schema: PRIMARY_SCHEMA, did }, null, 2)}\n`, { mode: 0o600 });
    return this.discover();
  }

  async prepareCreation() {
    const state = await this.discover();
    if (state.identityCount > 0) throw new Error('EXISTING_IDENTITY_MUST_BE_REUSED');
    const actionId = `identity-create-${this.random(8).toString('hex')}`;
    const record = { schema: CREATION_SCHEMA, actionId, status: IDENTITY_STATUSES.IDENTITY_NEEDS_LOCAL_APPROVAL, createdAt: new Date(this.now()).toISOString() };
    await mkdir(resolve(this.root, 'identity-actions'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(this.root, 'identity-actions', `${actionId}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return Object.freeze(record);
  }

  async executeCreation(actionId) {
    if (!/^identity-create-[0-9a-f]{16}$/.test(actionId)) throw new Error('IDENTITY_ACTION_INVALID');
    const actionPath = resolve(this.root, 'identity-actions', `${actionId}.json`);
    const action = await readJson(actionPath);
    if (action?.schema !== CREATION_SCHEMA || action.status !== IDENTITY_STATUSES.IDENTITY_NEEDS_LOCAL_APPROVAL) throw new Error('IDENTITY_ACTION_NOT_AVAILABLE');
    if ((await this.discover()).identityCount > 0) throw new Error('EXISTING_IDENTITY_MUST_BE_REUSED');
    if (!(await this.approval(actionId))) throw new Error('IDENTITY_CREATION_NOT_APPROVED');
    const did = await this.creator({ stateRoot: this.identityRoot });
    publicKeyFromDidKey(did);
    await writeFile(resolve(this.root, 'identity-native.json'), `${JSON.stringify({ schema: 'tclk-blackbox/native-identity/v1', did }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(actionPath, `${JSON.stringify({ ...action, status: 'COMPLETE', completedAt: new Date(this.now()).toISOString(), didFingerprint: sha256(did) }, null, 2)}\n`, { mode: 0o600 });
    return this.selectPrimary(did);
  }

  async linkExisting() { return this.discover(); }

  async dealProfiles() {
    const state = await this.discover();
    const discovered = state.identities.map(identity => {
      const known = PROFILES.find(profile => profile.did === identity.did);
      return { id: known?.id ?? `identity-${identity.fingerprint.slice(0, 12)}`, label: identity.isPrimary ? 'Agent A / Me' : identity.displayName, did: identity.did };
    });
    for (const profile of PROFILES) if (!discovered.some(item => item.did === profile.did)) discovered.push(profile);
    return Object.freeze(discovered);
  }

  async activity() {
    const state = await this.discover();
    const dids = new Set(state.identities.map(identity => identity.did));
    const deals = await listSessions({ root: this.root });
    const records = deals.filter(deal => deal.finalized && [deal.profiles?.agentA?.did, deal.profiles?.agentB?.did].some(did => dids.has(did))).slice(0, 8)
      .map(deal => ({ sessionId: deal.id, createdAt: deal.createdAt, room: deal.deal.dealRoom, complete: deal.finalized, venueOrigin: deal.venueOrigin }));
    const signedActivity = deals.flatMap(deal => deal.operations.filter(operation => operation.kind === 'signed' && operation.evidence?.classification === 'OBSERVED_PUBLIC'
      && dids.has(operation.evidence.did)).map(operation => ({ sessionId: deal.id, step: operation.step, did: operation.evidence.did,
        room: deal.deal.dealRoom, publicSeq: operation.evidence.publicSeq, publicTimestamp: operation.evidence.publicTimestamp }))).slice(0, 24);
    const rooms = [...new Set(signedActivity.map(item => item.room))];
    return Object.freeze({ venueOrigin: 'https://technocore-chat-production.up.railway.app', readOnly: true, identities: state.identities, rooms, signedActivity, recentVerifiedRecords: records,
      contribution: { available: true, mode: 'LOCAL_PROVIDER_SEPARATE_APPROVAL_REQUIRED', writeEnabled: false } });
  }
}

export async function promptIdentityCreation(actionId, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (stdin?.isTTY !== true || stdout?.isTTY !== true) throw new Error('INTERACTIVE_TTY_REQUIRED');
  const phrase = `CREATE IDENTITY ONCE ${actionId.slice(-4).toUpperCase()}`;
  stdout.write(`\nIdentity creation stays local. Type exactly: ${phrase}\nApproval (blank cancels): `);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try { const entered = await new Promise(resolveLine => rl.once('line', line => resolveLine(line.trim()))); return entered === phrase; }
  finally { rl.close(); }
}

export function verifyPublicSignature({ did, room, nonce, message, signature }) {
  if (typeof nonce !== 'string' || !/^[1-9][0-9]{0,18}$/.test(nonce)) throw new Error('NONCE_MUST_BE_DECIMAL_STRING');
  if (![did, room, message, signature].every(value => typeof value === 'string') || message.length > 4096 || signature.length > 256) throw new Error('VERIFICATION_INPUT_INVALID');
  const value = Number(nonce); if (!Number.isSafeInteger(value)) throw new Error('NONCE_OUT_OF_SAFE_RANGE');
  return verifyEd25519(did, canonicalMessage(room, value, message), signature);
}
