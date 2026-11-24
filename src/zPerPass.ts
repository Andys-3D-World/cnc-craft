/**
 * Z PER PASS (laser): how far Z goes down before a pass so that the focus follows the cut.
 *
 * Z moves down by itself here, so the limits are narrow on purpose: at most 2 mm per pass, at most 5 mm in all and
 * never more than the material is thick (if a thickness is given). 0 = no Z move at all.
 */
export const Z_STEP_MAX = 2, Z_TOTAL_MAX = 5;

export function cleanZStep(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(Z_STEP_MAX, Math.max(0, n)) * 100) / 100 : 0;
}

/** Depth below the start height for every pass (first pass 0, positive numbers = lower) */
export function zDepths(passes: number, step: number, thickness = 0): number[] {
  const s = cleanZStep(step), limit = thickness > 0 ? Math.min(Z_TOTAL_MAX, thickness) : Z_TOTAL_MAX;
  return Array.from({ length: Math.max(1, Math.floor(passes)) }, (_, i) => Math.round(Math.min(limit, i * s) * 1000) / 1000);
}
