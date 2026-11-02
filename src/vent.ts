/**
 * LÜFTUNGSGITTER / LOCHMUSTER: eine Fläche voller Löcher – für Gehäuse, Lautsprecher, Lüfter (Fenster: editor/ventGen.ts)
 *
 * Fläche: Rechteck (mit Eckenradius) oder Kreis. Innen ein Rand ohne Löcher, dann das Muster:
 *   hex     Waben (Sechsecke, Schlüsselweite = Lochgröße)
 *   round   runde Löcher, versetzt (dichteste Packung)
 *   square  quadratische Löcher im Raster
 *   slot    Langlöcher in Reihen (Länge einstellbar)
 * Steg = Material zwischen zwei Löchern. Nur ganze Löcher, die vollständig im Lochfeld liegen. Das Muster wird
 * mittig ausgerichtet. Auf Wunsch die Platte selbst (Umriss) und Befestigungslöcher in den Ecken.
 *
 * Nur Geometrie (Tests: `npm test`). Alles in mm, Y nach oben, Mitte bei (0, 0).
 */
export type XY = [number, number];
export type VentShape = "rect" | "circle";
export const VENT_SHAPES: VentShape[] = ["rect", "circle"];
export type VentPattern = "hex" | "round" | "square" | "slot";
export const VENT_PATTERNS: VentPattern[] = ["hex", "round", "square", "slot"];

export interface VentOptions {
  shape: VentShape;
  width: number;       // Breite bzw. Durchmesser (mm)
  height: number;      // Höhe (Rechteck)
  radius: number;      // Eckenradius (Rechteck)
  margin: number;      // Rand ohne Löcher (mm)
  pattern: VentPattern;
  size: number;        // Lochgröße: Ø, Schlüsselweite, Kantenlänge bzw. Breite des Langlochs (mm)
  web: number;         // Steg zwischen den Löchern (mm)
  slotLength: number;  // Langloch: Länge (mm)
  plate: boolean;      // Umriss der Platte ausgeben
  mountD: number;      // Befestigungslöcher Ø (0 = keine)
  mountInset: number;  // Abstand Mitte Befestigungsloch zum Rand (mm)
}

export interface VentResult {
  outline: XY[] | null;   // Platte (geschlossen) oder null
  holes: XY[][];          // Löcher des Musters (geschlossen)
  mounts: XY[][];         // Befestigungslöcher (geschlossen)
  openArea: number;       // offene Fläche in % des Lochfelds
  warnings: string[];
}

function circle(cx: number, cy: number, r: number, n = 0): XY[] {
  const k = n || Math.max(16, Math.min(96, Math.ceil(2 * Math.PI * r / 0.4)));
  const out: XY[] = [];
  for (let i = 0; i < k; i++) out.push([cx + r * Math.cos(2 * Math.PI * i / k), cy + r * Math.sin(2 * Math.PI * i / k)]);
  out.push([out[0][0], out[0][1]]);
  return out;
}

function roundRect(w: number, h: number, r: number): XY[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: XY[] = [];
  const corners: [number, number, number][] = [[w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180]];
  for (const [cx, cy, a0] of corners) {
    if (r === 0) { pts.push([cx, cy]); continue; }
    for (let k = 0; k <= 8; k++) { const a = (a0 + k * 90 / 8) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

/** liegt der Punkt im Lochfeld (Fläche minus Rand)? Rechteck mit Eckenradius bzw. Kreis */
function inField(o: VentOptions, x: number, y: number): boolean {
  if (o.shape === "circle") return Math.hypot(x, y) <= o.width / 2 - o.margin + 1e-9;
  const hw = o.width / 2 - o.margin, hh = o.height / 2 - o.margin, r = Math.max(0, o.radius - o.margin);
  if (Math.abs(x) > hw + 1e-9 || Math.abs(y) > hh + 1e-9) return false;
  const dx = Math.abs(x) - (hw - r), dy = Math.abs(y) - (hh - r);
  return dx <= 0 || dy <= 0 || Math.hypot(dx, dy) <= r + 1e-9;
}

const ringArea = (r: XY[]) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(a / 2); };

/** Mittelpunkte + Form eines Lochs (um 0,0) für das Muster */
function cellsFor(o: VentOptions, span: number): { centers: XY[]; shape: XY[] } {
  const s = Math.max(0.3, o.size), w = Math.max(0, o.web);
  const centers: XY[] = [];
  let shape: XY[];
  if (o.pattern === "hex") {
    // Sechseck mit Spitzen oben/unten, Schlüsselweite s (waagerecht): Raster dx = s + w, Reihen dy = dx·√3/2
    const R = s / Math.sqrt(3);
    shape = [];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 2 + k * Math.PI / 3; shape.push([R * Math.cos(a), R * Math.sin(a)]); }
    shape.push([shape[0][0], shape[0][1]]);
    const dx = s + w, dy = dx * Math.sqrt(3) / 2;
    for (let j = -Math.ceil(span / dy); j <= Math.ceil(span / dy); j++)
      for (let i = -Math.ceil(span / dx) - 1; i <= Math.ceil(span / dx) + 1; i++) centers.push([i * dx + (Math.abs(j) % 2 ? dx / 2 : 0), j * dy]);
  } else if (o.pattern === "round") {
    shape = circle(0, 0, s / 2);
    const dx = s + w, dy = dx * Math.sqrt(3) / 2;
    for (let j = -Math.ceil(span / dy); j <= Math.ceil(span / dy); j++)
      for (let i = -Math.ceil(span / dx) - 1; i <= Math.ceil(span / dx) + 1; i++) centers.push([i * dx + (Math.abs(j) % 2 ? dx / 2 : 0), j * dy]);
  } else if (o.pattern === "square") {
    shape = [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2], [-s / 2, -s / 2]];
    const d = s + w;
    for (let j = -Math.ceil(span / d); j <= Math.ceil(span / d); j++)
      for (let i = -Math.ceil(span / d); i <= Math.ceil(span / d); i++) centers.push([i * d, j * d]);
  } else {
    // Langloch waagerecht, Breite s, Länge L; Reihen um eine halbe Länge versetzt
    const L = Math.max(s, o.slotLength), r = s / 2;
    shape = [];
    for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 + Math.PI * k / 8; shape.push([L / 2 - r + r * Math.cos(a), r * Math.sin(a)]); }
    for (let k = 0; k <= 8; k++) { const a = Math.PI / 2 + Math.PI * k / 8; shape.push([-L / 2 + r + r * Math.cos(a), r * Math.sin(a)]); }
    shape.push([shape[0][0], shape[0][1]]);
    const dx = L + w, dy = s + w;
    for (let j = -Math.ceil(span / dy); j <= Math.ceil(span / dy); j++)
      for (let i = -Math.ceil(span / dx) - 1; i <= Math.ceil(span / dx) + 1; i++) centers.push([i * dx + (Math.abs(j) % 2 ? dx / 2 : 0), j * dy]);
  }
  return { centers, shape };
}

export function vent(o: VentOptions): VentResult {
  const warnings: string[] = [];
  const W = o.width, H = o.shape === "circle" ? o.width : o.height;
  const { centers, shape } = cellsFor(o, Math.max(W, H) / 2 + o.size + o.web);
  const holes: XY[][] = [];
  for (const [cx, cy] of centers) {
    const pts = shape.map(([x, y]) => [x + cx, y + cy] as XY);
    if (pts.every(([x, y]) => inField(o, x, y))) holes.push(pts);
  }
  // Befestigungslöcher: Rechteck in den Ecken, Kreis 4 Stück auf dem Rand-Kreis (oben/unten/links/rechts um 45° versetzt)
  const mounts: XY[][] = [];
  if (o.mountD > 0) {
    const pos: XY[] = o.shape === "circle"
      ? [0, 1, 2, 3].map(k => { const a = Math.PI / 4 + k * Math.PI / 2, r = W / 2 - o.mountInset; return [r * Math.cos(a), r * Math.sin(a)] as XY; })
      : [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [sx * (W / 2 - o.mountInset), sy * (H / 2 - o.mountInset)] as XY);
    for (const [x, y] of pos) mounts.push(circle(x, y, o.mountD / 2));
    // Löcher des Musters, die einem Befestigungsloch zu nah kommen, fallen weg
    const keep = o.mountD / 2 + Math.max(o.web, 1);
    for (let i = holes.length - 1; i >= 0; i--)
      if (holes[i].some(([hx, hy]) => pos.some(([x, y]) => Math.hypot(hx - x, hy - y) < keep))) holes.splice(i, 1);
    if (o.mountInset < o.mountD / 2 + 1) warnings.push("vent.warnMount");
  }
  const outline = o.plate ? (o.shape === "circle" ? circle(0, 0, W / 2, 180) : roundRect(W, H, o.radius)) : null;
  const fieldArea = o.shape === "circle" ? Math.PI * (W / 2 - o.margin) ** 2 : Math.max(1e-9, (W - 2 * o.margin) * (H - 2 * o.margin));
  const openArea = 100 * holes.reduce((s, h) => s + ringArea(h), 0) / fieldArea;
  if (!holes.length) warnings.push("vent.warnNone");
  if (o.web < 0.8) warnings.push("vent.warnWeb");
  return { outline, holes, mounts, openArea, warnings };
}
