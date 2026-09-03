import { replay } from './replay.mjs';
export const mutations=[
  ['replay previous frame', lines=>lines.length>1?[...lines.slice(0,2),...lines.slice(1)]:lines],
  ['wrong party', lines=>lines.map((x,i)=>i===lines.length-1?x.replace(/"from":"[^"]+"/,'"from":"did:key:z6Mk11111111111111111111111111111111111111111111"'):x)],
  ['wrong secret', lines=>lines.map(x=>x.includes('"secret"')?x.replace(/0x[0-9a-f]{64}/,'0x'+'0'.repeat(64)):x)],
  ['out-of-order reveal', lines=>lines.length>3?[lines[0],lines[1],lines[3],lines[2]]:lines],
  ['mutated canonical payload', lines=>lines.map((x,i)=>i===0?x.replace('"amount":"100"','"amount":"101"'):x)],
  ['duplicate terminal action', lines=>[...lines,...lines.slice(-1)],
  ],
  ['malformed frame', lines=>[...lines,'tclk1 {"type":"reveal"}']],
  ['unknown field', lines=>lines.map((x,i)=>i===0?x.replace(/}$/,',"unknown":"x"}'):x)],
];
export function runChaos(lines, options={}) { return mutations.map(([name,mutate])=>{const mutated=mutate(lines);let result;try{result=replay(mutated,options)}catch(e){result={error:e.message,steps:[]}};const rejected=result.steps?.find(s=>!s.ok);return {name,expectedInvariant:'Invalid frames must not mutate contract state',actualResult:rejected?.reason??result.terminalState,stateMutated:rejected ? rejected.stateDigestBefore!==rejected.stateDigestAfter : false,pass:Boolean(rejected)&&! (rejected.stateDigestBefore!==rejected.stateDigestAfter),replay:result}}); }