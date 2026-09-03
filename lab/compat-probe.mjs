// SPDX-License-Identifier: Apache-2.0
//
// Phase 3A-2 compatibility probe.
//
// Emits a deterministic, secret-free description of every upstream-observable surface the
// Blackbox depends on, computed by running the REAL Blackbox replay and the REAL upstream
// primitives against the resolved upstream build. Nothing is reimplemented here: if a
// surface changes upstream, this probe changes with it.
//
// The probe is executed twice by lab/compat-matrix.mjs — once against the pinned commit and
// once against a candidate head — and the two documents are diffed. It prints JSON on stdout
// and writes nothing, so it is safe to run against a read-only comparison worktree.
//
// Two fingerprints are recorded per fixture, deliberately:
//
//   replayFingerprint            binds the upstream SHA, so it MUST differ between commits.
//   replayFingerprintSansUpstream strips upstream provenance, so it must NOT differ unless
//                                protocol behaviour actually changed.
//
// Conflating those two is how a routine re-pin gets mistaken for a regression.

import { createHash } from "node:crypto";
import { tclk, baseline } from "./upstream.mjs";
import { fixtureSets, replayFixture } from "../blackbox/fixtures/index.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => tclk.canonicalJson(value);

const PAYER = "did:key:z6Mk" + "f".repeat(44);
const PAYEE = "did:key:z6Mk" + "g".repeat(44);
const NOW = 1800000000000;
const SECRET = "0x" + "ab".repeat(32);

/** sha256 over the replay evidence with upstream provenance removed. */
function sansUpstream(result) {
  const { upstream, blackboxReplayHash, state, ...rest } = result;
  return sha256(json({ ...rest, state }));
}

/**
 * Per-fixture protocol observables, for one named fixture set.
 *
 * Each fixture is replayed with ITS OWN declared timing, through the same `replayFixture` the
 * Blackbox itself uses — so a set's evaluation schedule is part of what is being compared,
 * rather than something the probe re-decides.
 */
function fixtureSurface(set, name) {
  const fixture = set[name]();
  const result = replayFixture(fixture);
  return {
    fixtureSetVersion: fixture.fixtureSetVersion,
    lineCount: fixture.lines.length,
    lineHashes: fixture.lines.map(sha256),
    nowMs: fixture.nowMs,
    schedule: fixture.schedule ?? null,
    steps: result.steps.map((step) => ({
      index: step.index,
      type: step.type,
      actor: step.actor,
      ok: step.ok,
      reason: step.reason,
      canonical: step.canonical,
      canonicalFrameHash: step.canonicalFrameHash,
      rawLineHash: step.rawLineHash,
      contract: step.contract,
      statusBefore: step.stateBefore?.status ?? null,
      statusAfter: step.stateAfter?.status ?? null,
      stateDigestBefore: step.stateDigestBefore,
      stateDigestAfter: step.stateDigestAfter,
      terminal: step.terminal,
    })),
    terminalState: result.terminalState,
    finalState: result.state,
    replayFingerprint: result.blackboxReplayHash,
    replayFingerprintSansUpstream: sansUpstream(result),
  };
}

/** Every fixture of one named set, keyed by fixture id. */
const surfaceSet = (setVersion) =>
  Object.fromEntries(
    Object.keys(fixtureSets[setVersion]).map((name) => [name, fixtureSurface(fixtureSets[setVersion], name)]),
  );

/** Canonical encoding rules the Airlock's byte freeze depends on. */
function canonicalizationSurface() {
  const offer = tclk.makeOffer({
    from: PAYER,
    role: "payer",
    amount: "100",
    asset: "FLOP",
    lock: "hash",
    rails: ["paper"],
    claimByMs: NOW + 1000,
    refundAfterMs: NOW + 2000,
    expiresMs: NOW + 500,
    job: { proto: "a2a", id: "t\u00e2che" },
    nonce: "0102030405060708",
  });
  const line = tclk.encodeFrame(offer);
  return {
    sortedCompactUndefinedOmitted: tclk.canonicalJson({ z: 1, a: 2, u: undefined }),
    nonAsciiEscaped: /\\u00e2/.test(line),
    lineIsAscii: /^[\x20-\x7e]*$/.test(line),
    framePrefix: line.slice(0, line.indexOf(" ")),
    offerLineHash: sha256(line),
    offerId: offer.id,
    offerIdRecomputed: tclk.offerId({ ...offer, id: undefined }),
    hashLock: tclk.hashLockFromPreimage(SECRET).hash,
    decodeRoundTrips: tclk.encodeFrame(tclk.decodeFrame(line)) === line,
    mutatedLineRejected: tclk.tryDecodeFrame(line.replace('"100"', '"101"')) === null,
    malformedLineRejected: tclk.tryDecodeFrame("tclk1 {bad") === null,
    unknownFieldRejected: (() => {
      try {
        tclk.validateFrame({ ...offer, unknown: true });
        return false;
      } catch {
        return true;
      }
    })(),
  };
}

/** Contract identity and receipt projection. */
function contractSurface() {
  const lock = tclk.hashLockFromPreimage(SECRET);
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
  const accept = tclk.makeAccept(offer, { from: PAYEE, statement: lock.hash, nonce: "1112131415161718" });
  let state = tclk.openContract(offer);
  const trace = [];
  const step = (frame, nowMs) => {
    const result = tclk.applyFrame(state, frame, nowMs);
    state = result.state;
    trace.push({ type: frame.type, ok: result.ok, reason: result.reason ?? null, status: state.status });
  };
  step(accept, NOW);
  step({ type: "lock", from: PAYER, contract: accept.contract, rail: "paper", ref: "paper-ref" }, NOW);
  step({ type: "reveal", from: PAYEE, contract: accept.contract, secret: SECRET }, NOW + 100);
  step({ type: "receipt", from: PAYEE, contract: accept.contract, outcome: "claimed" }, NOW + 100);
  return { contractId: accept.contract, acceptStatement: accept.statement ?? lock.hash, trace };
}

/** PaperRail predicates. No value, no external writes. */
async function paperRailSurface() {
  const lock = tclk.hashLockFromPreimage(SECRET);
  const terms = {
    contract: contractSurface().contractId,
    lock: "hash",
    statement: lock.hash,
    amount: "100",
    asset: "FLOP",
    payer: PAYER,
    payee: PAYEE,
    claimByMs: NOW + 1000,
    refundAfterMs: NOW + 2000,
  };
  let now = NOW;
  const rail = new tclk.PaperRail(new tclk.MemoryNoteStore(), () => now);
  const ref = await rail.lock(terms);
  const verified = await rail.verifyLock(terms, ref);
  await rail.claim(ref, SECRET);
  const claimed = await rail.read(ref);
  now = NOW;
  const rail2 = new tclk.PaperRail(new tclk.MemoryNoteStore(), () => now);
  const ref2 = await rail2.lock(terms);
  now = NOW + 2000;
  await rail2.refund(ref2);
  const refunded = await rail2.read(ref2);
  return {
    verifyLock: verified,
    claimedStatus: claimed.status,
    refundedStatus: refunded.status,
    refShape: typeof ref === "string" ? "string" : Object.keys(ref).sort(),
  };
}

/**
 * Time model of the lock → refund path.
 *
 * A flat `nowMs` is fine for outcome determinism but collapses deadline ordering. This surface
 * separates the two questions a deadline change raises:
 *
 *   flatClockAtRefundBoundary  lock evaluated AT refundAfterMs (what legacy-v1 does)
 *   progressiveClock           lock before the window, refund at the window (what current-v2
 *                              and any real deal does)
 *
 * If only the flat-clock row moves, the deadline rule was tightened without breaking the lawful
 * ordering — a fixture-clock adaptation, not a broken refund path.
 */
function timeModelSurface() {
  const lock = tclk.hashLockFromPreimage(SECRET);
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
  const accept = tclk.makeAccept(offer, { from: PAYEE, statement: lock.hash, nonce: "1112131415161718" });
  const lockFrame = { type: "lock", from: PAYER, contract: accept.contract, rail: "paper", ref: "paper-ref" };
  const refundFrame = { type: "refund", from: PAYER, contract: accept.contract };

  const run = (lockAt, refundAt) => {
    let state = tclk.openContract(offer);
    const at = (frame, nowMs) => {
      const result = tclk.applyFrame(state, frame, nowMs);
      state = result.state;
      return { ok: result.ok, reason: result.reason ?? null, status: state.status };
    };
    return {
      accept: at(accept, NOW),
      lock: at(lockFrame, lockAt),
      refund: at(refundFrame, refundAt),
      terminalState: state.status,
    };
  };

  return {
    flatClockAtRefundBoundary: run(NOW + 2000, NOW + 2000),
    progressiveClock: run(NOW, NOW + 2000),
  };
}

const surfaces = {
  exports: Object.keys(tclk).sort(),
  canonicalization: canonicalizationSurface(),
  contract: contractSurface(),
  timeModel: timeModelSurface(),
  paperRail: await paperRailSurface(),
  // Both provenanced sets are reported. `fixtures` is the current baseline; `legacyFixtures`
  // reproduces what the 81a8346-era artifacts were built from, so a cross-pin matrix can show
  // the old pin still evaluating the old timing exactly as it always did.
  fixtures: surfaceSet("current-v2"),
  legacyFixtures: surfaceSet("legacy-v1"),
};

process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      upstream: {
        commit: baseline.commit,
        packageVersion: baseline.packageVersion,
        comparisonOverride: baseline.comparisonOverride === true,
      },
      surfaces,
    },
    null,
    2,
  ) + "\n",
);
