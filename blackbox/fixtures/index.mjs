// Deterministic fixture transcripts, in two explicitly provenanced sets.
//
//   legacy-v1   the timing these scenarios were authored with, and the timing every accepted
//               Phase 2 / 2.1 replay fingerprint was produced under. Frozen. Only lawful under
//               upstream 81a8346, where a lock at exactly refundAfterMs was still accepted.
//   current-v2  the same scenarios, same frame bytes, re-authored evaluation timing so that a
//               lock is evaluated strictly before refundAfterMs — lawful under both the old pin
//               and current upstream, which correctly refuses a lock once the refund window is
//               open (upstream #43).
//
// Only ONE scenario differs between the sets, and it differs only in *when frames are
// evaluated*, never in what they say: the seven other scenarios are shared by reference so
// there is nothing to drift.
import { tclk } from '../../lab/upstream.mjs';
import { replay } from '../core/replay.mjs';
const P='did:key:z6Mk'+'f'.repeat(44), Q='did:key:z6Mk'+'g'.repeat(44), NOW=1800000000000, SECRET='0x'+'ab'.repeat(32);
export const REFUND_AFTER_MS=NOW+2000;
function base(){const lock=tclk.hashLockFromPreimage(SECRET);const offer=tclk.makeOffer({from:P,role:'payer',amount:'100',asset:'FLOP',lock:'hash',rails:['paper'],claimByMs:NOW+1000,refundAfterMs:REFUND_AFTER_MS,expiresMs:NOW+5000,nonce:'0102030405060708'});const accept=tclk.makeAccept(offer,{from:Q,statement:lock.hash,nonce:'1112131415161718'});const frames=[offer,accept,{type:'lock',from:P,contract:accept.contract,rail:'paper',ref:'paper-ref'}];return {offer,accept,frames,lock,nowMs:NOW};}
const lines=f=>f.map(tclk.encodeFrame);

/** The seven scenarios whose lawfulness never straddles the refund deadline. Set-independent. */
const shared={
 'happy-claim':()=>{const x=base();return {name:'Happy Claim',description:'A valid hash-lock deal reaches claim.',invariant:'Only payee reveal with the matching secret can claim.',lines:lines([...x.frames,{type:'reveal',from:Q,contract:x.accept.contract,secret:SECRET}]),nowMs:x.nowMs}},
 'cancel-before-lock':()=>{const x=base();return {name:'Cancel Before Lock',description:'The offer is cancelled before the lock frame.',invariant:'Cancel is valid only while proposed or accepted.',lines:lines([x.offer,{type:'cancel',from:P,contract:x.accept.contract}]),nowMs:x.nowMs}},
 'wrong-party':()=>{const x=base();return {name:'Wrong Party',description:'A payer attempts to reveal.',invariant:'Only the payee may reveal.',lines:lines([...x.frames,{type:'reveal',from:P,contract:x.accept.contract,secret:SECRET}]),nowMs:x.nowMs}},
 'wrong-secret':()=>{const x=base();return {name:'Wrong Secret',description:'The reveal does not open the published statement.',invariant:'A claim requires a verifying witness.',lines:lines([...x.frames,{type:'reveal',from:Q,contract:x.accept.contract,secret:'0x'+'cd'.repeat(32)}]),nowMs:x.nowMs}},
 'replay-attack':()=>{const x=base();return {name:'Replay Attack',description:'A lock is repeated after the contract is locked.',invariant:'A terminal or already-advanced state does not rewind.',lines:lines([...x.frames,x.frames[2]]),nowMs:x.nowMs}},
 'out-of-order-reveal':()=>{const x=base();return {name:'Out-of-Order Reveal',description:'Reveal arrives before lock.',invariant:'State transitions are ordered and fail closed.',lines:lines([x.offer,x.accept,{type:'reveal',from:Q,contract:x.accept.contract,secret:SECRET}]),nowMs:x.nowMs}},
 'mutated-canonical-frame':()=>{const x=base();const l=lines(x.frames);return {name:'Mutated Canonical Frame',description:'A payload mutation is not silently normalized.',invariant:'Canonical encoding is stable and structural validation is fail closed.',lines:[l[0].replace('"100"','"101"'),...l.slice(1)],nowMs:x.nowMs}},
};

/**
 * The one scenario the upstream tightening touches.
 *
 * Intent, unchanged in both sets: the refund boundary is reached without a reveal, and the payer
 * refund is accepted there. legacy-v1 expressed that with a single clock pinned to the boundary,
 * which also placed the lock at the boundary — legal at 81a8346, unlawful now. current-v2 states
 * the ordering a real deal has: offer, accept and lock at NOW (2000 ms of refund window still to
 * run), refund at exactly refundAfterMs. Nothing is padded to make a test pass; the refund is
 * still evaluated at the earliest instant it is lawful.
 */
const refund=setVersion=>{const x=base();const l=lines([...x.frames,{type:'refund',from:P,contract:x.accept.contract}]);return {name:'Normal Refund',description:'The refund boundary is reached without a reveal.',invariant:'Payer refund is accepted only at/after refundAfterMs; a lock is lawful only strictly before it.',lines:l,nowMs:REFUND_AFTER_MS,schedule:setVersion==='current-v2'?[NOW,NOW,NOW,REFUND_AFTER_MS]:null}};

const tag=(setVersion,factory)=>()=>({fixtureSetVersion:setVersion,...factory()});
const buildSet=setVersion=>Object.fromEntries([['happy-claim',shared['happy-claim']],['normal-refund',()=>refund(setVersion)],...Object.entries(shared).filter(([id])=>id!=='happy-claim')].map(([id,factory])=>[id,tag(setVersion,factory)]));

/** Frozen: reproduces the exact evidence every 81a8346-pinned artifact was built from. */
export const legacyFixtures=buildSet('legacy-v1');
/** Authored for current upstream semantics. This is the default set. */
export const currentFixtures=buildSet('current-v2');
export const fixtures=currentFixtures;
export const fixtureList=Object.keys(fixtures);
export const fixtureSets={'legacy-v1':legacyFixtures,'current-v2':currentFixtures};

/** Replay a fixture with its own declared timing. The only correct way to run one. */
export const replayFixture=(fixture,options={})=>replay(fixture.lines,{nowMs:fixture.nowMs,schedule:fixture.schedule??null,...options});
