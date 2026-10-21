/**
 * BILD ALS FORM (Bildgravur mit dem Laser)
 *
 * Form: { type: "image", points: [unten links, unten rechts, oben rechts, oben links] (Welt-Pixel),
 *         img: { src (Daten-URL), pw, ph, preset, raster, adjust, interval, minPower, overscan } }
 * Die vier Ecken machen Verschieben, Skalieren, Drehen und Spiegeln wie bei einer Polylinie möglich –
 * Bildpunkt (u, v) liegt bei p0 + u·(p1 − p0) + v·(p3 − p0).
 *
 * Gerastert wird mit 1 Bildpunkt = Linienabstand (z. B. 0,1 mm = 254 DPI). Das Ergebnis wird je Form
 * zwischengespeichert und neu gerechnet, wenn sich Größe oder Einstellungen ändern.
 */
import { MM_TO_PIXEL, Pt, newId, updatePolylineBounds } from "../shapeTransform";
import { Adjust, NO_ADJUST, RasterSettings, EngravePreset, presetSettings, toGray, resample, applyAdjust, rasterize, autoAdjust, removeBackground } from "./dither";

export interface ImageSettings {
  src: string;          // Bild als Daten-URL (verkleinert)
  pw: number; ph: number;
  preset: EngravePreset | "custom";
  raster: RasterSettings;
  adjust: Adjust;
  interval: number;     // Linienabstand in mm (= Größe eines Bildpunkts)
  minPower: number;     // % – nur Graustufen: so viel Leistung für fast weiße Stellen
  overscan: number;     // mm – über den Rand hinaus fahren, damit die Kanten gleichmäßig werden
  bg?: { on: boolean; tol: number };  // Hintergrund entfernen (Toleranz 0…100)
  /** Bildmaske: nur innerhalb dieser Konturen gravieren (Gerade/Ungerade). Punkte in Bild-Anteilen: u nach rechts, v nach oben */
  mask?: { u: number; v: number }[][];
}

/** höchstens so viele Raster-Punkte (sonst wird der Linienabstand für die Rechnung gröber) */
const MAX_CELLS = 12_000_000;

// ---------------------------------------------------------------------
// Anlegen
// ---------------------------------------------------------------------

/** Bild-Datei laden, verkleinern (max. 1600 px), als neue Bild-Form (Breite widthMm, unten links bei x0/y0 mm) */
export async function createImageShape(name: string, bytes: Uint8Array, widthMm: number, x0: number, y0: number): Promise<any> {
  const ext = name.split(".").pop()?.toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "bmp" ? "image/bmp" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    const im = await loadImg(url);
    const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
    const pw = Math.max(1, Math.round(im.naturalWidth * k)), ph = Math.max(1, Math.round(im.naturalHeight * k));
    const c = document.createElement("canvas");
    c.width = pw; c.height = ph;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pw, ph); // durchsichtig = weiß = kein Laser
    ctx.drawImage(im, 0, 0, pw, ph);
    const src = pw * ph <= 1_000_000 ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92);
    const gray = toGray(ctx.getImageData(0, 0, pw, ph).data, pw * ph);
    const p = presetSettings("photo");
    const img: ImageSettings = { src, pw, ph, preset: "photo", raster: p.raster, adjust: autoAdjust(gray, p.adjust), interval: 0.1, minPower: 0, overscan: 2 };
    sources.set(src, { gray, w: pw, h: ph });
    const W = widthMm * MM_TO_PIXEL, H = (widthMm * ph / pw) * MM_TO_PIXEL, X = x0 * MM_TO_PIXEL, Y = y0 * MM_TO_PIXEL;
    const shape = { id: newId(), type: "image", points: [{ x: X, y: Y }, { x: X + W, y: Y }, { x: X + W, y: Y + H }, { x: X, y: Y + H }],
      x: 0, y: 0, w: 0, h: 0, rotation: 0, millingMode: "on-line", millingDepth: -2, source: name, img };
    updatePolylineBounds(shape);
    return shape;
  } finally { URL.revokeObjectURL(url); }
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("image")); im.src = url; });
}

// ---------------------------------------------------------------------
// Quellbild (Graustufen) und Ergebnis zwischenspeichern
// ---------------------------------------------------------------------

const sources = new Map<string, { gray: Float32Array; w: number; h: number } | "loading">();

/** Graustufen des Quellbilds – beim ersten Mal wird geladen (danach neu zeichnen) */
export function sourceGray(img: ImageSettings): { gray: Float32Array; w: number; h: number } | null {
  const s = sources.get(img.src);
  if (s && s !== "loading") return s;
  if (!s) {
    sources.set(img.src, "loading");
    loadImg(img.src).then(im => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(im, 0, 0);
      sources.set(img.src, { gray: toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width * c.height), w: c.width, h: c.height });
      window.dispatchEvent(new Event("cnc-redraw"));
    }).catch(() => sources.delete(img.src));
  }
  return null;
}

/** Größe der Form in mm (Breite = Kante unten, Höhe = Kante links) */
export function imageSizeMm(s: any): { w: number; h: number } {
  const [p0, p1, , p3] = s.points as Pt[];
  return { w: Math.hypot(p1.x - p0.x, p1.y - p0.y) / MM_TO_PIXEL, h: Math.hypot(p3.x - p0.x, p3.y - p0.y) / MM_TO_PIXEL };
}

/** Raster-Größe (Punkte) für Form + Einstellungen; zu groß → gröber rechnen */
export function gridSize(s: any, img: ImageSettings = s.img): { gw: number; gh: number; step: number } {
  const { w, h } = imageSizeMm(s);
  let step = Math.max(0.02, img.interval);
  while ((w / step) * (h / step) > MAX_CELLS) step *= 1.25;
  return { gw: Math.max(1, Math.round(w / step)), gh: Math.max(1, Math.round(h / step)), step };
}

export interface Processed { burn: Float32Array; gw: number; gh: number; step: number; canvas: HTMLCanvasElement | null }
const results = new Map<string, { key: string; res: Processed }>();

/** Gerastertes Bild (burn 0…1 je Punkt, Zeile 0 = oben) – null, solange das Quellbild noch lädt */
export function processed(s: any, img: ImageSettings = s.img, withCanvas = true): Processed | null {
  const src = sourceGray(img);
  if (!src) return null;
  const { gw, gh, step } = gridSize(s, img);
  const { src: _ignore, ...rest } = img;
  const key = JSON.stringify([rest, gw, gh, img.src.length, img.src.slice(-40)]);
  const hit = results.get(s.id);
  if (hit && hit.key === key && (hit.res.canvas || !withCanvas)) return hit.res;
  const base = img.bg?.on ? withoutBackground(img.src, src, img.bg.tol) : src.gray;
  const g = applyAdjust(resample(base, src.w, src.h, gw, gh), gw, gh, img.adjust || NO_ADJUST);
  const burn = rasterize(g, gw, gh, img.raster);
  if (img.mask?.length) applyMask(burn, gw, gh, img.mask);
  const res: Processed = { burn, gw, gh, step, canvas: withCanvas ? burnCanvas(burn, gw, gh) : null };
  results.set(s.id, { key, res });
  return res;
}

/** Hintergrund entfernt – zuletzt benutztes Ergebnis je Bild merken (Regler ziehen rechnet sonst ständig neu) */
const noBg = new Map<string, { tol: number; gray: Float32Array }>();
function withoutBackground(key: string, src: { gray: Float32Array; w: number; h: number }, tol: number): Float32Array {
  const hit = noBg.get(key);
  if (hit && hit.tol === tol) return hit.gray;
  const gray = removeBackground(src.gray, src.w, src.h, tol);
  noBg.set(key, { tol, gray });
  return gray;
}

/** Alles außerhalb der Maske löschen (Maske über eine Zeichenfläche füllen – schnell auch bei vielen Punkten) */
function applyMask(burn: Float32Array, gw: number, gh: number, rings: { u: number; v: number }[][]) {
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.beginPath();
  for (const r of rings) r.forEach((q, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, q.u * gw, (1 - q.v) * gh));
  ctx.fillStyle = "#000";
  ctx.fill("evenodd");
  const a = ctx.getImageData(0, 0, gw, gh).data;
  for (let i = 0; i < burn.length; i++) if (a[i * 4 + 3] < 128) burn[i] = 0;
}

/** Welt-Punkt → Bild-Anteile (u, v) für eine Bild-Form */
export function toImageUV(s: any, q: Pt): { u: number; v: number } {
  const [p0, p1, , p3] = s.points as Pt[];
  const ax = p1.x - p0.x, ay = p1.y - p0.y, bx = p3.x - p0.x, by = p3.y - p0.y;
  const det = ax * by - ay * bx || 1e-12;
  const dx = q.x - p0.x, dy = q.y - p0.y;
  return { u: (dx * by - dy * bx) / det, v: (ax * dy - ay * dx) / det };
}

/** Ergebnis als Bild: gebrannt = dunkelbraun, frei = helles Holz */
export function burnCanvas(burn: Float32Array, gw: number, gh: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const ctx = c.getContext("2d")!;
  const id = ctx.createImageData(gw, gh);
  const L = [236, 222, 196], D = [52, 36, 26];
  for (let i = 0; i < burn.length; i++) {
    const b = burn[i];
    id.data[i * 4] = L[0] + (D[0] - L[0]) * b;
    id.data[i * 4 + 1] = L[1] + (D[1] - L[1]) * b;
    id.data[i * 4 + 2] = L[2] + (D[2] - L[2]) * b;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// ---------------------------------------------------------------------
// Zeichnen, Anklicken
// ---------------------------------------------------------------------

/** Bild auf der Zeichenfläche (unter den Konturen) */
export function drawImageShape(ctx: CanvasRenderingContext2D, s: any, sx: (x: number) => number, sy: (y: number) => number) {
  const [p0, p1, , p3] = s.points as Pt[];
  const r = processed(s);
  const tl = { x: sx(p3.x), y: sy(p3.y) };
  const tr = { x: sx(p3.x + p1.x - p0.x), y: sy(p3.y + p1.y - p0.y) };
  const bl = { x: sx(p0.x), y: sy(p0.y) };
  ctx.save();
  if (!r?.canvas) {
    // lädt noch: helle Fläche
    ctx.fillStyle = "rgba(236,222,196,0.25)";
    ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(tr.x + bl.x - tl.x, tr.y + bl.y - tl.y); ctx.lineTo(bl.x, bl.y); ctx.closePath(); ctx.fill();
    ctx.restore();
    return;
  }
  ctx.transform((tr.x - tl.x) / r.gw, (tr.y - tl.y) / r.gw, (bl.x - tl.x) / r.gh, (bl.y - tl.y) / r.gh, tl.x, tl.y);
  // stark vergrößert: Punkte scharf zeigen
  ctx.imageSmoothingEnabled = Math.hypot(tr.x - tl.x, tr.y - tl.y) / r.gw < 2;
  ctx.drawImage(r.canvas, 0, 0);
  ctx.restore();
}

export function pointInImage(s: any, x: number, y: number): boolean {
  const pts = s.points as Pt[];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------
// G-Code: Zeile für Zeile, abwechselnd hin und zurück
// ---------------------------------------------------------------------

/**
 * Rastert eine Bild-Form zu G-Code (Laser-Modus $32=1, M3/M4 schon gesetzt).
 * Zeilen laufen entlang der unteren Bildkante (bei gedrehtem Bild schräg). Leere Ränder werden übersprungen,
 * vor/nach jeder Zeile wird um „overscan“ mm mit Laser aus weitergefahren.
 * Gibt null zurück, wenn das Bild noch nicht geladen ist.
 */
export function imageGcode(s: any, maxS: number, n: (v: number) => string): { g: string; rows: number; lengthMm: number } | null {
  const img: ImageSettings = s.img;
  const r = processed(s, img, false);
  if (!r) return null;
  const [p0, p1, , p3] = s.points as Pt[];
  const ex = { x: (p1.x - p0.x) / MM_TO_PIXEL, y: (p1.y - p0.y) / MM_TO_PIXEL };
  const ey = { x: (p3.x - p0.x) / MM_TO_PIXEL, y: (p3.y - p0.y) / MM_TO_PIXEL };
  const o = { x: p0.x / MM_TO_PIXEL, y: p0.y / MM_TO_PIXEL };
  const P = (u: number, v: number) => ({ x: o.x + u * ex.x + v * ey.x, y: o.y + u * ex.y + v * ey.y });
  const widthMm = Math.hypot(ex.x, ex.y) || 1;
  const over = Math.max(0, img.overscan || 0) / widthMm; // in Bildbreiten
  const gray = img.raster.method === "gray";
  const minS = Math.round((Math.max(0, Math.min(100, img.minPower || 0)) / 100) * maxS);
  const power = (b: number) => gray ? (b < 0.004 ? 0 : Math.round(minS + b * (maxS - minS))) : (b >= 0.5 ? maxS : 0);
  const { burn, gw, gh } = r;
  let g = "", rows = 0, lengthMm = 0;
  let lx = "", ly = "";
  const move = (cmd: string, q: Pt, S: number | null) => {
    const X = n(q.x), Y = n(q.y);
    let line = cmd;
    if (X !== lx) line += ` X${X}`;
    if (Y !== ly) line += ` Y${Y}`;
    if (S !== null) line += ` S${S}`;
    lx = X; ly = Y;
    g += line + "\n";
  };
  for (let row = 0; row < gh; row++) {
    const v = 1 - (row + 0.5) / gh;
    const base = row * gw;
    let a = -1, z = -1;
    for (let x = 0; x < gw; x++) if (power(burn[base + x]) > 0) { if (a < 0) a = x; z = x; }
    if (a < 0) continue;
    const rtl = rows % 2 === 1;
    rows++;
    // Läufe gleicher Leistung von a bis z (Kanten der Bildpunkte bei x / gw)
    const runs: { u0: number; u1: number; S: number }[] = [];
    for (let x = a; x <= z; x++) {
      const S = power(burn[base + x]);
      const last = runs[runs.length - 1];
      if (last && last.S === S) last.u1 = (x + 1) / gw; else runs.push({ u0: x / gw, u1: (x + 1) / gw, S });
    }
    const u0 = a / gw, u1 = (z + 1) / gw;
    lengthMm += (u1 - u0 + 2 * over) * widthMm;
    if (!rtl) {
      move("G0", P(u0 - over, v), 0);
      move("G1", P(u0, v), 0);
      for (const rn of runs) move("G1", P(rn.u1, v), rn.S);
      move("G1", P(u1 + over, v), 0);
    } else {
      move("G0", P(u1 + over, v), 0);
      move("G1", P(u1, v), 0);
      for (let k = runs.length - 1; k >= 0; k--) move("G1", P(runs[k].u0, v), runs[k].S);
      move("G1", P(u0 - over, v), 0);
    }
  }
  return { g, rows, lengthMm };
}
