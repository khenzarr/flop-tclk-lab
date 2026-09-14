import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, requireNonce } from './canonical.mjs';

const locks = new Map();
async function locked(key, action) {
  const prior = locks.get(key) ?? Promise.resolve(); let release;
  const next = new Promise(resolveLock => { release = resolveLock; }); locks.set(key, prior.then(() => next));
  await prior; try { return await action(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('W2_DURABLE_STATE_CORRUPT'); }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: 'wx', mode: 0o600 });
  const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  try { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
}

export class DurableW2Store {
  constructor(root) { this.root = resolve(root, 'workloads', 'w2'); this.noncePath = resolve(this.root, 'nonce-reservations.json'); }
  operationPath(id) { if (!/^w2op1-[0-9a-f]{64}$/.test(id)) throw new Error('W2_OPERATION_ID_INVALID'); return resolve(this.root, 'operations', `${id}.json`); }

  async reserveNonce({ requestId, lane, floor = '0' }) {
    if (!/^w2draft1-[0-9a-f]{64}$/.test(requestId) || typeof lane !== 'string' || !lane || lane.includes('|')) throw new Error('NONCE_RESERVATION_INVALID');
    requireNonce(floor);
    return locked(this.noncePath, async () => {
      const state = await readJson(this.noncePath, { schema: 'blackbox/w2-nonce-store/v1', counters: {}, requests: {} });
      if (state.schema !== 'blackbox/w2-nonce-store/v1' || typeof state.counters !== 'object' || typeof state.requests !== 'object') throw new Error('W2_NONCE_STORE_CORRUPT');
      const old = state.requests[requestId];
      if (old) { if (old.lane !== lane) throw new Error('NONCE_REQUEST_CONFLICT'); return Object.freeze({ ...old }); }
      const current = state.counters[lane] ?? '0'; requireNonce(current); const high = BigInt(current) > BigInt(floor) ? BigInt(current) : BigInt(floor);
      const next = high + 1n; if (next >= 10n ** 19n) throw new Error('NONCE_EXHAUSTED');
      const reservation = { lane, nonce: next.toString(), requestId, status: 'BURNED' };
      state.counters[lane] = reservation.nonce; state.requests[requestId] = reservation; await atomicJson(this.noncePath, state);
      return Object.freeze({ ...reservation });
    });
  }

  async create(operation) {
    const path = this.operationPath(operation.operationId);
    return locked(path, async () => {
      const old = await readJson(path, null);
      if (old) { if (canonicalJson(old.binding) !== canonicalJson(operation.binding)) throw new Error('DUPLICATE_OPERATION_CONFLICT'); return old; }
      const state = { schema: 'blackbox/w2-operation-ledger/v1', ...operation, events: [{ type: 'NONCE_RESERVED', at: operation.createdAt }], signBudget: 'AVAILABLE', submitBudget: 'AVAILABLE', state: 'APPROVAL_PENDING' };
      await atomicJson(path, state); return state;
    });
  }

  async read(operationId) { const state = await readJson(this.operationPath(operationId), null); if (!state) throw new Error('W2_OPERATION_NOT_FOUND'); return state; }

  async update(operationId, mutate) {
    const path = this.operationPath(operationId);
    return locked(path, async () => { const state = await readJson(path, null); if (!state) throw new Error('W2_OPERATION_NOT_FOUND'); const next = await mutate(structuredClone(state)); if (next === null) return state; await atomicJson(path, next); return next; });
  }
}

export const durableAtomicJson = atomicJson;
