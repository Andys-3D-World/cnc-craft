/**
 * RASTER DES MATERIAL-TESTS – die reine Rechnung (ohne Fenster), damit Testraster und Testkarte denselben Code nutzen.
 * Von links nach rechts steigt die Leistung, von oben nach unten die Geschwindigkeit bzw. der Linienabstand.
 */
export type RowVar = "speed" | "interval";

export interface MaterialTestOptions {
  mode: "fill" | "line";
  rowVar: RowVar;       // was sich von oben nach unten ändert
  cols: number;         // Spalten = Leistungsstufen
  pMin: number; pMax: number;
  rows: number;         // Zeilen = Geschwindigkeits- bzw. Abstandsstufen
  rMin: number; rMax: number;
  speed: number;        // feste Geschwindigkeit, wenn die Zeilen den Linienabstand ändern
  interval: number;     // fester Linienabstand, wenn die Zeilen die Geschwindigkeit ändern
  passes: number;
  cell: number;         // Feldgröße in mm
  gap: number;          // Abstand zwischen den Feldern in mm
  labels: boolean;
  textH: number;        // Schrifthöhe der Beschriftung in mm
  labelPower: number;
  labelSpeed: number;
}

export interface GridCell { x: number; y: number; power: number; speed: number; interval: number }
export interface GridLabel { text: string; x: number; y: number; align: "right" | "center" | "left"; rot?: boolean }

/** Werte einer Stufe i von n zwischen a und b (gleichmäßig) */
export function step(a: number, b: number, i: number, n: number, digits: number): number {
  const v = n <= 1 ? a : a + ((b - a) * i) / (n - 1);
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** Raster in mm (Y nach oben, linke untere Ecke des Feld-Blocks = 0,0) */
export function layoutTest(o: MaterialTestOptions): { cells: GridCell[]; labels: GridLabel[]; w: number; h: number } {
  const pitch = o.cell + o.gap;
  const h = o.rows * pitch - o.gap, w = o.cols * pitch - o.gap;
  const cells: GridCell[] = [];
  const labels: GridLabel[] = [];
  const rd = o.rowVar === "speed" ? 0 : 2;
  for (let r = 0; r < o.rows; r++) {
    const rv = step(o.rMin, o.rMax, r, o.rows, rd);
    const y = h - r * pitch - o.cell;
    for (let c = 0; c < o.cols; c++) {
      const p = step(o.pMin, o.pMax, c, o.cols, 1);
      cells.push({ x: c * pitch, y, power: p, speed: o.rowVar === "speed" ? rv : o.speed, interval: o.rowVar === "speed" ? o.interval : rv });
    }
    labels.push({ text: String(rv), x: -o.textH * 0.6, y: y + (o.cell - o.textH) / 2, align: "right" });
  }
  for (let c = 0; c < o.cols; c++)
    labels.push({ text: String(step(o.pMin, o.pMax, c, o.cols, 1)), x: c * pitch + o.cell / 2, y: h + o.textH * 0.6, align: "center", rot: o.cell < o.textH * 2.6 });
  // Achsen-Titel: oben links "%", darunter die Einheit der Zeilen
  labels.push({ text: o.rowVar === "speed" ? "mm/min" : "mm", x: -o.textH * 0.6, y: h + o.textH * 0.6, align: "right" });
  labels.push({ text: o.mode === "fill" && o.rowVar === "speed" ? `% ${o.interval}mm` : o.rowVar === "speed" ? "%" : `% ${o.speed}mm/min`,
    x: 0, y: h + o.textH * 2.2 + (o.cell < o.textH * 2.6 ? o.textH * 1.5 : 0), align: "left" });
  return { cells, labels, w, h };
}

/** Linien einer Beschriftung an ihren Platz legen. Senkrecht (rot) = 90° gedreht, von unten nach oben lesbar */
export function labelLoops(lb: GridLabel, tr: { loops: { x: number; y: number }[][]; width: number; height: number }): { x: number; y: number }[][] {
  const w = lb.rot ? tr.height : tr.width;
  const x0 = lb.align === "right" ? lb.x - w : lb.align === "center" ? lb.x - w / 2 : lb.x;
  return tr.loops.map(loop => loop.map(q => lb.rot ? { x: x0 + tr.height - q.y, y: lb.y + q.x } : { x: x0 + q.x, y: lb.y + q.y }));
}
