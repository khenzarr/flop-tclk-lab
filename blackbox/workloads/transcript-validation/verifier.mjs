import { createHash, verify as edVerify } from 'node:crypto';
import { publicKeyFromDidKey } from '../../airlock/signer.mjs';
import { numberLexeme, parseLosslessJson } from './json.mjs';
import { implementationDigest } from './pin.mjs';

export const MAX_INPUT_BYTES = 12 * 1024 * 1024;
export const MAX_RECORDS = 100000;
export const MAX_LINE_BYTES = 64 * 1024;
export const VERIFIER_ID = 'technocore-transcript-validation/v1';
export const CHECK_PROFILE = 'tc-export-signed-rows/v1';
export const TECHNOCORE_REF = '20a4457b89ba11254f4aa48217b066884a148d98';
const VERSION = '1.0.0';
const ROOM = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const NONCE = /^(?:0|[1-9][0-9]{0,18})$/;
const SEQ = /^(?:0|[1-9][0-9]*)$/;
const SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const UNSWEPT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?Z$/;
const CONTENT = ['JSONL_FORM', 'RECORD_SHAPE', 'DID_SHAPE', 'NONCE_EXACT', 'SIGNED_TEXT', 'SIGNATURE', 'OP_IDENTITY_UNIQUE', 'SEQ_ORDER'];
const COVERAGE = ['GENERATION_CONTEXT', 'SEQ_GAPS', 'TIMESTAMP_METADATA', 'RETENTION_LIMIT'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function workloadId(inputSha256) {
  if (!/^[0-9a-f]{64}$/.test(inputSha256)) throw new Error('INVALID_INPUT_HASH');
  const parts = [Buffer.from('blackbox:technocore-transcript-validation:v1')];
  for (const value of [inputSha256, VERIFIER_ID, CHECK_PROFILE]) {
    const bytes = Buffer.from(value); const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); parts.push(size, bytes);
  }
  return hash(Buffer.concat(parts));
}

class W1Error extends Error { constructor(category, code) { super(code); this.category = category; this.code = code; } }
const reject = code => { throw new W1Error('INPUT_REJECTED', code); };
const preflight = (bytes, room, generation, mediaType) => {
  if (!Buffer.isBuffer(bytes) || !ROOM.test(room ?? '') || (generation !== null && !/^(?:0|[1-9][0-9]*)$/.test(generation ?? ''))
    || !/^application\/x-ndjson(?:;\s*charset=utf-8)?$/i.test(mediaType)) reject('UNSUPPORTED_INPUT_ENVELOPE');
  if (bytes.length > MAX_INPUT_BYTES) reject('INPUT_TOO_LARGE');
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) reject('UNSUPPORTED_INPUT_ENVELOPE');
  let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { reject('INVALID_UTF8'); }
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 13 && bytes[index + 1] !== 10) reject('UNSUPPORTED_INPUT_ENVELOPE');
  let lines = 0; let start = 0; let ending = null;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    const kind = index > start && bytes[index - 1] === 13 ? 'CRLF' : 'LF';
    if (ending && ending !== kind) reject('UNSUPPORTED_INPUT_ENVELOPE'); ending = kind;
    const lineBytes = index - start - (kind === 'CRLF' ? 1 : 0);
    if (lineBytes > MAX_LINE_BYTES) reject('LINE_TOO_LARGE');
    lines += 1; if (lines > MAX_RECORDS) reject('TOO_MANY_RECORDS'); start = index + 1;
  }
  if (bytes.length - start > MAX_LINE_BYTES) reject('LINE_TOO_LARGE');
  return { text, lineEnding: ending ?? 'NONE' };
};

export function describeInput(bytes, { room, generation = null, mediaType = 'application/x-ndjson' } = {}) {
  try {
    const { lineEnding } = preflight(bytes, room, generation, mediaType);
    const sha256 = hash(bytes);
    return { category: 'INPUT_ACCEPTED', descriptor: { workloadId: workloadId(sha256), sha256, byteLength: bytes.length,
      recordCount: bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0), generationStatus: generation === null ? 'UNKNOWN' : 'KNOWN', roomDisplay: 'REDACTED', lineEnding } };
  } catch (error) { return safeError(error); }
}

function newChecks() {
  return [...CONTENT.map(id => ({ id, dimension: 'CONTENT', status: id === 'JSONL_FORM' || id === 'RECORD_SHAPE' || id === 'SEQ_ORDER' ? 'PASS' : 'NOT_APPLICABLE', affectedRows: [] })),
    ...COVERAGE.map(id => ({ id, dimension: 'COVERAGE', status: id === 'RETENTION_LIMIT' ? 'PASS' : 'NOT_APPLICABLE', affectedRows: [] }))];
}
function update(checks, id, status, row) {
  const check = checks.find(item => item.id === id);
  const rank = { NOT_APPLICABLE: 0, PASS: 1, UNKNOWN: 2, FAIL: 3 };
  if (rank[status] > rank[check.status]) check.status = status;
  if (row && check.affectedRows.length < 20 && !check.affectedRows.includes(row)) check.affectedRows.push(row);
}
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && numberLexeme(value) === null;
const safeError = error => ({ category: error instanceof W1Error ? error.category : 'INTERNAL_ERROR', code: error instanceof W1Error ? error.code : 'UNEXPECTED_VERIFIER_FAILURE' });

export async function validateTranscript(bytes, { room, generation = null, mediaType = 'application/x-ndjson', timeoutMs = 30000 } = {}) {
  try {
    const { text, lineEnding } = preflight(bytes, room, generation, mediaType);
    const inputSha = hash(bytes); const checks = newChecks(); const seen = new Map(); const limitations = new Set(['SUPPLIED_BYTES_NOT_SERVER_ATTESTED', 'BOUNDED_HISTORY_ONLY', 'VENUE_METADATA_UNSIGNED', 'EXTERNAL_RECOMPUTATION_REQUIRES_INPUT', 'ROOM_REDACTED_EXTERNAL_RECOMPUTATION_REQUIRES_ROOM']);
    update(checks, 'GENERATION_CONTEXT', generation === null ? 'UNKNOWN' : 'PASS');
    if (generation === null) limitations.add('UNKNOWN_GENERATION');
    if (lineEnding === 'CRLF') limitations.add('NON_NATIVE_CRLF');
    let rows = 0; let signedVerified = 0; let unsignedContext = 0; let legacyUnverifiable = 0; let duplicateOperations = 0;
    let priorSeq = null; let firstSeq = null; let lastSeq = null; let gaps = 0; let previousTime = null;
    const started = performance.now(); let at = 0; let lineNo = 0;
    while (at < text.length) {
      if (performance.now() - started > timeoutMs) throw new W1Error('INTERNAL_ERROR', 'VERIFIER_TIMEOUT');
      if (process.memoryUsage().heapUsed > 256 * 1024 * 1024) throw new W1Error('INTERNAL_ERROR', 'RESOURCE_EXHAUSTED');
      const end = text.indexOf('\n', at); lineNo += 1;
      if (end === -1) { update(checks, 'JSONL_FORM', 'FAIL', lineNo); limitations.add('PARTIAL_PARSE_DIAGNOSTIC_ONLY'); break; }
      let line = text.slice(at, end); at = end + 1;
      if (lineEnding === 'CRLF') line = line.slice(0, -1);
      if (line.trim() === '') { update(checks, 'JSONL_FORM', 'FAIL', lineNo); limitations.add('PARTIAL_PARSE_DIAGNOSTIC_ONLY'); continue; }
      let row;
      try { row = parseLosslessJson(line); } catch { update(checks, 'JSONL_FORM', 'FAIL', lineNo); limitations.add('PARTIAL_PARSE_DIAGNOSTIC_ONLY'); continue; }
      if (!isObject(row)) { update(checks, 'JSONL_FORM', 'FAIL', lineNo); continue; }
      rows += 1;
      if (Object.keys(row).some(key => !['seq', 'ts', 'from', 'text', 'nonce', 'sig'].includes(key))) { update(checks, 'RECORD_SHAPE', 'UNKNOWN', lineNo); limitations.add('UNSUPPORTED_RECORD_FIELDS'); }
      const seqToken = numberLexeme(row.seq);
      if (!seqToken || !SEQ.test(seqToken) || typeof row.ts !== 'string' || typeof row.from !== 'string' || typeof row.text !== 'string') { update(checks, 'RECORD_SHAPE', 'FAIL', lineNo); continue; }
      const seq = BigInt(seqToken);
      if (firstSeq === null) firstSeq = seq; lastSeq = seq;
      if (priorSeq !== null) {
        if (seq <= priorSeq) { update(checks, 'SEQ_ORDER', 'FAIL', lineNo); update(checks, 'SEQ_GAPS', 'UNKNOWN', lineNo); }
        else if (seq - priorSeq > 1n) { gaps += 1; update(checks, 'SEQ_GAPS', 'FAIL', lineNo); }
        else update(checks, 'SEQ_GAPS', 'PASS');
      }
      priorSeq = seq;
      const time = TS.test(row.ts) ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(time) || (previousTime !== null && time < previousTime)) update(checks, 'TIMESTAMP_METADATA', 'FAIL', lineNo);
      else { update(checks, 'TIMESTAMP_METADATA', 'PASS'); previousTime = time; }
      const hasNonce = Object.hasOwn(row, 'nonce'); const hasSig = Object.hasOwn(row, 'sig');
      const didLike = row.from.startsWith('did:key:');
      if (!didLike && !hasNonce && !hasSig) { unsignedContext += 1; continue; }
      if (!didLike) { update(checks, 'RECORD_SHAPE', 'FAIL', lineNo); continue; }
      let key;
      if (!DID.test(row.from)) update(checks, 'DID_SHAPE', 'FAIL', lineNo);
      else try { key = publicKeyFromDidKey(row.from); update(checks, 'DID_SHAPE', 'PASS'); } catch { update(checks, 'DID_SHAPE', 'FAIL', lineNo); }
      if (!hasSig) { legacyUnverifiable += 1; update(checks, 'SIGNATURE', 'UNKNOWN', lineNo); update(checks, 'NONCE_EXACT', 'UNKNOWN', lineNo); update(checks, 'OP_IDENTITY_UNIQUE', 'UNKNOWN', lineNo); limitations.add('LEGACY_SIG_ABSENT'); continue; }
      if (!hasNonce) { update(checks, 'RECORD_SHAPE', 'FAIL', lineNo); continue; }
      const nonce = numberLexeme(row.nonce); const goodNonce = nonce !== null && NONCE.test(nonce);
      update(checks, 'NONCE_EXACT', goodNonce ? 'PASS' : 'FAIL', lineNo);
      const goodText = row.text.length > 0 && row.text.trim() === row.text && !UNSWEPT.test(row.text) && [...row.text].length <= 4096;
      update(checks, 'SIGNED_TEXT', goodText ? 'PASS' : 'FAIL', lineNo);
      const goodSig = typeof row.sig === 'string' && SIG.test(row.sig) && Buffer.from(row.sig, 'base64url').length === 64 && Buffer.from(row.sig, 'base64url').toString('base64url') === row.sig;
      if (!goodSig) update(checks, 'SIGNATURE', 'FAIL', lineNo);
      else if (key && goodNonce && goodText) {
        const okay = edVerify(null, Buffer.from(`${room}|${nonce}|${row.text}`, 'utf8'), key, Buffer.from(row.sig, 'base64url'));
        update(checks, 'SIGNATURE', okay ? 'PASS' : 'FAIL', lineNo); if (okay) signedVerified += 1;
      } else update(checks, 'SIGNATURE', 'UNKNOWN', lineNo);
      if (goodNonce && key) {
        const identity = `${row.from}|${nonce}`; const prior = seen.get(identity);
        if (prior) { duplicateOperations += 1; update(checks, 'OP_IDENTITY_UNIQUE', 'FAIL', lineNo); }
        else { seen.set(identity, { text: row.text, sig: row.sig }); update(checks, 'OP_IDENTITY_UNIQUE', 'PASS'); }
      }
    }
    if (rows === 0 && text.length === 0) {
      for (const id of ['JSONL_FORM', 'RECORD_SHAPE', 'SEQ_ORDER']) checks.find(check => check.id === id).status = 'NOT_APPLICABLE';
    }
    if (seen.size < 2) {
      const unique = checks.find(check => check.id === 'OP_IDENTITY_UNIQUE');
      if (unique.status === 'PASS') unique.status = 'NOT_APPLICABLE';
    }
    if (gaps) limitations.add('SEQ_GAPS');
    if (rows === 0 || signedVerified === 0) limitations.add('EMPTY_OR_UNSIGNED_ONLY');
    const content = checks.filter(item => item.dimension === 'CONTENT');
    const verdict = content.some(item => item.status === 'FAIL') ? 'INVALID' : signedVerified === 0 || content.some(item => item.status === 'UNKNOWN') ? 'INDETERMINATE' : 'VALID';
    const sequenceStatus = rows === 0 ? 'NO_ROWS' : checks.find(item => item.id === 'SEQ_ORDER').status === 'FAIL' ? 'UNRELIABLE_ORDER' : gaps ? 'GAPPED' : 'CONTIGUOUS_WITHIN_SUPPLIED_ROWS';
    const windowStatus = rows === 0 ? 'EMPTY' : generation === null ? 'UNKNOWN_GENERATION' : sequenceStatus === 'UNRELIABLE_ORDER' ? 'UNRELIABLE_ORDER' : gaps ? 'GAPPED' : 'BOUNDED';
    const artifact = { schema: 'blackbox/workload-evidence/v1', workloadType: VERIFIER_ID, workloadVersion: 'v1', workloadId: workloadId(inputSha),
      input: { provenance: 'USER_SUPPLIED_EXPORT_BYTES', roomDisplay: 'REDACTED', mediaType: 'application/x-ndjson', encoding: 'utf-8', sha256: inputSha,
        byteLength: bytes.length, recordCount: rows, lineEnding },
      verifier: { id: VERIFIER_ID, checkProfile: CHECK_PROFILE, implementationVersion: VERSION, implementationDigest: await implementationDigest(), technocoreRef: TECHNOCORE_REF },
      verdict, coverage: { scope: 'SUPPLIED_WINDOW_ONLY', historyCompleteness: 'NOT_PROVEN', generation: generation === null ? { status: 'UNKNOWN', source: 'NONE' } : { status: 'KNOWN', value: generation, source: 'SUPPLIED_HEADER' },
        sequenceStatus, windowStatus, ...(firstSeq === null ? {} : { firstSeq: firstSeq.toString(), lastSeq: lastSeq.toString() }), gapCount: sequenceStatus === 'UNRELIABLE_ORDER' ? null : gaps },
      checks, summary: { signedVerified, unsignedContext, legacyUnverifiable, duplicateOperations }, limitations: [...limitations].sort() };
    return { category: 'VALIDATION_RESULT', verdict, artifact };
  } catch (error) { return safeError(error); }
}
