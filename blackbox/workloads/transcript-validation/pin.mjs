import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const files = Object.freeze([
  ['blackbox/airlock/signer.mjs', new URL('../../airlock/signer.mjs', import.meta.url)],
  ...['json.mjs', 'pin.mjs', 'verifier.mjs'].map(file => [`blackbox/workloads/transcript-validation/${file}`, new URL(file, import.meta.url)]),
]);
const digest = bytes => createHash('sha256').update(bytes).digest();
const length = bytes => { const out = Buffer.alloc(4); out.writeUInt32BE(bytes.length); return out; };

export async function implementationDigest() {
  const parts = [Buffer.from('blackbox:w1:source-manifest:v1', 'utf8')];
  for (const [name, url] of files) {
    const path = Buffer.from(name, 'utf8');
    const bytes = await readFile(url);
    const canonicalSource = Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
    parts.push(length(path), path, digest(canonicalSource));
  }
  return `sha256:${digest(Buffer.concat(parts)).toString('hex')}`;
}
