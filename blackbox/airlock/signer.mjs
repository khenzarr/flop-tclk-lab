// SPDX-License-Identifier: Apache-2.0
//
// SIGNATURE AIRLOCK — STAGE 4: LOCAL SIGNER HANDOFF (TEST-ONLY).
//
// This is not custody and it is not the canonical signer. It is a deterministic stand-in with
// the shape the real trusted signer already has, so the airlock can be demonstrated end to end
// without a real DID key ever existing on this machine.
//
// The shape matters more than the stand-in. The canonical local agent signs
//
//     room | nonce | clean_text(text)
//
// (technocore_agent.signer.canonical.canonical_message), reserves the nonce durably inside
// custody, and returns did/room/nonce/signature/text. So the airlock cannot pre-compute the
// signed preimage: it can only freeze `text`, then verify that what came back is a signature
// over the frozen text under a nonce the signer chose. Everything else is a confusion attack.
//
// The key here is derived from a PUBLISHED TEST VECTOR, deliberately so — it is worthless, it
// is not operator custody material, and it must never be used to post anything.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MULTICODEC_ED25519_PUB = Buffer.from([0xed, 0x01]);
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The venue's own sweep, mirrored so the airlock can tell when it would alter our bytes. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;
export const cleanText = text => {
  const result = text.replace(INVISIBLE, ' ').trim();
  if (!result) throw new Error('signer: text must contain visible characters');
  if (result.length > 4096) throw new Error('signer: text exceeds the character limit');
  return result;
};

/** `room|nonce|clean_text(text)` — the exact preimage the canonical signer signs. */
export function canonicalMessage(room, nonce, text) {
  if (typeof room !== 'string' || room.length === 0 || room.includes('|')) throw new Error('signer: room is invalid');
  if (!Number.isInteger(nonce) || nonce < 1 || nonce >= 1e19) throw new Error('signer: nonce is invalid');
  return `${room}|${nonce}|${cleanText(text)}`;
}

export function base58Encode(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let out = '';
  while (number > 0n) { out = B58[Number(number % 58n)] + out; number /= 58n; }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return '1'.repeat(leading) + out;
}

export function base58Decode(text) {
  let number = 0n;
  for (const char of text) {
    const index = B58.indexOf(char);
    if (index < 0) throw new Error('signer: did contains a non-base58 character');
    number = number * 58n + BigInt(index);
  }
  const bytes = [];
  while (number > 0n) { bytes.unshift(Number(number % 256n)); number /= 256n; }
  let leading = 0;
  while (leading < text.length && text[leading] === '1') leading += 1;
  return Buffer.from([...new Array(leading).fill(0), ...bytes]);
}

export const didKeyFromPublicKey = raw => `did:key:z${base58Encode(Buffer.concat([MULTICODEC_ED25519_PUB, raw]))}`;

/** Decode a did:key to its raw Ed25519 public key. Fails closed on any other key type. */
export function publicKeyFromDidKey(did) {
  if (typeof did !== 'string' || !did.startsWith('did:key:z')) throw new Error('airlock: signer DID is not a did:key');
  const decoded = base58Decode(did.slice('did:key:z'.length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error('airlock: signer DID is not an Ed25519 did:key');
  }
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, decoded.subarray(2)]), format: 'der', type: 'spki' });
}

export const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromBase64url = text => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('airlock: signature is not base64url');
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
};

/**
 * A deterministic test-only signer with the canonical signer's shape. It accepts ONLY the exact
 * approved challenge: request id, canonical payload, canonical hash and signer DID must all
 * agree with each other before it will sign, so a caller cannot use it as a generic oracle.
 *
 * The real trusted signer would additionally require its own operator approval record; this
 * stand-in refuses instead of pretending to have one.
 */
export class TestVectorSigner {
  #privateKey;
  #nonces = new Map();

  /** @param {string} label a published, non-secret test-vector label */
  constructor(label = 'FLOPLAB::airlock::test-vector::v1') {
    const material = createHash('sha256').update(label).digest();
    this.#privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, material]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.#privateKey);
    this.did = didKeyFromPublicKey(this.publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length));
    this.kind = 'TEST_VECTOR_SIGNER';
  }

  /** Nonces are reserved inside the signer, exactly as custody does. Never reused per room. */
  reserveNonce(room) {
    const next = (this.#nonces.get(room) ?? 0) + 1;
    this.#nonces.set(room, next);
    return next;
  }

  signApprovedChallenge({ requestId, canonicalPayload, canonicalHash, signerDid, room }) {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('signer: requestId is required');
    if (typeof canonicalPayload !== 'string' || canonicalPayload.length === 0) throw new Error('signer: canonicalPayload is required');
    if (createHash('sha256').update(canonicalPayload, 'utf8').digest('hex') !== canonicalHash) {
      throw new Error('signer: canonicalHash does not cover canonicalPayload — refusing to sign an unverified challenge');
    }
    if (signerDid !== this.did) {
      throw new Error('signer: this signer does not hold the requested DID');
    }
    const nonce = this.reserveNonce(room);
    const message = canonicalMessage(room, nonce, canonicalPayload);
    return {
      requestId,
      signerDid: this.did,
      signature: base64url(edSign(null, Buffer.from(message, 'utf8'), this.#privateKey)),
      canonicalHash,
      room,
      nonce,
      signerKind: this.kind,
    };
  }
}

/** Verify an Ed25519 signature over an exact preimage. No DID resolution, no network. */
export function verifyEd25519(did, message, signature) {
  try {
    return edVerify(null, Buffer.from(message, 'utf8'), publicKeyFromDidKey(did), fromBase64url(signature));
  } catch {
    return false;
  }
}
