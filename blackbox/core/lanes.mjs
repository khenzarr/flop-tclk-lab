import { laneTracks } from './model.mjs';

/** Evidence-only lane projection. Kept as the Phase 2 public entry point. */
export function lanes(result, frameIndex=result.steps.length-1) {
  return laneTracks(result,frameIndex);
}