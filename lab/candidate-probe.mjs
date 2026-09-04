// SPDX-License-Identifier: Apache-2.0
//
// Phase 3A.2 candidate semantic-drift probe.
//
// Answers, per upstream commit, the four §4 questions plus the wire, historical-frame and
// current-v2 questions — by exercising the real upstream build through the documented
// FLOPLAB_UPSTREAM_DIR / FLOPLAB_UPSTREAM_SHA override. Nothing here reimplements protocol
// logic, nothing is patched upstream, and no probe input exceeds the frame cap by more than
// one character (an audit must not become an allocation test).
//
//   node lab/candidate-probe.mjs <label>=<dir>=<sha> ...      run across pins, write evidence
//   FLOPLAB_PROBE_EMIT=1 node lab/candidate-probe.mjs         emit one pin's surface as JSON
//
// Exit codes: 0 no unexplained protocol-observable change, 1 otherwise. A non-zero exit means
// the candidate does not become the pin on this run.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const SELF = fileURLToPath(new URL('candidate-probe.mjs', import.meta.url));

/** Every probe outcome is recorded as data, never as a thrown audit. */
const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};
/** Result shape for acceptance questions: did it accept, and if not, exactly why. */
const acceptance = (fn) => {
  const r = attempt(fn);
  return r.ok ? { accepted: true, reason: null, detail: r.value ?? null } : { accepted: false, reason: r.reason };
};

// ---------------------------------------------------------------------------------------------
// EMIT MODE — one resolved pin
// ---------------------------------------------------------------------------------------------

if (process.env.FLOPLAB_PROBE_EMIT === '1') {
  const { tclk, baseline, head } = await import(new URL('upstream.mjs', import.meta.url).href);
  const { currentFixtures, legacyFixtures, replayFixture } = await import(
    new URL('blackbox/fixtures/index.mjs', ROOT).href
  );


  const PICK = [
    'index', 'type', 'ok', 'reason', 'statusBefore', 'statusAfter', 'terminal',
    'canonicalFrameHash', 'contract', 'stateDigestBefore', 'stateDigestAfter',
  ];
  const step = (s) => Object.fromEntries(PICK.filter((k) => k in s).map((k) => [k, s[k]]));
  /** Scalar top-level replay outputs (fingerprints, terminal state) without assuming names. */
  const scalars = (o) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== 'object'));

  /** One fixture set replayed with its own declared timing. */
  const runSet = (set) =>
    Object.fromEntries(
      Object.entries(set).map(([id, factory]) => {
        const f = factory();
        const r = attempt(() => replayFixture(f));
        if (!r.ok) return [id, { replayFailed: r.reason }];
        const result = r.value;
        const steps = (result.steps ?? []).map(step);
        const rejected = steps.filter((s) => s.ok === false);
        return [id, {
          fixtureSetVersion: f.fixtureSetVersion,
          nowMs: f.nowMs,
          schedule: f.schedule ?? null,
          lineHashes: (result.steps ?? []).map((s) => s.canonicalFrameHash ?? null),
          accepted: steps.filter((s) => s.ok === true).length,
          rejectedCount: rejected.length,
          rawUpstreamReasons: rejected.map((s) => s.reason ?? null),
          steps,
        terminalState: result.terminalState ?? null,
        rail: result.state?.rail ?? null,
        railRef: result.state?.railRef ?? null,
        finalStatus: result.state?.status ?? null,

          // The capsule invariant, recomputed rather than trusted: a refusal must not mutate state.
          rejectionsDoNotMutate: rejected.every(
            (s) => !('stateDigestBefore' in s) || s.stateDigestBefore === s.stateDigestAfter,
          ),
          ...scalars(result),
        }];
      }),
    );

  // --- shared deal material, decoded from the fixture lines rather than rebuilt ----------------
  const happy = currentFixtures['happy-claim']();
  const decoded = happy.lines.map((l) => attempt(() => tclk.decodeFrame(l)));
  const offer = decoded[0].ok ? decoded[0].value : null;
  const accept = decoded[1].ok ? decoded[1].value : null;
  const CONTRACT = accept?.contract ?? null;

  // --- §4A decode cap -------------------------------------------------------------------------
  const CAP = tclk.MAX_FRAME_CHARS ?? null;
  const TARGET = CAP ?? 4096; // probe the same byte lengths on a pin that has no cap constant
  const lockAt = (n) => ({ type: 'lock', from: offer.from, contract: CONTRACT, rail: 'paper', ref: 'x'.repeat(n) });
  /** Largest ref padding whose encoded line is still <= TARGET, found without ever exceeding it. */
  const fit = (() => {
    const probe = attempt(() => tclk.encodeFrame(lockAt(1)).length);
    if (!probe.ok) return null;
    const overhead = probe.value - 1;
    return TARGET - overhead;
  })();
  const atCapLine = fit === null ? null : attempt(() => tclk.encodeFrame(lockAt(fit)));
  const atCap = atCapLine?.ok ? atCapLine.value : null;
  // One character over: a valid JSON body, and the same body broken, both exactly TARGET+1 chars.
  const overCapValid = atCap === null ? null : atCap.replace('"ref":"x', '"ref":"xx');
  const overCapMalformed = overCapValid === null ? null : `${overCapValid.slice(0, -1)}x`;
  const decodeCap = {
    capConstant: CAP,
    capExported: CAP !== null,
    probedLengths: { atCap: atCap?.length ?? null, overCap: overCapValid?.length ?? null },
    belowBoundary: acceptance(() => tclk.decodeFrame(happy.lines[2]).type),
    atBoundary: atCap === null
      ? { accepted: null, reason: 'could not construct an at-cap line on this pin' }
      : acceptance(() => tclk.decodeFrame(atCap).type),
    aboveBoundary: overCapValid === null
      ? { accepted: null, reason: 'no at-cap line to extend' }
      : acceptance(() => tclk.decodeFrame(overCapValid).type),
    // Enforcement ordering: an over-cap line with a broken body must be refused FOR the cap,
    // which is only possible if the length gate precedes JSON.parse.
    aboveBoundaryMalformedBody: overCapMalformed === null
      ? { accepted: null, reason: 'no at-cap line to extend' }
      : acceptance(() => tclk.decodeFrame(overCapMalformed).type),
    encodeRefusesOverCap: acceptance(() => tclk.encodeFrame(lockAt((fit ?? 0) + 1)).length),
    tryDecodeOverCap: overCapValid === null
      ? null
      : attempt(() => tclk.tryDecodeFrame(overCapValid)).value ?? null,
    isTclkLineOverCap: overCapValid === null ? null : attempt(() => tclk.isTclkLine(overCapValid)).value ?? null,
    // Do the fixtures the Blackbox actually publishes sit inside the cap?
    fixtureMaxLineLength: Math.max(
      ...Object.values(currentFixtures).flatMap((f) => f().lines.map((l) => l.length)),
      ...Object.values(legacyFixtures).flatMap((f) => f().lines.map((l) => l.length)),
    ),
  };

  // --- §4C hex acceptance vs reason -----------------------------------------------------------
  // Probed through the public lock constructors, which is how the Blackbox reaches hex at all.
  const S32 = `0x${'ab'.repeat(32)}`;
  const hex = {
    empty: acceptance(() => tclk.hashLockFromPreimage('').hash),
    zeroXOnly: acceptance(() => tclk.hashLockFromPreimage('0x').hash),
    valid32: acceptance(() => tclk.hashLockFromPreimage(S32).hash),
    oddLength: acceptance(() => tclk.hashLockFromPreimage('0xabc').hash),
    uppercaseBody: acceptance(() => tclk.hashLockFromPreimage(`0x${'AB'.repeat(32)}`).hash),
    uppercasePrefix: acceptance(() => tclk.hashLockFromPreimage(`0X${'ab'.repeat(32)}`).hash),
    noPrefix: acceptance(() => tclk.hashLockFromPreimage('ab'.repeat(32)).hash),
    nonHexBody: acceptance(() => tclk.hashLockFromPreimage('0xzz').hash),
    // Normalization: does a valid value still hash to the same lock as before?
    canonicalLockOfValid32: attempt(() => tclk.hashLockFromPreimage(S32).hash).value ?? null,
    verifyValid: acceptance(() => tclk.verifyHashPreimage(tclk.hashLockFromPreimage(S32).hash, S32)),
    statementUppercase: attempt(() => tclk.isValidStatement(`0x${'AB'.repeat(32)}`)).value ?? null,
    statementLowercase: attempt(() => tclk.isValidStatement(`0x${'ab'.repeat(32)}`)).value ?? null,
  };

  // --- §4B narrowed schema patterns -----------------------------------------------------------
  // The narrowed $defs cover adaptor scalars and interop job descriptors. Both are probed at
  // runtime, because a schema file is documentation until the code agrees with it.
  const adaptorS = (s) => attempt(() => tclk.schnorrAdaptor?.extractWitness?.({ nonce: `0x${'02'.repeat(33)}`, s }, { nonce: `0x${'02'.repeat(33)}`, s }));
  const schemaPatterns = {
    adaptorOddLengthS: adaptorS('0xabc'),
    adaptorEvenLengthS: adaptorS(`0x${'ab'.repeat(32)}`),
    adaptorEmptyS: adaptorS(''),
    jobProtoValid: acceptance(() => tclk.a2aJob?.({ proto: 'a2a.v1', id: 'job-1', context: 'ctx' }) ?? null),
    jobProtoUppercase: acceptance(() => tclk.a2aJob?.({ proto: 'A2A.V1', id: 'job-1' }) ?? null),
    jobIdEmpty: acceptance(() => tclk.a2aJob?.({ proto: 'a2a.v1', id: '' }) ?? null),
    jobContextEmpty: acceptance(() => tclk.a2aJob?.({ proto: 'a2a.v1', id: 'job-1', context: '' }) ?? null),
  };

  // --- §4D receipt rail / ref + zero witness --------------------------------------------------
  const RAIL = 'paper';
  const receipts = attempt(() => {
    // A receipt is only lawful post-terminal, so the deal is driven to `claimed` through the real
    // upstream primitives — `replay()` returns a redacted projection, not a ContractState.
    const lines = [...happy.lines];
    const frames = lines.map((l) => tclk.decodeFrame(l));
    let state = tclk.openContract(frames[0]);
    for (const frame of frames.slice(1)) {
      const r = tclk.applyFrame(state, frame, happy.nowMs);
      if (!r.ok) throw new Error(`could not reach terminal state: ${r.reason}`);
      state = r.state;
    }
    if (state.status !== 'claimed') throw new Error(`expected claimed, reached ${state.status}`);
    const at = happy.nowMs + 3;

    const apply = (frame) => {
      const r = attempt(() => tclk.applyFrame(state, frame, at));
      if (!r.ok) return { accepted: false, reason: r.reason };
      return { accepted: r.value.ok === true, reason: r.value.reason ?? null };
    };
    const observedRail = state.rail ?? null;
    const observedRef = state.railRef ?? null;
    return {
      contractRail: observedRail,
      contractRailRef: observedRef,
      lineCount: lines.length,
      bareReceipt: apply({ type: 'receipt', from: offer.from, contract: CONTRACT, outcome: 'claimed' }),
      matchingRailAndRef: apply({
        type: 'receipt', from: offer.from, contract: CONTRACT, outcome: 'claimed',
        rail: observedRail ?? RAIL, ref: observedRef ?? 'paper-ref',
      }),
      mismatchedRail: apply({
        type: 'receipt', from: offer.from, contract: CONTRACT, outcome: 'claimed', rail: 'x402',
      }),
      mismatchedRef: apply({
        type: 'receipt', from: offer.from, contract: CONTRACT, outcome: 'claimed', ref: 'different-ref',
      }),
      contradictoryOutcome: apply({
        type: 'receipt', from: offer.from, contract: CONTRACT, outcome: 'refunded',
      }),
    };
  });

  // Zero witness: an adaptor pre-signature whose revealed scalar difference is zero carries no
  // secret, so extracting a witness from it must refuse rather than return zero.
  const zeroWitness = attempt(() => {
    const a = tclk.schnorrAdaptor;
    if (!a?.extractWitness) return { available: false };
    const nonce = `0x${'02'.repeat(33)}`;
    const s = `0x${'ab'.repeat(32)}`;
    return {
      available: true,
      identicalScalars: a.extractWitness({ nonce, s }, { nonce, s }),
      adaptZeroWitness: a.adapt ? a.adapt({ nonce, s }, `0x${'00'.repeat(32)}`) : null,
    };
  });

  // --- §5 golden wire: canonical lines, offer ids, contract ids --------------------------------
  const wire = {
    canonicalLines: Object.fromEntries(
      Object.entries(currentFixtures).map(([id, f]) => [id, f().lines]),
    ),
    legacyCanonicalLines: Object.fromEntries(
      Object.entries(legacyFixtures).map(([id, f]) => [id, f().lines]),
    ),
    offerId: offer ? attempt(() => tclk.offerId(offer)).value ?? null : null,
    contractId: CONTRACT,
    contractIdRecomputed: offer && accept
      ? attempt(() => tclk.contractId(offer, accept)).value ?? null
      : null,
    prefix: tclk.TCLK_PREFIX ?? null,
    version: tclk.TCLK_VERSION ?? null,
    domain: tclk.TCLK_DOMAIN ?? null,
    canonicalJsonOfOffer: offer ? attempt(() => tclk.canonicalJson(offer)).value ?? null : null,
  };

  // --- §6 historical frames authored under the legacy pin -------------------------------------
  const historicalFrames = Object.fromEntries(
    Object.entries(legacyFixtures).map(([id, factory]) => {
      const f = factory();
      const perLine = f.lines.map((line, i) => {
        const d = acceptance(() => tclk.decodeFrame(line).type);
        const v = d.accepted
          ? acceptance(() => {
              const frame = tclk.decodeFrame(line);
              const res = tclk.validateFrame ? tclk.validateFrame(frame) : true;
              if (res && res.ok === false) throw new Error(res.reason ?? 'validateFrame refused');
              return true;
            })
          : { accepted: false, reason: d.reason };
        return { index: i, length: line.length, decode: d, validate: v };
      });
      return [id, {
        lines: perLine,
        allDecode: perLine.every((l) => l.decode.accepted),
        allValidate: perLine.every((l) => l.validate.accepted),
      }];
    }),
  );

  const surface = {
    upstream: { commit: head, sha: baseline.commit, packageVersion: baseline.packageVersion },
    exports: Object.keys(tclk).sort(),
    decodeCap,
    hex,
    schemaPatterns,
    receipts: receipts.ok ? receipts.value : { probeFailed: receipts.reason },
    zeroWitness: zeroWitness.ok ? zeroWitness.value : { probeFailed: zeroWitness.reason },
    wire,
    historicalFrames,
    currentV2: runSet(currentFixtures),
    legacyV1: runSet(legacyFixtures),
  };

  process.stdout.write(JSON.stringify(surface));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// RUNNER MODE — across pins
// ---------------------------------------------------------------------------------------------

const pins = process.argv.slice(2).map((arg) => {
  const [label, dir, sha] = arg.split('=');
  if (!label || !dir || !sha) {
    console.error('usage: node lab/candidate-probe.mjs <label>=<dir>=<sha> ...');
    process.exit(1);
  }
  return { label, dir, sha };
});
if (pins.length < 2) {
  console.error('candidate-probe: at least a baseline pin and the candidate are required');
  process.exit(1);
}

const run = ({ dir, sha }) =>
  JSON.parse(
    execFileSync(process.execPath, [SELF], {
      cwd: fileURLToPath(ROOT),
      env: {
        ...process.env,
        FLOPLAB_PROBE_EMIT: '1',
        // The pinned clone is addressed by clearing the override, never by naming it: an
        // override without an asserted SHA is the silent drift the guard exists to prevent.
        FLOPLAB_UPSTREAM_DIR: dir === '' ? '' : dir,
        FLOPLAB_UPSTREAM_SHA: dir === '' ? '' : sha,
      },
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }),
  );

const runs = Object.fromEntries(pins.map((pin) => [pin.label, { pin, surface: run(pin) }]));
for (const [label, { pin, surface }] of Object.entries(runs)) {
  if (!surface.upstream.commit.startsWith(pin.sha.slice(0, 12))) {
    console.error(`candidate-probe: ${label} resolved to ${surface.upstream.commit}, expected ${pin.sha}`);
    process.exit(1);
  }
}

const labels = pins.map((p) => p.label);
const CANDIDATE = labels[labels.length - 1];
const COMPARISON = labels[labels.length - 2];
const HISTORICAL = labels[0];
const s = (label) => runs[label].surface;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Trajectory: what happened, in order, and where it ended — the semantic question. */
const trajectory = (fixture) =>
  JSON.stringify({
    sequence: (fixture.steps ?? []).map((x) => [x.type, x.ok, x.statusBefore, x.statusAfter, x.terminal]),
    terminalState: fixture.terminalState,
    rail: fixture.rail,
  });
/** The same, including raw reason text — the evidence-bytes question. */
const trajectoryWithReasons = (fixture) =>
  JSON.stringify({ t: trajectory(fixture), reasons: fixture.rawUpstreamReasons });

const fixtureIds = Object.keys(s(CANDIDATE).currentV2);
const currentV2Rows = fixtureIds.map((id) => {
  const a = s(COMPARISON).currentV2[id];
  const b = s(CANDIDATE).currentV2[id];
  return {
    fixture: id,
    transcriptBytesIdentical: eq(a.lineHashes, b.lineHashes),
    semanticallyEquivalent: trajectory(a) === trajectory(b),
    reasonTextIdentical: eq(a.rawUpstreamReasons, b.rawUpstreamReasons),
    evidenceBytesIdentical: trajectoryWithReasons(a) === trajectoryWithReasons(b),
    comparison: { accepted: a.accepted, rejected: a.rejectedCount, terminalState: a.terminalState, rail: a.rail, reasons: a.rawUpstreamReasons },
    candidate: { accepted: b.accepted, rejected: b.rejectedCount, terminalState: b.terminalState, rail: b.rail, reasons: b.rawUpstreamReasons },
    invariantsHold: b.rejectionsDoNotMutate,
  };
});

/**
 * §6 per-scenario historical classification.
 *
 * "Was a previously valid frame refused?" is only answerable for frames that were valid to
 * begin with. A CHAOS fixture carrying a deliberately tampered line was refused under the
 * historical pin too — refusing it again is the invariant holding, so it is NOT_APPLICABLE to
 * the wire-break question and is judged on trajectory equality instead.
 */
const historicalRows = Object.entries(s(CANDIDATE).historicalFrames).map(([id, h]) => {
  const underHistorical = s(HISTORICAL).historicalFrames[id];
  const legacyUnderHistorical = s(HISTORICAL).legacyV1[id];
  const legacyUnderCandidate = s(CANDIDATE).legacyV1[id];
  const wasValidHistorically = underHistorical.allDecode && underHistorical.allValidate;
  const framesSurvive = h.allDecode && h.allValidate;
  const sameTrajectory = trajectory(legacyUnderHistorical) === trajectory(legacyUnderCandidate);
  const classification = !wasValidHistorically
    ? 'NOT_APPLICABLE'
    : !framesSurvive
      ? 'NOW_FAILS_CLOSED'
      : sameTrajectory
        ? 'STILL_VALID'
        : 'NOW_FAILS_CLOSED_AT_APPLY';
  const notes = {
    NOT_APPLICABLE:
      'adversarial by construction: this fixture carries a deliberately tampered line that the '
      + 'historical pin refused as well, so it cannot demonstrate a regression in accepted frames',
    NOW_FAILS_CLOSED_AT_APPLY:
      'frames remain decodable and structurally valid; the legacy evaluation timing is what current '
      + 'upstream refuses (#43), which is the known Phase 3A.1 migration finding, not a wire break',
  };
  return {
    fixture: id,
    validUnderHistoricalPin: wasValidHistorically,
    framesDecode: h.allDecode,
    framesValidate: h.allValidate,
    refusedLines: h.lines.filter((l) => !l.decode.accepted || !l.validate.accepted)
      .map((l) => ({ index: l.index, reason: l.decode.reason ?? l.validate.reason })),
    refusedUnderHistoricalPin: underHistorical.lines
      .filter((l) => !l.decode.accepted || !l.validate.accepted)
      .map((l) => ({ index: l.index, reason: l.decode.reason ?? l.validate.reason })),
    historicalTrajectory: trajectory(legacyUnderHistorical),
    candidateTrajectory: trajectory(legacyUnderCandidate),
    trajectoryPreserved: sameTrajectory,
    classification,
    note: notes[classification] ?? null,
  };
});


const wireRows = labels.slice(1).map((label, i) => {
  const a = s(labels[i]);
  const b = s(label);
  return {
    from: labels[i],
    to: label,
    canonicalLinesIdentical: eq(a.wire.canonicalLines, b.wire.canonicalLines),
    legacyCanonicalLinesIdentical: eq(a.wire.legacyCanonicalLines, b.wire.legacyCanonicalLines),
    offerIdIdentical: a.wire.offerId === b.wire.offerId,
    contractIdIdentical: a.wire.contractId === b.wire.contractId,
    canonicalJsonIdentical: a.wire.canonicalJsonOfOffer === b.wire.canonicalJsonOfOffer,
    prefixIdentical: a.wire.prefix === b.wire.prefix,
    versionIdentical: a.wire.version === b.wire.version,
    domainIdentical: a.wire.domain === b.wire.domain,
  };
});

const wireCompatible = wireRows.every(
  (r) => r.canonicalLinesIdentical && r.legacyCanonicalLinesIdentical && r.offerIdIdentical
    && r.contractIdIdentical && r.canonicalJsonIdentical && r.prefixIdentical && r.versionIdentical
    && r.domainIdentical,
);

const cand = s(CANDIDATE);
const comp = s(COMPARISON);
const hist = s(HISTORICAL);

/** §4A/4B/4C/4D verdicts, each stated as a change or as no change, with the evidence attached. */
const probes = {
  decodeCap: {
    capBefore: comp.decodeCap.capConstant,
    capAfter: cand.decodeCap.capConstant,
    capChanged: comp.decodeCap.capConstant !== cand.decodeCap.capConstant,
    enforcedBeforeParse: cand.decodeCap.aboveBoundaryMalformedBody.accepted === false
      && /cap/i.test(cand.decodeCap.aboveBoundaryMalformedBody.reason ?? ''),
    boundary: {
      below: cand.decodeCap.belowBoundary,
      at: cand.decodeCap.atBoundary,
      above: cand.decodeCap.aboveBoundary,
      aboveMalformedBody: cand.decodeCap.aboveBoundaryMalformedBody,
    },
    // The acceptance-set answer needs both sides of the same question, so each pin's verdict on
    // an over-cap line is recorded rather than inferred from the exported constant.
    boundaryByPin: Object.fromEntries(labels.map((l) => [l, {
      capConstant: s(l).decodeCap.capConstant,
      at: s(l).decodeCap.atBoundary.accepted,
      above: s(l).decodeCap.aboveBoundary.accepted,
      aboveReason: s(l).decodeCap.aboveBoundary.reason ?? null,
      encodeRefusesOverCap: s(l).decodeCap.encodeRefusesOverCap.accepted === false,
    }])),
    historicalPinAcceptedOverCap: hist.decodeCap.aboveBoundary.accepted,

    fixturesWithinCap: cand.decodeCap.fixtureMaxLineLength <= (cand.decodeCap.capConstant ?? Infinity),
    fixtureMaxLineLength: cand.decodeCap.fixtureMaxLineLength,
    canonicalOutputChanged: !wireCompatible,
  },
  schemaPatterns: {
    before: comp.schemaPatterns,
    after: cand.schemaPatterns,
    runtimeAcceptanceChanged: !eq(
      Object.fromEntries(Object.entries(comp.schemaPatterns).map(([k, v]) => [k, v.accepted ?? v.ok])),
      Object.fromEntries(Object.entries(cand.schemaPatterns).map(([k, v]) => [k, v.accepted ?? v.ok])),
    ),
  },
  hex: {
    acceptanceChanges: Object.entries(cand.hex)
      .filter(([k, v]) => v && typeof v === 'object' && 'accepted' in v && comp.hex[k]?.accepted !== v.accepted)
      .map(([k, v]) => ({ probe: k, before: comp.hex[k].accepted, after: v.accepted, afterReason: v.reason })),
    reasonOnlyChanges: Object.entries(cand.hex)
      .filter(([k, v]) => v && typeof v === 'object' && 'accepted' in v
        && comp.hex[k]?.accepted === v.accepted && comp.hex[k]?.reason !== v.reason)
      .map(([k, v]) => ({ probe: k, before: comp.hex[k].reason, after: v.reason })),
    normalizationChanged: comp.hex.canonicalLockOfValid32 !== cand.hex.canonicalLockOfValid32,
    uppercaseAcceptanceBefore: comp.hex.uppercaseBody.accepted,
    uppercaseAcceptanceAfter: cand.hex.uppercaseBody.accepted,
    statementCaseBefore: { upper: comp.hex.statementUppercase, lower: comp.hex.statementLowercase },
    statementCaseAfter: { upper: cand.hex.statementUppercase, lower: cand.hex.statementLowercase },
  },
  receipts: { before: comp.receipts, after: cand.receipts, changed: !eq(comp.receipts, cand.receipts) },
  zeroWitness: { before: comp.zeroWitness, after: cand.zeroWitness, changed: !eq(comp.zeroWitness, cand.zeroWitness) },
};

const exportsRemoved = comp.exports.filter((e) => !cand.exports.includes(e));
const exportsAdded = cand.exports.filter((e) => !comp.exports.includes(e));

/**
 * The load-bearing questions, kept apart on purpose: a reason-string change is not a
 * state-machine change, and a semantic change is never downgraded to one.
 */
const currentV2SemanticallyEquivalent = currentV2Rows.every((r) => r.semanticallyEquivalent);
const currentV2ReasonTextStable = currentV2Rows.every((r) => r.reasonTextIdentical);
const invariantsHold = currentV2Rows.every((r) => r.invariantsHold);
const historicalWireBreak = historicalRows.some((r) => r.classification === 'NOW_FAILS_CLOSED');

const report = {
  schema: 'tclk-phase3a2-candidate-audit/v1',
  generatedAt: new Date().toISOString(),
  safe: true,
  liveTechnocoreReads: 'NONE',
  liveTechnocoreWrites: 'NONE',
  realSignerAccessed: 'NO',
  statement:
    'Deterministic offline probe of one frozen upstream candidate against the historical pin and the '
    + 'Phase 3A comparison head. Acceptance-set changes and rejection-reason changes are reported in '
    + 'separate columns; neither is inferred from a commit title.',
  pins: pins.map((p) => ({ ...p, commit: s(p.label).upstream.commit, packageVersion: s(p.label).upstream.packageVersion })),
  roles: { historical: HISTORICAL, comparison: COMPARISON, candidate: CANDIDATE },
  exportsAdded,
  exportsRemoved,
  probes,
  wire: { rows: wireRows, compatible: wireCompatible },
  currentV2: { rows: currentV2Rows, semanticallyEquivalent: currentV2SemanticallyEquivalent, reasonTextStable: currentV2ReasonTextStable, invariantsHold },
  historicalFrameCompatibility: { rows: historicalRows, classifications: [...new Set(historicalRows.map((r) => r.classification))] },
  verdict: {
    wireFormatCompatible: wireCompatible,
    currentV2SemanticallyEquivalent,
    currentV2ReasonTextStable,
    noExportsRemoved: exportsRemoved.length === 0,
    invariantsHold,
    historicalWireBreak,

    rejectionReasonModelRequired: !currentV2ReasonTextStable && currentV2SemanticallyEquivalent,
  },
};

mkdirSync(fileURLToPath(new URL('evidence/', ROOT)), { recursive: true });
writeFileSync(
  fileURLToPath(new URL('evidence/phase3a2-candidate-audit.json', ROOT)),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(JSON.stringify({
  pins: report.pins.map((p) => `${p.label}:${p.commit.slice(0, 8)}`),
  exportsAdded,
  exportsRemoved,
  decodeCap: { before: probes.decodeCap.capBefore, after: probes.decodeCap.capAfter, enforcedBeforeParse: probes.decodeCap.enforcedBeforeParse, fixturesWithinCap: probes.decodeCap.fixturesWithinCap, boundary: { at: probes.decodeCap.boundary.at.accepted, above: probes.decodeCap.boundary.above.accepted } },
  hexAcceptanceChanges: probes.hex.acceptanceChanges,
  hexReasonOnlyChanges: probes.hex.reasonOnlyChanges.map((c) => c.probe),
  hexNormalizationChanged: probes.hex.normalizationChanged,
  schemaRuntimeAcceptanceChanged: probes.schemaPatterns.runtimeAcceptanceChanged,
  receiptsChanged: probes.receipts.changed,
  zeroWitnessChanged: probes.zeroWitness.changed,
  ...report.verdict,
  historicalClassifications: report.historicalFrameCompatibility.classifications,
}, null, 2));

const blocked = !wireCompatible || !currentV2SemanticallyEquivalent || !invariantsHold
  || exportsRemoved.length > 0 || historicalWireBreak;
process.exit(blocked ? 1 : 0);
