/**
 * MATERIAL-NETZ IN KACHELN (Simulation): Jeder Rasterpunkt ist genau ein Eckpunkt, die Dreiecke stehen in einer
 * Nummernliste. Die Fläche ist in Kacheln (64 × 64 Zellen) geteilt; eine ganz ebene Kachel braucht nur zwei Dreiecke,
 * eine durchgefräste gar keine. So bleibt die Grafikkarte auch bei Millionen Zellen entspannt – geändert wird nur,
 * was der Fräser gerade berührt hat. In den übrigen Kacheln wird jedes Viereck an der Diagonale geteilt, deren Ecken
 * ähnlich hoch sind (glatte Wände statt Sägezahn). Nur Rechnen, keine Oberfläche (läuft in den Tests).
 */

export const CHUNK = 64;

export class ChunkGrid {
  readonly cols: number; readonly rows: number;
  readonly ncx: number; readonly ncy: number;
  /** Platz in der Nummernliste je Kachel (Anfang, in Nummern) */
  readonly start: Int32Array;
  readonly count: Int32Array;
  readonly total: number;
  readonly nx: number; readonly ny: number; readonly wrap: boolean; readonly simplify: boolean; readonly floor: number;

  /**
   * @param wrap  rundherum (Drehachse): letzte Zeile schließt an die erste; nie zusammenfassen (Oberfläche ist gekrümmt)
   * @param simplify  ebene Kacheln zusammenfassen; floor = tiefer gilt als durchgefräst (Infinity-Fall: −Infinity)
   */
  constructor(nx: number, ny: number, wrap: boolean, simplify: boolean, floor: number) {
    this.nx = nx; this.ny = ny; this.wrap = wrap; this.simplify = simplify; this.floor = floor;
    this.cols = nx - 1;
    this.rows = wrap ? ny : ny - 1;
    this.ncx = Math.ceil(this.cols / CHUNK);
    this.ncy = Math.ceil(this.rows / CHUNK);
    this.start = new Int32Array(this.ncx * this.ncy);
    this.count = new Int32Array(this.ncx * this.ncy);
    let o = 0;
    for (let cj = 0; cj < this.ncy; cj++) for (let ci = 0; ci < this.ncx; ci++) {
      this.start[cj * this.ncx + ci] = o;
      o += (Math.min(this.cols, (ci + 1) * CHUNK) - ci * CHUNK) * (Math.min(this.rows, (cj + 1) * CHUNK) - cj * CHUNK) * 6;
    }
    this.total = o;
  }

  /** Nummern von Kachel k in out schreiben (Eckpunkt = Zeile × nx + Spalte; rundherum gibt es Zeile ny = Zeile 0). Ergebnis: Anzahl */
  build(k: number, h: ArrayLike<number>, out: Uint32Array): number {
    const { nx, ny, wrap, cols, rows, floor } = this;
    const ci = k % this.ncx, cj = (k - ci) / this.ncx;
    const i0 = ci * CHUNK, j0 = cj * CHUNK, i1 = Math.min(cols, i0 + CHUNK), j1 = Math.min(rows, j0 + CHUNK);
    let n = 0;
    if (this.simplify) {
      // eben = alle Punkte samt einem Ring außen gleich hoch (der Ring zählt für die Normale am Rand)
      const v = Math.max(floor, h[j0 * nx + i0]);
      let flat = true;
      const ja = Math.max(0, j0 - 1), jb = Math.min(ny - 1, j1 + 1), ia = Math.max(0, i0 - 1), ib = Math.min(nx - 1, i1 + 1);
      for (let j = ja; j <= jb && flat; j++) {
        const o = j * nx;
        for (let i = ia; i <= ib; i++) if (Math.max(floor, h[o + i]) !== v) { flat = false; break; }
      }
      if (flat) {
        if (v <= floor) { this.count[k] = 0; return 0; }      // ganz durchgefräst
        const a = j0 * nx + i0, b = j0 * nx + i1, c = j1 * nx + i0, d = j1 * nx + i1;
        out[0] = a; out[1] = b; out[2] = d; out[3] = a; out[4] = d; out[5] = c;
        this.count[k] = 6;
        return 6;
      }
    }
    for (let j = j0; j < j1; j++) {
      const up = wrap && j + 1 === ny ? 0 : j + 1;
      for (let i = i0; i < i1; i++) {
        const a = j * nx + i, b = a + 1, c = (j + 1) * nx + i, d = c + 1;
        const ha = h[a], hb = h[a + 1], hc = h[up * nx + i], hd = h[up * nx + i + 1];
        if (Math.abs(ha - hd) <= Math.abs(hb - hc)) {
          out[n++] = a; out[n++] = b; out[n++] = d; out[n++] = a; out[n++] = d; out[n++] = c;
        } else {
          out[n++] = a; out[n++] = b; out[n++] = c; out[n++] = b; out[n++] = d; out[n++] = c;
        }
      }
    }
    this.count[k] = n;
    return n;
  }

  /** Zeichen-Abschnitte: aneinanderstoßende Kacheln werden ein Aufruf. [Anfang, Anzahl] */
  ranges(): number[] {
    const out: number[] = [];
    let s = -1, e = -1;
    for (let k = 0; k < this.count.length; k++) {
      const c = this.count[k];
      if (!c) continue;
      if (this.start[k] === e) e += c;
      else { if (s >= 0) out.push(s, e - s); s = this.start[k]; e = s + c; }
    }
    if (s >= 0) out.push(s, e - s);
    return out;
  }
}
