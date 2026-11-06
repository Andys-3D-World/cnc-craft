/**
 * SPERRZONEN FÜR SPANNPRATZEN (nur Fräse)
 *
 * Eine Sperrzone ist ein Rechteck oder Kreis in der Zeichnung mit `keepOut: { height, margin }` – wird nie gefräst.
 * Höhe = Oberkante der Pratze über Z0, Sicherheitshöhe = Höhe + Luft.
 *
 * Nachbearbeitung des fertigen G-Codes:
 *  - Eilfahrt (G0) durch eine Zone unter der Sicherheitshöhe: vorher Z hoch, danach wieder auf die alte Höhe
 *  - Schnitt in eine Zone unter ihrer Höhe lässt sich nicht umgehen: Warnung mit der Form, der G-Code bleibt, wie er ist
 *  - Lage unbekannt (Anfang, nach Werkzeugwechsel, G53): die Eilfahrt zählt, als ginge sie durch alle Zonen
 * Die Zone wird um den Fräser-Radius vergrößert (der Fräser hat eine Breite).
 * Keine Abhängigkeiten (Tests: `npm test`).
 */

export interface Pt2 { x: number; y: number }
export interface KeepZone { pts: Pt2[]; height: number; margin: number }
export interface KeepHit { zone: number; label: string; line: number; kind: "cut" | "rapid" }
export interface KeepResult { gcode: string; raised: number; hits: KeepHit[]; unsure: boolean }

export const KEEP_HEIGHT = 15, KEEP_MARGIN = 5;

export function isKeepOut(s: any): boolean { return !!s?.keepOut; }

/** Werte aus der Datei absichern */
export function keepValues(s: any): { height: number; margin: number } {
  const h = Number(s?.keepOut?.height), m = Number(s?.keepOut?.margin);
  return { height: Number.isFinite(h) ? h : KEEP_HEIGHT, margin: Number.isFinite(m) && m >= 0 ? m : KEEP_MARGIN };
}

export function pointInPoly(p: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number {
  // Schnitt?
  const cross = (o: Pt2, p: Pt2, q: Pt2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  const pt = (p: Pt2, q: Pt2, r: Pt2) => {
    const dx = r.x - q.x, dy = r.y - q.y, l = dx * dx + dy * dy;
    const f = l > 1e-12 ? Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / l)) : 0;
    return Math.hypot(p.x - (q.x + dx * f), p.y - (q.y + dy * f));
  };
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}

interface Z extends KeepZone { x0: number; y0: number; x1: number; y1: number }
const prep = (z: KeepZone): Z => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of z.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { ...z, x0, y0, x1, y1 };
};

/** Berührt die Strecke a–b die um r vergrößerte Zone? */
export function segHitsZone(a: Pt2, b: Pt2, z: KeepZone & Partial<Z>, r: number): boolean {
  const q = z.x0 === undefined ? prep(z) : (z as Z);
  if (Math.max(a.x, b.x) < q.x0 - r || Math.min(a.x, b.x) > q.x1 + r || Math.max(a.y, b.y) < q.y0 - r || Math.min(a.y, b.y) > q.y1 + r) return false;
  if (pointInPoly(a, q.pts) || pointInPoly(b, q.pts)) return true;
  const n = q.pts.length;
  for (let i = 0; i < n; i++) if (segDist(a, b, q.pts[i], q.pts[(i + 1) % n]) <= r) return true;
  return false;
}

const WORD = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
const num = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3);

export function applyKeepOuts(gcode: string, zonesIn: KeepZone[], opts: { radius: number; note: string }): KeepResult {
  const zones = zonesIn.filter(z => z.pts.length >= 3).map(prep);
  if (!zones.length) return { gcode, raised: 0, hits: [], unsure: false };
  const r = Math.max(0, opts.radius);
  const out: string[] = [];
  const hits: KeepHit[] = [];
  const seen = new Set<string>();
  let x: number | null = null, y: number | null = null, z: number | null = null;
  let abs = true, k = 1, motion = 0, plane = 17, raised = 0, unsure = false, label = "";
  const hit = (zi: number, kind: KeepHit["kind"], line: number) => {
    const key = `${zi}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ zone: zi, label, line, kind });
  };

  const lines = gcode.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const mark = raw.trim().match(/^\(-{2,}\s*(.*?)\s*-*\)$/);
    if (mark) label = mark[1];
    let code = raw;
    if (code.indexOf("(") >= 0) code = code.replace(/\([^)]*\)/g, "");
    const semi = code.indexOf(";");
    if (semi >= 0) code = code.slice(0, semi);
    code = code.trim().toUpperCase();
    if (!code || code[0] === "$") { out.push(raw); continue; }

    const w: Record<string, number> = {};
    let special = false, stop = false;
    WORD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD.exec(code)) !== null) {
      const v = parseFloat(m[2]);
      if (m[1] === "G") {
        const g = Math.round(v * 10);
        if (g === 0 || g === 10 || g === 20 || g === 30) motion = g / 10;
        else if (g === 900) abs = true;
        else if (g === 910) { abs = false; unsure = true; }
        else if (g === 200) k = 25.4;
        else if (g === 210) k = 1;
        else if (g === 170 || g === 180 || g === 190) plane = g / 10;
        else if (g === 530 || g === 280 || g === 300 || (g >= 380 && g < 390)) special = true;
        else if (g === 100 || g === 920 || g === 921) { special = true; unsure = true; }
      } else if (m[1] === "M") {
        if (v === 0 || v === 1 || v === 6) stop = true;
      } else if (m[1] !== "N") w[m[1]] = v;
    }
    // Maschine steht danach woanders (Handbetrieb, Wechselposition)
    if (stop) { out.push(raw); x = y = z = null; continue; }
    if (special) { out.push(raw); x = y = z = null; continue; }
    if (!abs) { out.push(raw); x = y = z = null; continue; }

    const hasXY = "X" in w || "Y" in w, hasZ = "Z" in w;
    if (!hasXY && !hasZ) { out.push(raw); continue; }
    const nx: number | null = "X" in w ? w.X * k : x, ny: number | null = "Y" in w ? w.Y * k : y, nz: number | null = hasZ ? w.Z * k : z;
    const from = x !== null && y !== null ? { x, y } : null;
    const to = nx !== null && ny !== null ? { x: nx, y: ny } : null;

    if (motion === 0) {
      if (hasXY) {
        // Welche Zonen liegen im Weg? Lage unbekannt: alle
        let need = -Infinity;
        for (const q of zones) {
          const crossing = !from || !to || segHitsZone(from, to, q, r);
          if (crossing) need = Math.max(need, q.height + q.margin);
        }
        if (need > -Infinity && (z === null || z < need || (nz !== null && nz < need))) {
          const up = z === null ? need : Math.max(z, need);
          if (z === null || z < up) { out.push(`G0 Z${num(up / k)} ${opts.note}`); raised++; }
          // X/Y für sich, Z danach
          out.push(hasZ ? `G0${"X" in w ? ` X${w.X}` : ""}${"Y" in w ? ` Y${w.Y}` : ""}` : raw);
          if (nz !== null && nz < up) out.push(`G0 Z${num(nz / k)} ${opts.note}`);
        } else out.push(raw);
        // Endet die Fahrt tief in einer Zone, kommt der Fräser dort herunter
        if (to && nz !== null) zones.forEach((q, i) => { if (nz < q.height && segHitsZone(to, to, q, r)) hit(i, "rapid", li); });
      } else {
        out.push(raw);
        if (to && nz !== null && (z === null || nz < z)) zones.forEach((q, i) => { if (nz < q.height && segHitsZone(to, to, q, r)) hit(i, "rapid", li); });
      }
    } else {
      out.push(raw);
      // Schnitt: Bogen als Strecken prüfen
      const low = Math.min(z ?? Infinity, nz ?? Infinity);
      if (to && low < Infinity) {
        const path: Pt2[] = from ? [from] : [to];
        if (motion >= 2 && plane === 17 && from) {
          let cx: number, cy: number;
          if ("R" in w && !("I" in w) && !("J" in w)) {
            const rr = w.R * k, dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy);
            const h = d > 1e-9 ? Math.sqrt(Math.max(0, rr * rr - (d / 2) ** 2)) : 0;
            const sgn = (motion === 2) === (rr > 0) ? -1 : 1;
            cx = from.x + dx / 2 + (d > 1e-9 ? (sgn * h * -dy) / d : 0);
            cy = from.y + dy / 2 + (d > 1e-9 ? (sgn * h * dx) / d : 0);
          } else { cx = from.x + (w.I || 0) * k; cy = from.y + (w.J || 0) * k; }
          const rad = Math.hypot(from.x - cx, from.y - cy);
          const a0 = Math.atan2(from.y - cy, from.x - cx), a1 = Math.atan2(to.y - cy, to.x - cx);
          let sw = a1 - a0;
          if (motion === 2) { while (sw >= -1e-9) sw += -Math.PI * 2; } else { while (sw <= 1e-9) sw += Math.PI * 2; }
          const segs = Math.max(4, Math.ceil(Math.abs(sw) / 0.2));
          for (let s = 1; s < segs; s++) { const a = a0 + (sw * s) / segs; path.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) }); }
        }
        path.push(to);
        zones.forEach((q, i) => {
          if (low >= q.height) return;
          for (let s = 1; s < path.length; s++) if (segHitsZone(path[s - 1], path[s], q, r)) { hit(i, "cut", li); return; }
        });
      }
    }
    x = nx; y = ny; z = nz;
  }
  return { gcode: out.join("\n"), raised, hits, unsure };
}

