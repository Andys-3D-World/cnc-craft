/**
 * FRÄSERGEBNIS ALS NETZ: Eckpunkte aus dem Höhenraster, Dreiecke über eine Nummernliste (spart viel Speicher).
 * Ebene Flächen werden zu großen Rechtecken zusammengefasst – so bleibt die Grafikkarte auch bei Millionen Zellen entspannt.
 * Scharfe Kanten: jedes Viereck wird an der Diagonale geteilt, deren Ecken ähnlich hoch sind – so läuft eine schräg
 * liegende Wand glatt statt als Sägezahn. Durchgefräst: nur Dreiecke, die ganz im Durchbruch liegen, fehlen.
 * Nur Rechnen, keine Oberfläche (läuft in den Tests).
 */

export interface CarveSurface {
  /** je Eckpunkt 8 Werte: x, y, z, Normale x, y, z, Bild u, v */
  data: Float32Array;
  index: Uint32Array;
}

/** true = Diagonale von Ecke 00 nach 11, false = von 10 nach 01 */
export function diagonal00to11(h00: number, h10: number, h01: number, h11: number): boolean {
  return Math.abs(h00 - h11) <= Math.abs(h10 - h01);
}

/**
 * @param H  Höhe je Eckpunkt (0 = Oberkante, nie tiefer als −T), H[j * nx + i]
 * @param X0,Y0  Lage des ersten Eckpunkts, cs = Abstand
 * @param T  Materialdicke; Oberkante liegt bei z = T
 */
export function carveSurface(H: Float32Array, nx: number, ny: number, X0: number, Y0: number, cs: number, T: number): CarveSurface {
  const at = (i: number, j: number) => H[(j < 0 ? 0 : j >= ny ? ny - 1 : j) * nx + (i < 0 ? 0 : i >= nx ? nx - 1 : i)];
  // Punkt liegt in der Ebene: alle vier Nachbarn gleich hoch
  const level = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = H[j * nx + i];
    if (at(i - 1, j) === v && at(i + 1, j) === v && at(i, j - 1) === v && at(i, j + 1) === v) level[j * nx + i] = 1;
  }
  const flatCell = (i: number, j: number) => {
    const a = j * nx + i;
    return level[a] && level[a + 1] && level[a + nx] && level[a + nx + 1] && H[a] === H[a + 1] && H[a] === H[a + nx];
  };
  const gone = -T + 1e-3;
  let index = new Uint32Array(Math.max(1024, nx * 12));
  let n = 0;
  const grow = () => { if (n + 6 > index.length) { const g = new Uint32Array(index.length * 2); g.set(index); index = g; } };
  const tri = (a: number, b: number, c: number) => {
    if (H[a] <= gone && H[b] <= gone && H[c] <= gone) return;   // durchgefräst: offen
    index[n++] = a; index[n++] = b; index[n++] = c;
  };
  const done = new Uint8Array(nx * ny);
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    if (done[j * nx + i]) continue;
    grow();
    if (!flatCell(i, j)) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;   // a = 00, b = 10, c = 01, d = 11
      if (diagonal00to11(H[a], H[b], H[c], H[d])) { tri(a, b, d); tri(a, d, c); }
      else { tri(a, b, c); tri(b, d, c); }
      continue;
    }
    // ebene Fläche: so großes Rechteck wie möglich (zwei Dreiecke statt Tausende)
    const v = H[j * nx + i];
    let w = 1;
    while (i + w + 1 < nx && !done[j * nx + i + w] && flatCell(i + w, j) && H[j * nx + i + w] === v) w++;
    let h = 1;
    for (; j + h + 1 < ny; h++) {
      let ok = true;
      for (let q = 0; q < w; q++) {
        const id = (j + h) * nx + i + q;
        if (done[id] || !flatCell(i + q, j + h) || H[id] !== v) { ok = false; break; }
      }
      if (!ok) break;
    }
    for (let b = 0; b < h; b++) done.fill(1, (j + b) * nx + i, (j + b) * nx + i + w);
    const a = j * nx + i;
    tri(a, a + w, a + h * nx + w); tri(a, a + h * nx + w, a + h * nx);
  }
  // nur benutzte Punkte in die Liste
  const map = new Int32Array(nx * ny).fill(-1);
  let used = 0;
  for (let k = 0; k < n; k++) { const q = index[k]; if (map[q] < 0) map[q] = used++; index[k] = map[q]; }
  const data = new Float32Array(used * 8);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const m = map[j * nx + i];
    if (m < 0) continue;
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * cs), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * cs);
    const l = Math.sqrt(dx * dx + dy * dy + 1);
    let o = m * 8;
    data[o++] = X0 + i * cs; data[o++] = Y0 + j * cs; data[o++] = T + H[j * nx + i];
    data[o++] = -dx / l; data[o++] = -dy / l; data[o++] = 1 / l;
    data[o++] = (i + 0.5) / nx; data[o++] = 1 - (j + 0.5) / ny;
  }
  return { data, index: index.slice(0, n) };
}
