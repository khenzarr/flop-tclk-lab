import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tclk } from '../../lab/upstream.mjs';

export const HUB_SESSION_SCHEMA = 'tclk-blackbox/deal-session/v1';
export const HUB_ROOT = resolve('blackbox/state/deal-hub');
export const DEFAULT_VENUE = 'https://technocore-chat-production.up.railway.app';
export const OPERATION_STEPS = Object.freeze(['OFFER', 'ACCEPT', 'LOCK', 'RAIL_LOCK', 'REVEAL', 'RAIL_CLAIM']);
export const PROFILES = Object.freeze([
  { id: 'default', label: 'Agent A · payer / lock', did: 'did:key:z6MknGqyhtD6cq2HwwWypgrsFyfXHLq4xuGVD845wzDDPTqi' },
  { id: 'phase3b-counterparty-b', label: 'Agent B · payee / reveal', did: 'did:key:z6MkoetPhd5Aa1pKFCR2a8SinCWaL64U7ytcPP6zg5pnnDoW' },
]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const frameHash = frame => sha256(tclk.encodeFrame(frame));
const statePath = (root, id) => resolve(root, 'sessions', id, 'session.json');
const secretPath = (root, id) => resolve(root, 'sessions', id, 'secret.json');

function safeInput(value, name, pattern, max) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value;
}

function publicOperation(operation) {
  const { frame, ...safe } = operation;
  return safe;
}

export function publicSession(session) {
  return Object.freeze({
    schema: 'tclk-blackbox/public-deal-session/v1', id: session.id, mode: session.mode,
    simulated: session.simulated, label: session.simulated ? 'SIMULATED / LOCAL TEST' : 'LOCAL REAL EXECUTION',
    createdAt: session.createdAt, venueOrigin: session.venueOrigin, operatorModel: session.operatorModel,
    manifestRoot: session.manifestRoot, deal: session.deal, profiles: session.profiles,
    operations: session.operations.map(publicOperation), finalized: session.finalized,
    publicCapsule: session.publicCapsule ?? null,
  });
}

export async function saveSession(session, { root = HUB_ROOT } = {}) {
  const path = statePath(root, session.id); await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 }); return session;
}

export async function readSession(id, { root = HUB_ROOT } = {}) {
  if (!/^bbx-[0-9a-f]{16}$/.test(id)) throw new Error('INVALID_SESSION_ID');
  return JSON.parse(await readFile(statePath(root, id), 'utf8'));
}

export async function readSecret(id, { root = HUB_ROOT } = {}) {
  const value = JSON.parse(await readFile(secretPath(root, id), 'utf8'));
  if (!/^0x[0-9a-f]{64}$/.test(value.secret)) throw new Error('DEAL_SECRET_STATE_INVALID');
  return value.secret;
}

export async function readCompletedPublicRecord(id, { root = HUB_ROOT } = {}) {
  const session = await readSession(id, { root });
  if (session.finalized !== true || session.publicCapsule?.complete !== true
    || session.publicCapsule.sessionId !== id || session.operations.some(item => item.state !== 'COMPLETE')) {
    throw Object.assign(new Error('FLIGHT_RECORD_NOT_FINALIZED'), { status: 409 });
  }
  return Object.freeze({ source: 'LOCAL_BLACKBOX_CONNECTOR', readOnly: true, requiresLocalConnector: true, record: session.publicCapsule });
}

export async function listSessions({ root = HUB_ROOT } = {}) {
  let entries; try { entries = await readdir(resolve(root, 'sessions'), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = [];
  for (const entry of entries) if (entry.isDirectory() && /^bbx-[0-9a-f]{16}$/.test(entry.name)) sessions.push(publicSession(await readSession(entry.name, { root })));
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createDealSession({ amount, asset, profileA = 'default', profileB = 'phase3b-counterparty-b',
  venueOrigin = DEFAULT_VENUE, mode = 'real' } = {}, { root = HUB_ROOT, now = () => Date.now(), random = randomBytes } = {}) {
  const normalizedAmount = safeInput(amount, 'amount', /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,8})?$/, 27);
  const normalizedAsset = safeInput(asset, 'asset', /^[A-Z][A-Z0-9._-]{1,15}$/, 16);
  const a = PROFILES.find(profile => profile.id === profileA); const b = PROFILES.find(profile => profile.id === profileB);
  if (!a || !b || a.did === b.did) throw new Error('TWO_DISTINCT_LOCAL_PROFILES_REQUIRED');
  if (venueOrigin !== DEFAULT_VENUE) throw new Error('VENUE_NOT_ALLOWED_V1');
  const createdAtMs = now(); const createdAt = new Date(createdAtMs).toISOString();
  const secret = `0x${random(32).toString('hex')}`; const id = `bbx-${random(8).toString('hex')}`;
  const derived = label => sha256(Buffer.concat([Buffer.from(label), Buffer.from(secret.slice(2), 'hex')])).slice(0, 16);
  const offer = tclk.makeOffer({ from: a.did, role: 'payer', amount: normalizedAmount, asset: normalizedAsset, lock: 'hash', rails: ['paper'],
    claimByMs: createdAtMs + 600000, refundAfterMs: createdAtMs + 3600000, expiresMs: createdAtMs + 7200000, nonce: derived(`${id}-offer`) });
  const lock = tclk.hashLockFromPreimage(secret);
  const accept = tclk.makeAccept(offer, { from: b.did, ref: offer.id, statement: lock.hash, nonce: derived(`${id}-accept`) });
  const contract = accept.contract; const room = tclk.dealRoom(contract);
  const lockFrame = { type: 'lock', from: a.did, contract, rail: 'paper', ref: `paper-${id.slice(4)}` };
  const revealFrame = { type: 'reveal', from: b.did, contract, secret: '<LOCAL_SECRET_AT_EXECUTION>' };
  const notes = new tclk.MemoryNoteStore(); const rail = new tclk.PaperRail(notes, () => createdAtMs);
  const paperRef = await rail.lock({ contract, lock: 'hash', statement: lock.hash, amount: offer.amount, asset: offer.asset,
    payer: a.did, payee: b.did, claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs });
  const note = tclk.paperNote(paperRef); const lockCommitment = sha256(tclk.canonicalJson(await notes.get(note.ns, note.key)));
  await rail.claim(paperRef, secret); const claimCommitment = sha256(tclk.canonicalJson(await notes.get(note.ns, note.key)));
  if (lockCommitment === claimCommitment) throw new Error('RAIL_COMMITMENTS_MUST_DIFFER');
  const frames = [offer, accept, lockFrame, null, revealFrame, null];
  const operations = OPERATION_STEPS.map((step, index) => ({
    id: `${id}-write-${[1, 2, 3, 5, 4, 6][index]}`, ordinal: index + 1, step,
    actor: index === 0 || index === 2 ? 'Agent A' : index === 1 || index === 4 ? 'Agent B' : 'BLACKBOX',
    kind: step.startsWith('RAIL_') ? 'rail' : 'signed', state: index === 0 ? 'READY' : 'BLOCKED', attempts: [],
    ...(frames[index] ? { frame: frames[index], frameSha256: frameHash(index === 4 ? { ...revealFrame, secret } : frames[index]) } : {}),
  }));
  const core = {
    schema: HUB_SESSION_SCHEMA, id, mode: mode === 'simulated' ? 'SIMULATED_LOCAL_TEST' : 'LOCAL_REAL_EXECUTION', simulated: mode === 'simulated',
    createdAt, venueOrigin, operatorModel: 'ONE_HUMAN_OPERATOR_TWO_DISTINCT_CRYPTOGRAPHIC_DIDS',
    deal: { amount: normalizedAmount, asset: normalizedAsset, contractId: contract, offerId: offer.id, dealRoom: room,
      dealCommitment: lock.hash, claimByMs: offer.claimByMs, refundAfterMs: offer.refundAfterMs,
      paperRail: { namespace: note.ns, key: note.key, lockCommitment, claimCommitment, valueMoved: false } },
    profiles: { agentA: { id: a.id, did: a.did }, agentB: { id: b.id, did: b.did } }, operations, finalized: false,
  };
  core.manifestRoot = sha256(JSON.stringify(core));
  await mkdir(resolve(root, 'sessions'), { recursive: true, mode: 0o700 });
  const directory = resolve(root, 'sessions', id); await mkdir(directory, { recursive: false, mode: 0o700 });
  await writeFile(secretPath(root, id), `${JSON.stringify({ schema: 'tclk-blackbox/deal-secret/v1', secret })}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(statePath(root, id), `${JSON.stringify(core, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return publicSession(core);
}
