import assert from "node:assert/strict";
import { tclk, baseline } from "./upstream.mjs";
import { Recorder, accepts, rejects, throwsWith, rejectsAsync } from "./harness.mjs";

const r = new Recorder();
const PAYER = "did:key:z6Mk" + "f".repeat(44);
const PAYEE = "did:key:z6Mk" + "g".repeat(44);
const NOW = 1_800_000_000_000;
const secret = r.secret("0x" + "ab".repeat(32));
const wrongSecret = "0x" + "cd".repeat(32);
const lock = tclk.hashLockFromPreimage(secret);
const offer = tclk.makeOffer({ from:PAYER, role:"payer", amount:"100", asset:"FLOP", lock:"hash", rails:["paper"], claimByMs:NOW+1000, refundAfterMs:NOW+2000, expiresMs:NOW+500, nonce:"0102030405060708" });
const accept = tclk.makeAccept(offer, { from:PAYEE, statement:lock.hash, nonce:"1112131415161718" });
const open = () => tclk.openContract(offer);
const lockFrame = {type:"lock",from:PAYER,contract:accept.contract,rail:"paper",ref:"paper-ref"};
const reveal = {type:"reveal",from:PAYEE,contract:accept.contract,secret};
const refund = {type:"refund",from:PAYER,contract:accept.contract};
const receipt = {type:"receipt",from:PAYEE,contract:accept.contract,outcome:"claimed"};

await r.case("hash-lock", "offer → accept → lock → reveal → claimed", () => {
  let s=open(); s=accepts(tclk,s,accept,NOW,"accepted"); s=accepts(tclk,s,lockFrame,NOW,"locked"); s=accepts(tclk,s,reveal,NOW+100,"claimed");
  const after=tclk.applyFrame(s,receipt,NOW+100); assert.equal(after.ok,true); assert.equal(after.state.status,"claimed");
  return { statuses:["proposed","accepted","locked","claimed"], receipt:true, contract:accept.contract, offer:offer.id };
});
await r.case("refund", "offer → accept → lock → deadline → refunded", () => { let s=open(); s=accepts(tclk,s,accept,NOW,"accepted"); s=accepts(tclk,s,lockFrame,NOW,"locked"); s=accepts(tclk,s,refund,NOW+2000,"refunded"); return {statuses:["proposed","accepted","locked","refunded"]}; });
await r.case("cancel", "cancel before lock", () => { let s=open(); s=accepts(tclk,s,{type:"cancel",from:PAYER,contract:accept.contract},NOW,"cancelled"); return {status:s.status}; });
const negative=(name, frame, now=NOW)=>r.case("fail-closed",name,()=>rejects(tclk, (()=>{let s=open();s=accepts(tclk,s,accept,NOW,"accepted");s=accepts(tclk,s,lockFrame,NOW,"locked");return s;})(),frame,now));
await negative("wrong party", {...reveal,from:PAYER});
await negative("wrong secret", {...reveal,secret:wrongSecret});
await negative("replayed lock", lockFrame);
await r.case("fail-closed","out-of-order reveal",()=>{ let s=open(); s=accepts(tclk,s,accept,NOW,"accepted"); return rejects(tclk,s,reveal,NOW); });
await r.case("fail-closed","malformed and unknown fields",()=>{ assert.equal(tclk.tryDecodeFrame("tclk1 {bad"),null); const x={...offer,unknown:true}; assert.throws(()=>tclk.validateFrame(x),/unknown field/); return {malformedDecode:null,unknownFieldRejected:true}; });
await r.case("fail-closed","mutated canonical frame",()=>{ const line=tclk.encodeFrame(offer); assert.equal(tclk.tryDecodeFrame(line.replace('"100"','"101"')),null); return {originalLineHash:tclk.offerId({...offer, id:undefined}),mutationRejected:true}; });
await r.case("canonicalization","sorted compact and ASCII escaping",()=>{ assert.equal(tclk.canonicalJson({z:1,a:2,u:undefined}),'{"a":2,"z":1}'); const o=tclk.makeOffer({from:PAYER,role:"payer",amount:"1",asset:"FLOP",lock:"hash",rails:["paper"],claimByMs:NOW+100,refundAfterMs:NOW+200,expiresMs:NOW+50,job:{proto:"a2a",id:"t"+String.fromCharCode(0xe2)+"che"},nonce:"aabbccdd"}); const line=tclk.encodeFrame(o); assert.match(line,/\\u00e2/); return {sorted:true,compact:true,undefinedOmitted:true,nonAsciiEscaped:true,asciiLine:true}; });
await r.case("paper-rail","lock → claim → refund predicates (no value)",async()=>{const notes=new tclk.MemoryNoteStore(); let now=NOW; const rail=new tclk.PaperRail(notes,()=>now); const terms={contract:accept.contract,lock:"hash",statement:lock.hash,amount:"100",asset:"FLOP",payer:PAYER,payee:PAYEE,claimByMs:NOW+1000,refundAfterMs:NOW+2000}; const ref=await rail.lock(terms); assert.equal(await rail.verifyLock(terms,ref),true); await rail.claim(ref,secret); assert.equal((await rail.read(ref)).status,"claimed"); const notes2=new tclk.MemoryNoteStore(); now=NOW; const rail2=new tclk.PaperRail(notes2,()=>now); const ref2=await rail2.lock(terms); now=NOW+2000; await rail2.refund(ref2); assert.equal((await rail2.read(ref2)).status,"refunded"); return {lock:true,claim:true,refund:true,valueMoved:false,worldWritableRecord:true};});
const evidence={schemaVersion:1,upstream:{repository:baseline.repository,branch:baseline.branch,commit:baseline.commit,packageVersion:baseline.packageVersion},generatedAt:new Date().toISOString(),safe:true,summary:r.summary(),sections:r.sections()};
assert.equal(r.failed,0); const fs=await import("node:fs/promises"); await fs.mkdir(new URL("../evidence/",import.meta.url),{recursive:true}); await fs.writeFile(new URL("../evidence/offline-rehearsal.json",import.meta.url),JSON.stringify(r.redact(evidence),null,2)+"\n"); console.log(JSON.stringify(r.summary()));
