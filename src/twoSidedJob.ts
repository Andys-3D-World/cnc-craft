/**
 * TWO-SIDED MILLING – from the drawing to the two programs (maths in twoSided.ts)
 *
 * Each bed keeps two lists of shapes: front and back (editor/beds.ts). A program is built from one list only, in
 * the coordinates that list is drawn in – the G-code generator mirrors nothing. This file adds what belongs to
 * a side: the pin holes (front program), the note at the top of the program and the warnings that need both sides.
 */
import { t, tMm, ascii } from "./i18n/i18n";
import { bedSetup, twoSidedOn, viewSide, sideShapes } from "./editor/beds";
import { bedSizeMm } from "./editor/editorState";
import { isLaser, isPlasma } from "./machineMode";
import { rotary } from "./rotary";
import { expandOps } from "./ops";
import { isKeepOut } from "./keepOut";
import { tabSettings } from "./tabs";
import { offsetPolygon } from "./polyOffset";
import { toolForShape, cutDiameter, getTool, activeTool, type MillingTool } from "./toolLibrary";
import { MM_TO_PIXEL, shapeBounds, shapeToPaths } from "./shapeTransform";
import {
  depthIssues, mirrorPoint, otherSideDepth, pinCut, pinIssues, throughDepth,
  type PinObstacle, type Pt, type Removal, type Side, type TwoSidedSetup,
} from "./twoSided";

/** Setup of the active bed when two-sided milling applies (router only, no rotary axis) */
export function activeSetup(): TwoSidedSetup | null {
  if (!twoSidedOn() || isLaser() || isPlasma() || rotary.on) return null;
  return bedSetup();
}

/** Everything that changes the two programs but is not a shape (for "is the built job still current?") */
export function twoSidedFingerprint(): string {
  const s = activeSetup();
  return s ? JSON.stringify([s, viewSide()]) : "";
}

const mm = (p: { x: number; y: number }): Pt => ({ x: p.x / MM_TO_PIXEL, y: p.y / MM_TO_PIXEL });
const depthOf = (s: any): number => Math.abs(typeof s.millingDepth === "number" && Number.isFinite(s.millingDepth) ? s.millingDepth : 2);
const cutShapes = (list: any[]) => expandOps(list.filter(s => !isKeepOut(s) && s.type !== "image"));

/** Tool that drills the pin holes: the chosen one, otherwise the standard tool */
export function pinTool(s: TwoSidedSetup): MillingTool | null {
  return getTool(s.pinToolId) || activeTool || null;
}

/** The pin holes as shapes of the front program (circles; cut as drilled hole, circle path or small pocket) */
export function pinShapes(s: TwoSidedSetup): { shapes: any[]; tooBig: boolean } {
  if (!s.pinsOn || !s.pins.length) return { shapes: [], tooBig: false };
  const tool = pinTool(s);
  const cut = pinCut(s.pinDia, tool ? cutDiameter(tool) : 3, tool?.type === "drill");
  if (cut === "tooBig") return { shapes: [], tooBig: true };
  const r = (s.pinDia / 2) * MM_TO_PIXEL;
  return {
    tooBig: false,
    shapes: s.pins.map((p, i) => ({
      id: `two-pin-${i + 1}`, type: "circle", x: p.x * MM_TO_PIXEL, y: p.y * MM_TO_PIXEL, w: r, h: r,
      millingMode: cut, millingDepth: -(s.thickness + s.pinDepth), toolId: tool?.id, pin: i + 1,
    })),
  };
}

interface Cut { removal: Removal; label: string }

/** What each side removes, all in the front frame (back shapes are turned back) */
function cutsOf(front: any[], back: any[], s: TwoSidedSetup): Cut[] {
  const out: Cut[] = [];
  const add = (list: any[], side: Side) => {
    const turn = (p: Pt): Pt => (side === "back" ? mirrorPoint(p, s) : p);
    for (const e of cutShapes(list)) {
      const mode = e.millingMode || "outside";
      if (mode === "chamfer" || mode === "thread") continue;   // shallow edge work
      const path = shapeToPaths(e)[0];
      const b = shapeBounds(e);
      if (!path || path.pts.length < 2 || !b) continue;
      const tool = toolForShape(e), dia = tool ? cutDiameter(tool) : 3, depth = depthOf(e);
      const own = path.pts.map(mm);                              // as drawn on its own side
      const cx = (b.minX + b.maxX) / 2 / MM_TO_PIXEL, cy = (b.minY + b.maxY) / 2 / MM_TO_PIXEL;
      const label = t("two.shapeAt", { side: t(side === "front" ? "two.front" : "two.back"), mode: t("two.mode." + (["outside", "inside", "pocket", "drill", "face", "vcarve"].includes(mode) ? mode : "line")), x: cx.toFixed(1), y: cy.toFixed(1) });
      let r: Removal;
      if (mode === "drill") {
        const ring: Pt[] = [];
        for (let k = 0; k < 16; k++) ring.push({ x: cx + (dia / 2) * Math.cos((k * Math.PI) / 8), y: cy + (dia / 2) * Math.sin((k * Math.PI) / 8) });
        r = { side, n: 0, kind: "area", pts: ring.map(turn), closed: true, depth, width: 0, outline: false, tabH: 0 };
      } else if (mode === "face") {
        const box: Pt[] = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }].map(mm);
        r = { side, n: 0, kind: "area", pts: box.map(turn), closed: true, depth, width: 0, outline: false, tabH: 0 };
      } else if (path.closed && (mode === "pocket" || mode === "vcarve" || mode === "vplug")) {
        r = { side, n: 0, kind: "area", pts: own.map(turn), closed: true, depth, width: 0, outline: false, tabH: 0 };
      } else {
        // contour: the cutter centre runs half a cutter beside the line (outside/inside), else on it
        let line = own;
        if (path.closed && (mode === "outside" || mode === "inside")) {
          const loops = offsetPolygon(own, mode === "outside" ? dia / 2 : -dia / 2);
          if (loops.length === 1) line = loops[0];
        }
        r = { side, n: 0, kind: "groove", pts: line.map(turn), closed: path.closed, depth, width: dia,
          outline: path.closed && mode === "outside", tabH: mode === "outside" || mode === "inside" ? tabSettings(e)?.h ?? 0 : 0 };
      }
      r.n = out.length + 1;
      out.push({ removal: r, label });
    }
  };
  add(front, "front");
  add(back, "back");
  return out;
}

/** Cut lines of both sides around which a pin must keep clear (front frame, mm) */
function obstaclesOf(front: any[], back: any[], s: TwoSidedSetup): PinObstacle[] {
  const out: PinObstacle[] = [];
  const add = (list: any[], side: Side) => {
    for (const e of cutShapes(list)) {
      const tool = toolForShape(e), dia = tool ? cutDiameter(tool) : 3, mode = e.millingMode || "outside";
      for (const p of shapeToPaths(e)) {
        if (!p.pts.length) continue;
        const pts = p.pts.map(mm).map(q => (side === "back" ? mirrorPoint(q, s) : q));
        out.push({ pts, closed: p.closed, grow: mode === "outside" ? dia : dia / 2 });
      }
    }
  };
  add(front, "front");
  add(back, "back");
  return out;
}

/** Part boxes (front frame, mm) for the automatic pin layout */
export function partBoxes(s: TwoSidedSetup): { minX: number; minY: number; maxX: number; maxY: number }[] {
  return obstaclesOf(sideShapes("front"), sideShapes("back"), s).filter(o => o.closed && o.pts.length >= 3).map(o => {
    const xs = o.pts.map(p => p.x), ys = o.pts.map(p => p.y);
    return { minX: Math.min(...xs) - o.grow, minY: Math.min(...ys) - o.grow, maxX: Math.max(...xs) + o.grow, maxY: Math.max(...ys) + o.grow };
  });
}

/** Warnings about the pins (texts for the panel, the console and the setup sheet) */
export function pinWarnings(s: TwoSidedSetup): string[] {
  const out: string[] = [];
  if (!s.pinsOn) return out;   // lined up some other way (fence, corner): the user's choice
  const tool = pinTool(s), dia = tool ? cutDiameter(tool) : 3;
  if (pinShapes(s).tooBig) out.push(t("two.w.pinTool", { name: tool ? tool.name : "Standard", d: dia, p: s.pinDia }));
  if (tool && tool.fluteLen > 0 && s.thickness + s.pinDepth > tool.fluteLen + 1e-6) out.push(t("two.w.pinReach", { name: tool.name, l: +(s.thickness + s.pinDepth).toFixed(2), r: tool.fluteLen }));
  for (const i of pinIssues(s, obstaclesOf(sideShapes("front"), sideShapes("back"), s), bedSizeMm())) out.push(t("two.w.pin." + i.code, { n: i.pin }));
  return out;
}

/** Warnings about the depths of both sides together */
export function depthWarnings(s: TwoSidedSetup): string[] {
  const cuts = cutsOf(sideShapes("front"), sideShapes("back"), s);
  const name = (n: number) => cuts[n - 1]?.label ?? "?";
  return depthIssues(cuts.map(c => c.removal), s.thickness).map(i =>
    t("two.w.depth." + i.code, { a: name(i.front), b: i.back ? name(i.back) : "", left: i.left.toFixed(2), t: s.thickness }));
}

/**
 * "Cut through" for the selected shapes of the shown side: depth = what is left after the other side's cut at the
 * same place, plus a little extra. Returns how many shapes were changed.
 */
export function setThroughDepth(selected: any[]): number {
  const s = activeSetup();
  if (!s) return 0;
  const side = viewSide();
  const all = cutsOf(sideShapes("front"), sideShapes("back"), s).map(c => c.removal);
  let n = 0;
  for (const shape of selected) {
    if (isKeepOut(shape) || shape.type === "image") continue;
    const own = cutsOf(side === "front" ? [{ ...shape, ops: undefined }] : [], side === "back" ? [{ ...shape, ops: undefined }] : [], s)[0]?.removal;
    const other = own ? otherSideDepth(own, all) : 0;
    shape.millingDepth = -+throughDepth(s.thickness, other).toFixed(3);
    n++;
  }
  return n;
}

export interface TwoSidedJob {
  side: Side;
  shapes: any[];      // the shapes of this side (as given for the shown side, the stored list for the other)
  pins: any[];        // pin holes (front program only)
  header: string;     // comment lines for the top of the program
  warnings: string[];
}

/** What the program of one side is made of. null = two-sided milling is not in use (G-code as always) */
export function twoSidedJob(viewShapes: any[], side?: Side): TwoSidedJob | null {
  const s = activeSetup();
  if (!s) return null;
  const sd = side ?? viewSide();
  const shapes = sd === viewSide() ? viewShapes : sideShapes(sd);
  const c = (key: string, p?: Record<string, string | number>) => `(${ascii(tMm(key, p))})\n`;
  const turn = tMm(s.flip === "lr" ? "two.gc.turnLr" : "two.gc.turnFb");
  let header = "", pins: any[] = [];
  if (sd === "front") {
    header += c("two.gc.front");
    const ps = pinShapes(s);
    pins = ps.shapes;
    if (pins.length) header += c("two.gc.pins", { n: pins.length, d: s.pinDia, depth: s.pinDepth });
    header += c("two.gc.after", { turn });
  } else {
    header += c("two.gc.back");
    header += c("two.gc.before", { turn });
    header += c("two.gc.zero");
  }
  header += c(s.zRef === "spoil" ? "two.gc.zSpoil" : "two.gc.zTop", { t: s.thickness });
  return { side: sd, shapes, pins, header, warnings: [...pinWarnings(s), ...depthWarnings(s)] };
}
