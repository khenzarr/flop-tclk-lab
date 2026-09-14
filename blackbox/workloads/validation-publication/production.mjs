import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireInteractiveOperatorTerminal } from '../../airlock/operator-approval.mjs';
import { numberLexeme, parseLosslessJson } from '../transcript-validation/json.mjs';
import { normalizeVenueOrigin, ROOM_PATTERN, sha256 } from './canonical.mjs';
import { W2TrustedCustody } from './custody-bridge.mjs';
import { W2PublicationService } from './service.mjs';
import { DurableW2Store } from './store.mjs';

async function terminalApproval({ candidate, approvalHash, expectedPhrase }) {
  requireInteractiveOperatorTerminal();
  process.stdout.write(`\nW2 exact human approval\n${JSON.stringify(candidate, null, 2)}\nApproval hash: ${approvalHash}\nType exactly: ${expectedPhrase}\nApproval: `);
  const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try { return await new Promise(resolveAnswer => {
    reader.once('SIGINT', () => resolveAnswer(null));
    reader.once('line', line => resolveAnswer(line));
  }); } finally { reader.close(); }
}

function exactEndpoint(origin, room, suffix) {
  const venue = normalizeVenueOrigin(origin);
  if (!ROOM_PATTERN.test(room)) throw new Error('W2_ROOM_INVALID');
  return `${venue}/r/${encodeURIComponent(room)}${suffix}`;
}

async function postedResponse(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 65536) return { posted: null, responseBodySha256: null };
  const responseBodySha256 = sha256(bytes);
  let body; try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { posted: null, responseBodySha256 }; }
  let parsed; try { parsed = parseLosslessJson(body); } catch { return { posted: null, responseBodySha256 }; }
  const posted = parsed?.posted;
  if (!posted || typeof posted !== 'object' || Array.isArray(posted)) return { posted: null, responseBodySha256 };
  return { posted: { did: posted.from, nonce: numberLexeme(posted.nonce), text: posted.text, sig: posted.sig }, responseBodySha256 };
}

export function createW2VenueAdapters(fetcher) {
  const transport = { async post({ endpoint, body }) {
    const target = new URL(endpoint);
    if (normalizeVenueOrigin(target.origin) !== target.origin || !/^\/r\/[a-z0-9_-]+$/.test(target.pathname)
      || target.search !== '?format=json') throw new Error('W2_SUBMIT_ENDPOINT_INVALID');
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error' });
    return { status: response.status, ...await postedResponse(response), diagnostic: `HTTP_${response.status}` };
  } };
  const observerFetch = async ({ venueOrigin, room }) => {
    const endpoint = exactEndpoint(venueOrigin, room, '/export');
    const response = await fetcher(endpoint, { method: 'GET', headers: { accept: 'application/x-ndjson' }, credentials: 'omit', redirect: 'error' });
    if (response.status !== 200) throw new Error('W2_EXPORT_READ_FAILED');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024) throw new Error('W2_EXPORT_TOO_LARGE');
    return { bytes, origin: normalizeVenueOrigin(new URL(response.url || endpoint).origin), generation: response.headers.get('x-room-generation') };
  };
  return { transport, observerFetch };
}

export function createProductionW2Service({ root, identities, fetcher = globalThis.fetch, now = () => Date.now() }) {
  const custody = new W2TrustedCustody({ identities });
  const { transport, observerFetch } = createW2VenueAdapters(fetcher);
  return new W2PublicationService({ store: new DurableW2Store(root), custody, transport, observerFetch,
    signApproval: terminalApproval, submitApproval: terminalApproval, now,
    readW1Record: async id => JSON.parse(await readFile(resolve(root, 'workloads', 'records', `${id}.json`), 'utf8')),
    submitBudgetRoot: resolve(root, 'workloads', 'w2', 'submit-attempt-budgets') });
}
