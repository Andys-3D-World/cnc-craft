/**
 * ONION SKIN (router) – the numbers (no UI, no DOM; tests in tests/onionSkin.test.ts)
 *
 * When a part is cut out, the cut can stop a little above the underside of the material. The thin skin that is
 * left holds the part (and the waste piece inside a hole) instead of holding tabs. The user breaks or sands the
 * skin away afterwards – or lets the program cut it in a last light pass at the very end of the job.
 *
 * Per shape (like the holding tabs):
 *   skinH     thickness of the skin in mm (missing or 0 = off: G-code exactly as before)
 *   skinCut   true = cut the skin at the end of the job
 *   skinFeed  feed of that last pass in mm/min (missing = half the normal feed), never faster than the normal feed
 *
 * The router has no material thickness setting: the cut depth of the shape IS the underside of the material.
 * So the deepest normal pass ends at depth − skin, and the cutter never goes below the shape's cut depth.
 * Only two-sided milling knows the real thickness; there the skin is measured from the real underside
 * (`stockUnder`), so the small extra depth of a through cut does not eat the skin.
 */

export const SKIN_DEFAULT = 0.3;
export const SKIN_MIN = 0.05;
export const SKIN_MAX = 3;
/** Slowest feed of the last pass (mm/min) */
export const SKIN_FEED_MIN = 10;

export interface SkinSettings { h: number; cut: boolean; feed: number }   // feed 0 = automatic

const fin = (v: unknown): number => (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN;

/** Settings of a shape, cleaned (they can come from a project file). null = no onion skin */
export function skinSettings(shape: any): SkinSettings | null {
  const h = fin(shape?.skinH);
  if (!(h > 0)) return null;
  const f = fin(shape.skinFeed);
  return { h: Math.min(SKIN_MAX, Math.max(SKIN_MIN, h)), cut: shape.skinCut === true, feed: f > 0 ? Math.max(SKIN_FEED_MIN, f) : 0 };
}

/** First operation: no mode means "outside". Further operations (shape.ops) always name their kind */
const isContour = (mode: unknown) => (mode || "outside") === "outside" || mode === "inside";
const isContourOp = (o: any) => !!o && (o.kind === "outside" || o.kind === "inside");
const isClosed = (s: any) => s?.type === "circle" || (s?.type === "polyline" && s.closed === true && Array.isArray(s.points) && s.points.length >= 3);
const depthOf = (v: unknown) => { const n = fin(v); return Number.isNaN(n) ? NaN : Math.min(0, n); };

/** Can this shape be cut out with a skin at all? Closed shape, cut outside or inside (also by a further operation) */
export function skinFits(shape: any): boolean {
  if (!isClosed(shape)) return false;
  if (isContour(shape.millingMode)) return true;
  return Array.isArray(shape.ops) && shape.ops.some(isContourOp);
}

/**
 * What the skin means for one cut. `shape` is a shape or the copy made for a further operation (opOf = original).
 *   "skin"     this cut gets the skin
 *   "plain"    cut as always (no skin set, another kind of cut, or a shallower contour of a shape whose deeper
 *              contour gets the skin – only the cut that goes through needs it)
 *   "ignored"  a skin is set but nothing of this shape can use it (open line, pocket, drilling …) → worth a warning
 */
export function skinRole(shape: any): "skin" | "plain" | "ignored" {
  const base = shape?.opOf ?? shape;
  if (!skinSettings(base) || shape?.restOf) return "plain";
  if (!skinFits(base)) return shape.opOf ? "plain" : "ignored";
  if (!isContour(shape.millingMode)) return "plain";
  // depths of all contour cuts of this shape: the deepest one (and any equally deep) gets the skin
  const depths: number[] = [];
  if (isContour(base.millingMode)) depths.push(depthOf(base.millingDepth));
  if (Array.isArray(base.ops)) for (const o of base.ops) if (isContourOp(o)) depths.push(depthOf(o.depth ?? -1));
  const known = depths.filter(d => !Number.isNaN(d));
  const own = depthOf(shape.millingDepth);
  if (!known.length || Number.isNaN(own)) return "skin";
  return own <= Math.min(...known) + 1e-9 ? "skin" : "plain";
}

/**
 * Z levels of a cut down to `target` in steps of `stepZ` – the scheme cam.ts has always used:
 * full steps, the last pass takes what is left. `from` = Z the cut starts at (0 = top of the material).
 */
export function depthPasses(target: number, stepZ: number, from = 0): number[] {
  const passes: number[] = [];
  if (target >= from) {
    passes.push(target === 0 ? 0 : target);
  } else {
    let z = from - stepZ;
    while (z > target + 0.001) { passes.push(z); z -= stepZ; }
    passes.push(target);
  }
  return passes;
}

export interface SkinPlan {
  floor: number;       // Z of the deepest normal pass (negative)
  through: number;     // Z of the shape's cut depth – the last pass ends here, nothing ever goes deeper
  stock: number;       // underside of the material as a positive depth (what the skin is measured from)
  skin: number;        // thickness of the skin that is really left (mm)
  passes: number[];    // normal passes, the last one is `floor`
  final: number[];     // passes of the last cut from `floor` down to `through` ([] = the skin stays)
}

/**
 * Why a skin cannot be made as asked:
 *   "tooThick"    the skin is as thick as the cut is deep → nothing would be cut; the shape is left out
 *   "notThrough"  the cut does not reach the underside (only known with two-sided milling) → cut as always, no skin
 *   "thick"       the skin is thicker than one depth step (just a note; the last cut then takes several steps)
 */
export type SkinProblem = "tooThick" | "notThrough" | "thick";

/**
 * Passes of a cut with onion skin.
 * @param depth       cut depth of the shape (negative, like millingDepth)
 * @param stepZ       depth per pass (positive)
 * @param stockUnder  two-sided milling: material left under the top at this place (thickness minus what the
 *                    other side removes there), positive mm. Missing = the cut depth is the underside.
 * The floor is rounded to 0.01 mm towards the thicker skin (a circle's depth is written with two decimals).
 */
export function skinPlan(depth: number, stepZ: number, s: SkinSettings, stockUnder?: number): { plan: SkinPlan | null; problem: SkinProblem | null } {
  const D = -Math.min(0, depth);
  const known = typeof stockUnder === "number" && Number.isFinite(stockUnder) && stockUnder > 0;
  if (known && D < stockUnder! - 1e-6) return { plan: null, problem: "notThrough" };
  const stock = known ? Math.min(D, stockUnder!) : D;
  const floorD = Math.floor((stock - s.h) * 100 + 1e-6) / 100;
  if (!(floorD >= 0.01)) return { plan: null, problem: "tooThick" };
  const step = Math.max(0.05, Math.abs(stepZ));
  const floor = -floorD, through = -D;
  return {
    plan: {
      floor, through, stock, skin: +(stock - floorD).toFixed(6),
      passes: depthPasses(floor, step),
      final: s.cut ? depthPasses(through, step, floor) : [],
    },
    problem: s.h > step + 1e-9 ? "thick" : null,
  };
}

/** Feed of the last pass: the wish, but never faster than the normal feed; without a wish half the normal feed */
export function skinFeed(s: SkinSettings, normalFeed: number): number {
  const f = s.feed > 0 ? Math.min(s.feed, normalFeed) : Math.round(normalFeed / 2);
  return Math.max(1, Math.min(normalFeed, Math.max(SKIN_FEED_MIN, f)));
}

// ---------------------------------------------------------------------
// The notes in the G-code – the simulation and the setup sheet read the onion skin from them, so it also works
// for a program that was saved and loaded again
// ---------------------------------------------------------------------

export interface SkinNotePatterns { note: RegExp[]; cut: RegExp[] }

const NUM = "\\d+(?:\\.\\d+)?";
const literal = (s: string) => s.toLowerCase().replace(/[.*+?^$()|[\]\\]/g, "\\$&");

/**
 * Patterns from the texts of the two notes (every built-in language, already turned to plain ASCII like the
 * G-code comments): `note` = "onion skin {h} mm …, material {t} mm" at a shape, `cut` = the heading of a last pass.
 */
export function skinNotePatterns(noteTexts: string[], cutTexts: string[]): SkinNotePatterns {
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    note: uniq(noteTexts).filter(s => s.includes("{t}") && s.includes("{h}")).map(s => new RegExp(
      literal(s).replace(/\{t\}/g, `(?<t>${NUM})`).replace(/\{h\}/g, `(?<h>${NUM})`).replace(/\{\w+\}/g, ".*?"))),
    cut: uniq(cutTexts).map(s => new RegExp(literal(s).replace(/\{\w+\}/g, NUM))),
  };
}

/** What a program says about its onion skins */
export interface SkinInfo {
  stock: number;     // thickest material named (mm) – the simulation shows the skin against it
  hMin: number;      // thinnest and thickest skin (mm)
  hMax: number;
  shapes: number;    // cuts that leave a skin
  cut: number;       // of those: cut through at the end of the program
}

/** Read the notes. null = the program has no onion skin. Only comment lines are looked at (fast on long programs) */
export function skinFromGcode(lines: ArrayLike<string>, pats: SkinNotePatterns): SkinInfo | null {
  const info: SkinInfo = { stock: 0, hMin: Infinity, hMax: 0, shapes: 0, cut: 0 };
  if (!pats.note.length) return null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.charCodeAt(0) !== 40) continue;   // "("
    const txt = raw.toLowerCase();
    let hit = false;
    for (const r of pats.note) {
      const m = txt.match(r);
      if (!m?.groups) continue;
      const t = parseFloat(m.groups.t), h = parseFloat(m.groups.h);
      if (!(t > 0) || !(h > 0)) continue;
      info.shapes++;
      info.stock = Math.max(info.stock, t);
      info.hMin = Math.min(info.hMin, h);
      info.hMax = Math.max(info.hMax, h);
      hit = true;
      break;
    }
    if (!hit && pats.cut.some(r => r.test(txt))) info.cut++;
  }
  return info.shapes ? info : null;
}
