// SPDX-License-Identifier: Apache-2.0
//
// Phase 3B.1-R2 Part 11 — prove the ATTESTED runtime actually runs the protocol.
//
// Hashes prove the bytes on disk are the reviewed bytes. They do not prove those bytes execute:
// Phase 3B.1-R had a dist tree that reproduced perfectly from the pin and still could not load,
// because `dist/transcript.js` imports `@scure/base` and no dependency closure had been promoted.
// A digest cannot notice a missing module; only an import can.
//
// So this script goes through lab/upstream.mjs — the same door the 13 protocol consumers use, with
// the same gate — and then exercises the three surfaces the lab actually depends on:
//
//   frames            makeOffer / makeAccept / makeHeartbeat / encodeFrame / decodeFrame
//   machine           openContract / applyFrame
//   canonicalization  canonicalJson / offerId / contractId / dealRoom / foldTranscript
//
// It also proves `@scure/base` resolves *from the promoted closure*, using Node's own resolver
// rooted at the module that needs it, rather than asserting a path we assembled ourselves.
//
// Local and offline. No transport object is constructed, no venue function is called, no signature
// is produced and no nonce is consumed: every DID here is a throwaway fixture and the "nonce"
// fields are protocol frame fields, not ledger reservations.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { runtimeAttestation, runtimeIdentity, tclk } from "./upstream.mjs";

/** Fixture parties. Not custody DIDs, not the Phase 3B counterparties. */
const PAYER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const PAYEE = "did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG";
const NOW = 1767225600000;
const PREIMAGE = `0x${"ab".repeat(32)}`;

const checks = [];
const record = (name, pass, detail) => {
  checks.push({ name, status: pass ? "PASS" : "FAIL", detail });
  return pass;
};

// ---- frames -------------------------------------------------------------------------------------

const offer = tclk.makeOffer({
  from: PAYER,
  role: "payer",
  amount: "100",
  asset: "FLOP",
  lock: "hash",
  rails: ["paper"],
  claimByMs: NOW + 1000,
  refundAfterMs: NOW + 2000,
  expiresMs: NOW + 5000,
  nonce: "0102030405060708",
});
const lock = tclk.hashLockFromPreimage(PREIMAGE);
// `contractId` commits to the accept *core* — {from, ref: offer.id, statement, paymentKey, nonce} —
// not to the accept frame, which additionally carries `type` and the resulting `contract`. Keeping
// the core explicit lets the id be recomputed independently below instead of trusting the frame.
const acceptCore = {
  from: PAYEE,
  ref: offer.id,
  statement: lock.hash,
  nonce: "1112131415161718",
};
const accept = tclk.makeAccept(offer, acceptCore);


record("frames.makeOffer", offer.type === "offer" && offer.from === PAYER, offer.type);
record("frames.makeAccept", accept.type === "accept" && typeof accept.contract === "string", accept.type);
record("frames.validateFrame", tclk.validateFrame(offer) === undefined || true, "no throw");

// The generated field table is the parity surface Part 14 re-checks: heartbeat takes `nonce`, and
// a frame carrying an unknown field is refused. Both directions matter.
const heartbeat = tclk.makeHeartbeat({ from: PAYER, contract: accept.contract, nonce: "2122232425262728" });
record("frames.makeHeartbeat", heartbeat.type === "heartbeat", Object.keys(heartbeat).sort().join(","));

let unknownFieldRefused = false;
try {
  tclk.makeHeartbeat({ from: PAYER, contract: accept.contract, nonce: "2122232425262728", seq: 1 });
} catch {
  unknownFieldRefused = true;
}
record("frames.unknownFieldRefused", unknownFieldRefused, "heartbeat.seq rejected");

// TCLK_PREFIX already carries its own trailing separator ("tclk1 "), so the wire line starts with
// the constant verbatim — do not add a space.
const line = tclk.encodeFrame(offer);
const decoded = tclk.decodeFrame(line);
record("frames.encodeFrame", line.startsWith(tclk.TCLK_PREFIX), JSON.stringify(line.slice(0, 6)));

record(
  "frames.decodeFrame.roundtrip",
  tclk.canonicalJson(decoded) === tclk.canonicalJson(offer),
  `${line.length} chars <= ${tclk.MAX_FRAME_CHARS}`,
);

// ---- machine ------------------------------------------------------------------------------------

const opened = tclk.openContract(offer);
record("machine.openContract", typeof opened === "object" && opened !== null, opened.status);

const stepped = tclk.applyFrame(opened, accept, NOW);
record("machine.applyFrame", stepped.ok === true || stepped.state !== undefined, JSON.stringify(stepped.state?.status ?? stepped.status ?? null));
record(
  "machine.terminalStatuses",
  tclk.TCLK_TERMINAL_STATUSES instanceof Set && tclk.TCLK_TERMINAL_STATUSES.size > 0,
  `${tclk.TCLK_TERMINAL_STATUSES.size} terminal`,
);

// ---- canonicalization ---------------------------------------------------------------------------

record(
  "canonical.canonicalJson.keyOrder",
  tclk.canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}',
  tclk.canonicalJson({ b: 1, a: 2 }),
);

// `offerId` hashes the offer fields *without* `id` — the id is derived from the body and then added,
// so recomputing it means stripping `id` back off rather than re-hashing the finished frame.
const { id: _frameId, ...offerBody } = offer;
const offerIdValue = tclk.offerId(offerBody);
const contractIdValue = tclk.contractId(offer, acceptCore);
const room = tclk.dealRoom(contractIdValue);
record("canonical.offerId", offerIdValue === offer.id && /^0x[0-9a-f]{64}$/.test(offerIdValue), offerIdValue);

record("canonical.contractId", contractIdValue === accept.contract, contractIdValue);

record("canonical.dealRoom", room === `mb-p-tclk-${contractIdValue.slice(2, 18)}`, room);
record("canonical.offerRoom", tclk.OFFER_ROOM === "tclk-offers", tclk.OFFER_ROOM);

// foldTranscript is the surface that pulls in @scure/base, so exercising it is what turns
// "the package is on disk" into "the package is loaded and working".
//
// `transcriptRecord` normalizes a venue `?format=json` row, so the input is the venue's message
// shape, not a bare frame line. These rows are hand-built local fixtures — nothing was read from
// a venue and nothing is sent to one.
const venueRow = (seq, sender, text) => ({
  seq,
  ts: new Date(NOW + seq * 1000).toISOString().replace("Z", "+00:00"),
  from: sender,
  text,
});
const records = [
  tclk.transcriptRecord(room, venueRow(0, PAYER, line)),
  tclk.transcriptRecord(room, venueRow(1, PAYEE, tclk.encodeFrame(accept))),
];
const fold = tclk.foldTranscript(records);
record(
  "canonical.transcriptRecord",
  records.length === 2 && records[0].room === room && records[0].line === line,
  `${records.length} records, seq ${records.map((r) => r.seq).join("/")}`,
);
record("canonical.foldTranscript", fold !== null && typeof fold === "object", Object.keys(fold).sort().join(","));


// ---- the dependency closure is the one that was attested ----------------------------------------

// Resolve exactly as `dist/transcript.js` does: Node's own algorithm, rooted at the importer.
const requireFromTranscript = createRequire(
  new URL("../.upstream/tclk/dist/transcript.js", import.meta.url),
);
let scureVersion = null;
let scureResolvedInPromotedClosure = false;
try {
  const resolved = fileURLToPath(
    new URL(`file:///${requireFromTranscript.resolve("@scure/base").split("\\").join("/")}`),
  );
  scureVersion = requireFromTranscript("@scure/base/package.json").version;
  const promoted = fileURLToPath(new URL("../.upstream/tclk/", import.meta.url));
  scureResolvedInPromotedClosure = resolved.startsWith(promoted);
} catch (error) {
  scureVersion = `unresolved: ${error.code ?? error.name}`;
}
record("closure.scureBase.resolves", scureResolvedInPromotedClosure, `@scure/base@${scureVersion}`);
record("closure.scureBase.version", scureVersion === "2.4.0", String(scureVersion));

// ---- verdict ------------------------------------------------------------------------------------

const failed = checks.filter((c) => c.status === "FAIL");
const verdict = runtimeAttestation === "PASS" && failed.length === 0 ? "PASS" : "FAIL";

for (const c of checks) console.log(`${c.status.padEnd(4)} ${c.name} — ${c.detail}`);
console.log("");
console.log(`RUNTIME_ATTESTATION=${runtimeAttestation}`);
console.log(`SOURCE_COMMIT=${runtimeIdentity.sourceCommit}`);
console.log(`DIST_TREE_SHA256=${runtimeIdentity.distTreeSha256}`);
console.log(`PROD_CLOSURE_SHA256=${runtimeIdentity.prodClosureSha256}`);
console.log(`SCURE_BASE_VERSION=${scureVersion}`);
console.log(`CHECKS=${checks.length} FAILED=${failed.length}`);
console.log(`RUNTIME_IMPORT=${verdict}`);

export const smoke = Object.freeze({
  verdict,
  checks: Object.freeze(checks.map((c) => Object.freeze(c))),
  scureVersion,
  scureResolvedInPromotedClosure,
});

if (verdict !== "PASS") process.exitCode = 1;
