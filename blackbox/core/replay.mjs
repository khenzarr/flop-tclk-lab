import { createHash } from 'node:crypto';
import { tclk, baseline } from '../../lab/upstream.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => tclk.canonicalJson(value);
const digest = state => sha256(json({status:state.status, contract:state.contract ?? null, statement:state.statement ?? null, rail:state.rail ?? null, railRef:state.railRef ?? null, secretPresent:state.secret !== undefined}));
const safeState = state => ({status:state.status, contract:state.contract ?? null, offerId:state.offer.id, payer:state.payerDid ?? null, payee:state.payeeDid ?? null, rail:state.rail ?? null, railRef:state.railRef ?? null, secretPresent:state.secret !== undefined});

/**
 * Resolve the per-frame evaluation clock.
 *
 * A single `nowMs` is enough for any transcript whose lawfulness does not straddle a deadline.
 * A refund transcript does straddle one: under current upstream the lock frame must be evaluated
 * strictly before refundAfterMs while the refund frame must be evaluated at or after it, and no
 * flat clock satisfies both. `schedule` carries one evaluation time per frame so that ordering can
 * be stated instead of collapsed. It is validated fail-closed: exact arity, integer milliseconds,
 * monotonic non-decreasing. Omitted, nothing changes — including the recorded evidence bytes.
 */
function evaluationClock(schedule, frameCount, nowMs) {
  if (schedule === null || schedule === undefined) return () => nowMs;
  if (!Array.isArray(schedule) || schedule.length !== frameCount) throw new Error(`blackbox: schedule must carry exactly one evaluation time per frame (${frameCount})`);
  schedule.forEach((at, index) => {
    if (!Number.isSafeInteger(at)) throw new Error(`blackbox: schedule[${index}] is not an integer millisecond`);
    if (index > 0 && at < schedule[index - 1]) throw new Error(`blackbox: schedule moves backwards at index ${index}`);
  });
  return index => schedule[index];
}

export function replay(lines, {nowMs=1700000000000, schedule=null, source='offline'}={}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('blackbox: transcript must contain frames');
  const clockAt=evaluationClock(schedule, lines.length, nowMs);

  let state = null; const steps=[]; let offerId=null;
  lines.forEach((line,index) => {
    const before = state ? safeState(state) : null; const beforeDigest = state ? digest(state) : null;
    const rawLineHash=sha256(line); let frame=null, decodeReason;
    try { frame=tclk.decodeFrame(line); } catch(e) { decodeReason=e instanceof Error?e.message:'invalid frame'; }
    let ok=false, reason=decodeReason, after=before;
    if(frame) {
      if(!state) { try { state=tclk.openContract(frame); ok=true; offerId=frame.id; after=safeState(state); } catch(e) { reason=e.message; } }
      else { const result=tclk.applyFrame(state,frame,clockAt(index)); state=result.state; ok=result.ok; reason=result.reason; after=safeState(state); }

    } else if(!state) reason=reason ?? 'no contract open yet';
    const encoded=frame ? tclk.encodeFrame(frame) : null;
    const canonicalFrameHash=encoded ? sha256(encoded) : null;
    const canonical=encoded === line; const stateDigestAfter=state?digest(state):null;
    steps.push({index,type:frame?.type ?? null,actor:frame?.from ?? null,ok,reason:ok?null:reason ?? 'rejected', stateBefore:before,stateAfter:after, stateDigestBefore:beforeDigest,stateDigestAfter, terminal:after ? ['claimed','refunded','cancelled'].includes(after.status) : false, rawLineHash,canonicalFrameHash,canonical,contract:frame?.contract ?? frame?.id ?? offerId, source});
  });
  if(!state) throw new Error('blackbox: transcript contains no valid offer');
  // `schedule` is recorded only when one was supplied, so a flat-clock replay keeps the exact
  // evidence bytes — and therefore the exact fingerprint — it had before schedules existed.
  const evidence={version:'1',upstream:{repository:baseline.repository ?? 'https://github.com/flop-labs/tclk',sha:baseline.commit,package:'@flop-labs/tclk@0.1.0'},nowMs,...(schedule?{schedule}:{}),steps,terminalState:state.status};

  const blackboxReplayHash=sha256(`FLOPLAB::blackbox::replay::v1|${json(evidence)}`);
  return { ...evidence, state:safeState(state), blackboxReplayHash };
}

export const classify = step => step.ok ? 'accepted' : (step.stateDigestBefore===step.stateDigestAfter ? 'rejected-state-unchanged' : 'rejected-state-changed');
export { sha256, json };