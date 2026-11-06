/**
 * RELIEF: volles Raster rechnen (im Hintergrund-Thread, damit das Fenster nicht einfriert).
 * Dieselbe Rechnung ohne Worker, falls die WebView keinen startet.
 */
import { type HeightField, fieldToMesh } from "./heightField.ts";
import { type ImageReliefOpts, grayToField } from "./imageRelief.ts";
import { type VPt, type VectorReliefOpts, loopsToField } from "./vectorRelief.ts";

export type ReliefJob =
  | { kind: "image"; gray: Float32Array; sw: number; sh: number; opts: ImageReliefOpts }
  | { kind: "vector"; loops: VPt[][]; opts: VectorReliefOpts };

export interface ReliefBuilt { field: HeightField; pos: Float32Array; x0: number; y0: number; flat: boolean }

export function buildRelief(job: ReliefJob): ReliefBuilt | null {
  if (job.kind === "image") {
    const { field, flat } = grayToField(job.gray, job.sw, job.sh, job.opts);
    return { field, pos: fieldToMesh(field), x0: 0, y0: 0, flat };
  }
  const r = loopsToField(job.loops, job.opts);
  return r && { field: r.field, pos: fieldToMesh(r.field), x0: r.x0, y0: r.y0, flat: r.flat };
}
