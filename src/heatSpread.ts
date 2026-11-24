/**
 * SPREAD THE HEAT (plasma): order of the cuts so that the torch does not stay in one spot of the sheet.
 *
 * Always the cut that is farthest from the last few cuts comes next. Holes still come before the part they are in
 * (the same rule as in cutOrder.ts). Rapid moves get longer, that is the price. No machine code in here.
 */
import { precedence, type CutItem } from "./cutOrder.ts";
import type { Pt } from "./shapeTransform";

/** How many of the last cuts count, and how much less an older one weighs (it had time to cool) */
const WEIGHTS = [1, 1.5, 2, 3];

const centre = (pts: Pt[]): Pt => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
};

/** Indexes of `items` in the new order. Starts with the first allowed one nearest to `from` */
export function spreadOrder(items: CutItem[], from: Pt): number[] {
  const n = items.length, preds = precedence(items), mid = items.map(it => centre(it.pts));
  const left = preds.map(p => p.length), done = new Array<boolean>(n).fill(false);
  const succ: number[][] = items.map(() => []);
  preds.forEach((p, b) => p.forEach(a => succ[a].push(b)));
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i] || left[i]) continue;
      let score: number;
      if (!out.length) score = -Math.hypot(items[i].entry.x - from.x, items[i].entry.y - from.y);
      else {
        score = Infinity;
        for (let w = 0; w < WEIGHTS.length && w < out.length; w++) {
          const q = mid[out[out.length - 1 - w]];
          score = Math.min(score, Math.hypot(mid[i].x - q.x, mid[i].y - q.y) * WEIGHTS[w]);
        }
      }
      if (score > bestScore + 1e-9) { bestScore = score; best = i; }
    }
    if (best < 0) return items.map((_, i) => i); // cannot happen: the rule has no circles
    done[best] = true;
    out.push(best);
    for (const b of succ[best]) left[b]--;
  }
  return out;
}
