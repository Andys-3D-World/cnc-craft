/**
 * GROSSES TEIL TEILEN – Bindeglied zwischen der Geometrie (seamSplit.ts), den Werkzeugen und den Betten.
 *
 * Das Original bleibt auf seinem Bett (dort stehen die Fugen), jedes Stück bekommt ein eigenes Bett A1, B1 …
 * Die Stücke sind ganz normale Formen: G-Code, Simulation und Prüfung arbeiten mit ihnen wie mit jeder Zeichnung.
 * „Neu erzeugen“ ersetzt die Formen der Stück-Betten. Wird das Original danach geändert (oder ein Fräser),
 * passen die Stücke nicht mehr dazu – das merkt pieceState() am Fingerabdruck und warnt vor dem Fräsen.
 */
import { splitDrawing, splitFingerprint, type SplitOptions, type SplitResult, type SplitSetup } from "./seamSplit";
import { activeTool, cutDiameter, getTool, getTools, CONE_TYPES } from "./toolLibrary";
import { bedSizeMm } from "./editor/editorState";
import { activeBed, applyPieces, bedPiece, bedShapes, bedSplit, pieceBeds, setBedSplit, splitSource } from "./editor/beds";
import { translateShape, MM_TO_PIXEL } from "./shapeTransform";
import { getMachineMode } from "./machineMode";
import { rotary } from "./rotary";

/** Wirksamer Schneid-Radius einer Bearbeitung (wie cam.ts: ohne Werkzeug 3 mm Fräser) */
function radiusOf(v: { mode: string; toolId?: string; depth: number }): number {
  const tl = getTool(v.toolId) || activeTool || getTools()[0] || null;
  if (!tl) return 1.5;
  const r = cutDiameter(tl) / 2;
  // Gravur mit V-Stichel: so breit wie der Kegel in dieser Tiefe schneidet
  if (v.mode === "on-line" && CONE_TYPES.includes(tl.type) && tl.angle > 0 && tl.angle < 180) {
    return Math.min(r, (tl.tipDia || 0) / 2 + Math.abs(v.depth) * Math.tan((tl.angle / 2) * Math.PI / 180));
  }
  return r;
}

export function splitOptions(): SplitOptions {
  const depth = document.getElementById("dim-depth") as HTMLInputElement | null;
  const d = depth ? parseFloat(depth.value) : NaN;
  return { bed: bedSizeMm(), radiusOf, fallbackDepth: Number.isFinite(d) ? d : -2 };
}

/** Werkzeuge gehören zum Fingerabdruck: ein anderer Fräser-Ø ändert die Verbindungen */
function toolInfo(): string {
  return getTools().map(tl => `${tl.id}:${cutDiameter(tl)}`).join(",") + "|" + (activeTool?.id ?? "");
}

/** Warum das Teilen hier nicht geht (Text-Schlüssel) oder null */
export function splitBlocked(): string | null {
  if (getMachineMode() !== "mill") return "seam.onlyMill";
  if (rotary.on) return "seam.noRotary";
  return null;
}

export function computeSplit(shapes: any[], setup: SplitSetup): SplitResult {
  return splitDrawing(shapes, setup, splitOptions());
}

/** Stücke des aktiven Bettes (Original) erzeugen bzw. erneuern. Jedes Stück liegt danach an der Ecke seines Bettes */
export function makePieces(setup: SplitSetup, shapes: any[], r: SplitResult): number {
  const made: SplitSetup = { ...setup, seams: setup.seams.map(s => ({ ...s })), made: splitFingerprint(shapes, setup, toolInfo()) };
  setBedSplit(made);
  const bed = bedSizeMm();
  return applyPieces(made.id, r.pieces.map(p => {
    // an die Bett-Ecke: der Platzbedarf (mit Fräserbahn) beginnt bei 0 – ist noch Luft, 1 mm Abstand
    if (p.extent) {
      const w = p.extent.maxX - p.extent.minX, h = p.extent.maxY - p.extent.minY;
      const dx = -p.extent.minX + (w + 2 <= bed.w ? 1 : 0), dy = -p.extent.minY + (h + 2 <= bed.h ? 1 : 0);
      for (const s of p.shapes) translateShape(s, dx * MM_TO_PIXEL, dy * MM_TO_PIXEL);
    }
    return { name: p.name, shapes: p.shapes };
  }));
}

export interface PieceState {
  name: string;      // A1 …
  source: number;    // Bett mit dem Original (−1 = gelöscht)
  stale: boolean;    // Original oder Werkzeug seit dem Erzeugen geändert
  setup: SplitSetup | null;
}

/** Ist das Bett ein Stück? Dann: zu welchem Original, und passt es noch dazu */
export function pieceState(i = activeBed()): PieceState | null {
  const p = bedPiece(i);
  if (!p) return null;
  const source = splitSource(p.of), setup = source >= 0 ? bedSplit(source) : null;
  const stale = !!setup && setup.made !== splitFingerprint(bedShapes(source), setup, toolInfo());
  return { name: p.name, source, stale, setup };
}

/** Das aktive Bett ist ein Original, für das Stücke erzeugt wurden */
export function isSplitSource(i = activeBed()): boolean {
  const s = bedSplit(i);
  return !!s && pieceBeds(s.id).length > 0;
}

/** Aufteilung des Originals, zu dem das aktive Bett gehört (Original oder Stück) – fürs Einrichteblatt */
export function splitOfBed(i = activeBed()): { setup: SplitSetup; shapes: any[]; piece: string | null; stale: boolean } | null {
  const own = bedSplit(i);
  if (own && own.seams.length) return { setup: own, shapes: bedShapes(i), piece: null, stale: !!own.made && own.made !== splitFingerprint(bedShapes(i), own, toolInfo()) };
  const st = pieceState(i);
  if (!st || !st.setup) return null;
  return { setup: st.setup, shapes: bedShapes(st.source), piece: st.name, stale: st.stale };
}
