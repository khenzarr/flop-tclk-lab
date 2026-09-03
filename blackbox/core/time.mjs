import { replay } from './replay.mjs';
export const timeTravel=(lines,points)=>points.map(nowMs=>({nowMs,replay:replay(lines,{nowMs,source:'simulated-time'})}));