/**
 * GROSSES TEIL TEILEN – Bindeglied zwischen der Geometrie (seamSplit.ts), den Werkzeugen und den Betten.
 *
 * Das Original bleibt auf seinem Bett (dort stehen die Fugen), jedes Stück bekommt ein eigenes Bett A1, B1 …
 * Die Stücke sind ganz normale Formen: G-Code, Simulation und Prüfung arbeiten mit ihnen wie mit jeder Zeichnung.
 * „Neu erzeugen“ ersetzt die Formen der Stück-Betten. Wird das Original danach geändert (oder ein Fräser),
 * passen die Stücke nicht mehr dazu – das merkt pieceState() am Fingerabdruck und warnt vor dem Fräsen.
 *
 * Fräse, Laser und Plasma teilen verschieden (Fräser-Radius bzw. Schnittspalt, siehe seamSplit.ts und splitBeam.ts).
 * Es gilt immer die Maschinen-Art, die gerade gewählt ist – Stücke, die für eine andere Art erzeugt wurden, gelten
 * als veraltet.
 */
import { placeAtCorner, splitDrawing, splitFingerprint, type SplitKind, type SplitOptions, type SplitResult, type SplitSetup } from "./seamSplit";
import { beamFingerprint, laserSplitOptions, plasmaSplitOptions } from "./splitBeam";
import { cropImage } from "./raster/imageShape";
import { activeTool, cutDiameter, getTool, getTools, CONE_TYPES } from "./toolLibrary";
import { bedSizeMm } from "./editor/editorState";
import { activeBed, applyPieces, bedPiece, bedShapes, bedSplit, pieceBeds, setBedSplit, splitSource } from "./editor/beds";
import { MM_TO_PIXEL } from "./shapeTransform";
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

/** Womit gerade geschnitten wird */
export function splitKind(): SplitKind { return getMachineMode(); }

/** Einstellungen fürs Teilen – je nach Maschinen-Art (shapes und setup braucht nur der Laser: Schneid-Ebenen) */
export function splitOptions(shapes: any[], setup: Pick<SplitSetup, "cutLayers"> | null): SplitOptions {
  const kind = splitKind();
  if (kind === "laser") return laserSplitOptions(shapes, setup, bedSizeMm());
  if (kind === "plasma") return plasmaSplitOptions(bedSizeMm());
  const depth = document.getElementById("dim-depth") as HTMLInputElement | null;
  const d = depth ? parseFloat(depth.value) : NaN;
  return { bed: bedSizeMm(), radiusOf, fallbackDepth: Number.isFinite(d) ? d : -2 };
}

/**
 * Werkzeuge gehören zum Fingerabdruck: ein anderer Fräser-Ø ändert die Verbindungen.
 * Laser/Plasma: Schnittspalt, Ebenen bzw. Schnitte und die gewählten Schneid-Ebenen.
 */
function toolInfo(shapes: any[], setup: Pick<SplitSetup, "cutLayers"> | null): string {
  const kind = splitKind();
  if (kind !== "mill") return beamFingerprint(kind, shapes, setup);
  return getTools().map(tl => `${tl.id}:${cutDiameter(tl)}`).join(",") + "|" + (activeTool?.id ?? "");
}

/** Warum das Teilen hier nicht geht (Text-Schlüssel) oder null */
export function splitBlocked(): string | null {
  if (rotary.on) return "seam.noRotary";
  return null;
}

export function computeSplit(shapes: any[], setup: SplitSetup): SplitResult {
  return splitDrawing(shapes, setup, splitOptions(shapes, setup));
}

/**
 * Bilder, die über einer Fuge liegen (Laser), auf den Rahmen ihres Stücks zuschneiden – erst hier, weil dafür das
 * Bild geladen werden muss. Lässt sich ein Bild nicht zuschneiden, bleibt es ganz im Stück.
 */
async function cropImages(r: SplitResult): Promise<void> {
  for (const p of r.pieces) {
    const out: any[] = [];
    for (const s of p.shapes) {
      const box = s.cropMm;
      if (!box) { out.push(s); continue; }
      delete s.cropMm;
      let cut: any = null;
      try { cut = await cropImage(s, { minX: box.minX * MM_TO_PIXEL, minY: box.minY * MM_TO_PIXEL, maxX: box.maxX * MM_TO_PIXEL, maxY: box.maxY * MM_TO_PIXEL }); } catch { /* bleibt ganz */ }
      if (cut) delete cut.cropMm;
      out.push(cut ?? s);
    }
    p.shapes = out;
  }
}

/** Stücke des aktiven Bettes (Original) erzeugen bzw. erneuern. Jedes Stück liegt danach an der Ecke seines Bettes */
export async function makePieces(setup: SplitSetup, shapes: any[], r: SplitResult): Promise<number> {
  const bed = bedSizeMm();
  // an die Bett-Ecke: der Platzbedarf (mit Fräserbahn bzw. Anfahrbahn) beginnt bei 0 – ist noch Luft, 1 mm Abstand
  for (const p of r.pieces) placeAtCorner(p, bed);
  await cropImages(r);
  const made: SplitSetup = { ...setup, seams: setup.seams.map(s => ({ ...s })), made: splitFingerprint(shapes, setup, toolInfo(shapes, setup)) };
  setBedSplit(made);
  return applyPieces(made.id, r.pieces.map(p => ({ name: p.name, shapes: p.shapes })));
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
  const stale = !!setup && setup.made !== splitFingerprint(bedShapes(source), setup, toolInfo(bedShapes(source), setup));
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
  if (own && own.seams.length) return { setup: own, shapes: bedShapes(i), piece: null, stale: !!own.made && own.made !== splitFingerprint(bedShapes(i), own, toolInfo(bedShapes(i), own)) };
  const st = pieceState(i);
  if (!st || !st.setup) return null;
  return { setup: st.setup, shapes: bedShapes(st.source), piece: st.name, stale: st.stale };
}
