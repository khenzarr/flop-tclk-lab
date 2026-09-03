import { provenanceOf } from './provenance.mjs';

const TERMINAL = new Set(['claimed', 'refunded', 'cancelled']);
const STATUS_FOR_FRAME = {offer:'proposed', accept:'accepted', lock:'locked', reveal:'claimed', refund:'refunded', cancel:'cancelled'};

const upper = value => String(value ?? 'unavailable').toUpperCase();
// end=0 means prefix-only. Guard it explicitly: slice(-0) is slice(0) and would return the whole
// string, which made the pin label print the short pin followed by the full sha.
const short = (value, start=10, end=6) => {
  if (!value) return '—';
  if (value.length <= start + end + 1) return value;
  return end > 0 ? `${value.slice(0,start)}…${value.slice(-end)}` : value.slice(0,start);
};
const stateAt = (result, index) => result.steps[Math.max(0, Math.min(index, result.steps.length - 1))]?.stateAfter ?? null;

export function frameEvents(result) {
  return result.steps.map(step => ({
    index:step.index,
    type:step.type ?? 'malformed',
    actor:step.actor,
    verdict:step.ok ? (step.terminal ? 'terminal' : 'accepted') : 'rejected',
    accepted:step.ok,
    rejected:!step.ok,
    terminal:step.ok && step.terminal,
    stateBefore:step.stateBefore?.status ?? null,
    stateAfter:step.stateAfter?.status ?? null,
    stateUnchanged:step.stateDigestBefore === step.stateDigestAfter,
    reason:step.reason,
    canonicalFrameHash:step.canonicalFrameHash,
    canonical:step.canonical
  }));
}

function routeFor(result) {
  const decoded = new Set(result.steps.map(step => step.type).filter(Boolean));
  const observed = result.steps.filter(step => step.ok).map(step => step.stateAfter?.status).filter(Boolean);
  let terminal = observed.find(status => TERMINAL.has(status));
  if (!terminal) {
    if (decoded.has('cancel')) terminal='cancelled';
    else if (decoded.has('refund')) terminal='refunded';
    else if (decoded.has('reveal')) terminal='claimed';
  }
  if (terminal === 'cancelled') return ['proposed','cancelled'];
  const route=['proposed','accepted','locked'];
  if (terminal) route.push(terminal);
  return route;
}

export function flightPath(result, frameIndex=result.steps.length-1) {
  const visible=result.steps.slice(0,frameIndex+1);
  const reached=new Map();
  for (const step of visible) if (step.ok && step.stateAfter?.status && !reached.has(step.stateAfter.status)) reached.set(step.stateAfter.status,step.index);
  const current=stateAt(result,frameIndex)?.status ?? null;
  return routeFor(result).map((status,index) => ({
    status,
    index,
    reached:reached.has(status),
    reachedAt:reached.get(status) ?? null,
    current:status === current,
    terminal:TERMINAL.has(status),
    pending:!reached.has(status),
    label:upper(status)
  }));
}

export function boundary(result, frameIndex=result.steps.length-1) {
  const step=result.steps[Math.max(0,Math.min(frameIndex,result.steps.length-1))];
  const before=step.stateBefore?.status ?? 'no contract state';
  const after=step.stateAfter?.status ?? 'no contract state';
  const unchanged=step.stateDigestBefore === step.stateDigestAfter;
  return {
    frameIndex:step.index,
    before,
    after,
    event:step.type ?? 'malformed frame',
    actor:step.actor ?? 'unavailable',
    verdict:step.ok ? 'accepted' : 'rejected',
    reason:step.reason ?? 'accepted by pinned upstream',
    stateUnchanged:unchanged,
    stateAdvanced:step.ok && before !== after,
    terminal:step.ok && step.terminal,
    canonicalFrameHash:step.canonicalFrameHash,
    canonical:step.canonical
  };
}

function roleFor(step) {
  const state=step.stateAfter ?? step.stateBefore;
  if (!step.actor || !state) return null;
  if (step.actor === state.payer) return 'PAYER';
  if (step.actor === state.payee) return 'PAYEE';
  return 'UNBOUND ACTOR';
}

export function laneTracks(result, frameIndex=result.steps.length-1) {
  const visible=result.steps.slice(0,frameIndex+1);
  const protocol=visible.map(step => ({index:step.index,label:step.type ? upper(step.type) : 'MALFORMED',detail:step.ok ? upper(step.stateAfter?.status) : 'REJECTED',verdict:step.ok ? 'accepted' : 'rejected'}));
  const custody=visible.map(step => ({step,role:roleFor(step)})).filter(item => item.role).map(({step,role}) => ({index:step.index,label:role,detail:short(step.actor),verdict:step.ok ? 'observed' : 'rejected'}));
  const rail=[];
  for (const step of visible) {
    if (step.ok && step.type === 'lock' && step.stateAfter?.rail) rail.push({index:step.index,label:'LOCK OBSERVED',detail:`${step.stateAfter.rail} · ${short(step.stateAfter.railRef)}`,verdict:'observed'});
    if (step.ok && step.type === 'receipt' && step.stateAfter?.rail) rail.push({index:step.index,label:'RECEIPT OBSERVED',detail:`${step.stateAfter.rail} · ${short(step.stateAfter.railRef)}`,verdict:'observed'});
  }
  return {protocol,custody,rail};
}

export function invariantState(record, frameIndex=record.result.steps.length-1) {
  const selected=boundary(record.result,frameIndex);
  return {
    statement:record.invariant,
    expected:selected.verdict === 'rejected' ? `STATE REMAINS ${upper(selected.before)}` : `UPSTREAM RESULT IS AUTHORITATIVE`,
    actual:upper(selected.after),
    pass:selected.verdict === 'rejected' ? selected.stateUnchanged : true,
    stateMutated:selected.verdict === 'rejected' ? !selected.stateUnchanged : selected.stateAdvanced
  };
}

export function chaosResult(record, frameIndex=record.result.steps.length-1) {
  const selected=boundary(record.result,frameIndex);
  const rejected=record.result.steps.find(step => !step.ok);
  const target=rejected ? boundary(record.result,rejected.index) : selected;
  return {
    mutation:record.name,
    expectedInvariant:record.invariant,
    actualUpstreamResult:target.reason,
    before:upper(target.before),
    after:upper(target.after),
    stateMutated:!target.stateUnchanged,
    pass:target.verdict === 'rejected' && target.stateUnchanged,
    boundaryIndex:target.frameIndex
  };
}

/**
 * Provenance is derived here, at read time, from the sha the capsule already recorded — the
 * capsule format is unchanged, so a capsule written under the old pin gains a correct
 * HISTORICAL BASELINE label without one byte of it being rewritten.
 */
export function capsuleView(capsule) {
  const provenance = provenanceOf(capsule.upstreamSha);
  return {
    version:'BLACKBOX EVIDENCE v1',
    upstreamSha:capsule.upstreamSha,
    baselineClass:provenance.baselineClass,
    evidenceValidity:provenance.evidenceValidity,
    pinLabel:`PINNED TCLK ${short(capsule.upstreamSha, 7, 0)}`,
    provenanceNote:provenance.isCurrentPin
      ? 'Replayed against the current pinned implementation.'
      : 'Replayed against an earlier pinned implementation. Valid evidence against that pin; not a claim about current upstream behaviour.',
    replayFingerprint:capsule.replayFingerprint,
    frameCount:capsule.frameCount,
    acceptedCount:capsule.acceptedFrameCount,
    rejectedCount:capsule.rejectedFrameCount,
    terminalState:capsule.terminalState,
    invariantResultCount:Object.keys(capsule.invariantChecks).length,
    invariantPass:Object.values(capsule.invariantChecks).every(Boolean),
    completenessWarning:capsule.completenessLimitations.join(' ')
  };
}

export function reconstruct(result, frameIndex) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= result.steps.length) throw new RangeError('blackbox: frame index out of range');
  return {frameIndex,state:stateAt(result,frameIndex),path:flightPath(result,frameIndex),boundary:boundary(result,frameIndex),lanes:laneTracks(result,frameIndex),events:frameEvents(result).slice(0,frameIndex+1)};
}

export { STATUS_FOR_FRAME, TERMINAL, short, upper };