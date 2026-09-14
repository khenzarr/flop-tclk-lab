import { verify as edVerify } from 'node:crypto';
import { publicKeyFromDidKey } from '../../airlock/signer.mjs';
import { numberLexeme, parseLosslessJson } from '../transcript-validation/json.mjs';
import { requireNonce, sha256, signaturePreimage } from './canonical.mjs';

const SIG = /^[A-Za-z0-9_-]{85}[AQgw]$/;
export function observeExport(rawBytes, { room, venueOrigin, operation, generation = null }) {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length > 12 * 1024 * 1024) throw new Error('OBSERVATION_EXPORT_INVALID');
  if (venueOrigin !== operation.venueOrigin || room !== operation.room) throw new Error('OBSERVATION_DESTINATION_MISMATCH');
  requireNonce(operation.nonce); const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const matches = []; let malformed = false;
  for (const line of text.split('\n')) {
    if (!line) continue; let row; try { row = parseLosslessJson(line); } catch { malformed = true; continue; }
    const nonce = numberLexeme(row.nonce);
    if (row.from !== operation.signerDid || nonce !== operation.nonce || row.text !== operation.signedText || row.sig !== operation.signature) continue;
    let valid = false;
    try { valid = SIG.test(row.sig) && edVerify(null, Buffer.from(signaturePreimage(room, nonce, row.text)), publicKeyFromDidKey(row.from), Buffer.from(row.sig, 'base64url')); } catch {}
    if (valid) matches.push({ rawLineSha256: sha256(Buffer.from(line)), seq: numberLexeme(row.seq), timestamp: row.ts });
  }
  const count = matches.length; const classification = malformed ? 'OBSERVATION_INVALID' : count >= 1 ? 'OBSERVED_PUBLIC' : 'NOT_OBSERVED';
  return Object.freeze({ classification, exactMatchCount: count, anomaly: count > 1 ? 'DUPLICATE_PUBLIC_MATCH' : null,
    exportSha256: sha256(rawBytes), byteCount: rawBytes.length, generation, malformedRowsPresent: malformed,
    matches: Object.freeze(matches.map(Object.freeze)) });
}
