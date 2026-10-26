/**
 * VORSCHUB IN KURVEN ANPASSEN (Feedrate Adaptive Control) – nur Fräse.
 *
 * Problem: In engen Kurven und Innenecken umschlingt der Fräser mehr Material als auf der Geraden
 * (bei einem durchgehenden Nutschnitt liegt die äußere Wand immer „innen“ um den Fräser herum).
 * Mit gleichem F gibt es dort Rattern oder einen abgebrochenen Fräser.
 *
 * Verfahren (Nachbearbeitung des fertigen G-Codes, deshalb stimmen Simulation und Zeit automatisch):
 *   1. Zusammenhängende Schnitt-Bewegungen in der Ebene (G1/G2/G3 ohne Z-Änderung) bilden eine Kette.
 *   2. Entlang der Kette wird die Richtungsänderung gezählt: Ecken als Sprung, Bögen gleichmäßig (Länge / Radius).
 *      Im Fenster von einem Fräserdurchmesser ergibt das einen „wirksamen Radius“ R = Fenster / Drehung.
 *   3. Faktor = R / (R + Fräserradius) – die bekannte Formel für Innenbögen (Schneide läuft außen schneller).
 *      Ab 90 % bleibt der normale Vorschub, darunter in 10-%-Stufen, nie unter dem Minimum.
 *   4. Kurz vor und nach der Ecke (Fräserradius) wird schon/noch langsam gefahren; lange Geraden und Bögen werden
 *      dafür geteilt. F wird nur geschrieben, wenn es sich ändert.
 * Bei G20 (Zoll), G91 (relativ) oder einer anderen Ebene als G17 bleibt der G-Code unverändert.
 */

/** Einstellungen (rechte Seite → Fräsparameter) */
export const feedAdapt = { on: true, minPct: 50 };
const KEY = "cnc_craft_feed_adapt";

export function loadFeedAdapt() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.on === "boolean") feedAdapt.on = o.on;
    if (Number.isFinite(+o.minPct)) feedAdapt.minPct = clampPct(+o.minPct);
  } catch { /* Standardwerte */ }
}

export function saveFeedAdapt() {
  try { localStorage.setItem(KEY, JSON.stringify(feedAdapt)); } catch { /* egal */ }
}

export const clampPct = (v: number) => Math.max(10, Math.min(100, Math.round(v)));

interface Pt { x: number; y: number }
/** Schnitt-Bewegung in der Ebene */
interface Move {
  line: number;          // Zeile im Original
  text: string;          // Originalzeile ohne F
  g: 1 | 2 | 3;
  a: Pt; b: Pt; z: number;
  c?: Pt; r?: number;    // Bogen: Mittelpunkt, Radius
  len: number;
  d0: Pt; d1: Pt;        // Richtung am Anfang / Ende
  base: number;          // Vorschub laut Original
  s0: number;            // Lage in der Kette
}

const WORD = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/gi;
const fmt = (v: number) => v.toFixed(3);
const unit = (x: number, y: number): Pt => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };

/**
 * @param gcode       G-Code (Ausschnitt) – Position und F vom Anfang sind nicht bekannt, bis sie gesetzt werden
 * @param toolRadius  Fräserradius in mm
 * @param minPct      kleinster Vorschub in % (10 … 100)
 * @param startFeed   F, das vor dem Ausschnitt gilt (falls bekannt)
 */
export function adaptFeed(gcode: string, toolRadius: number, minPct: number, startFeed?: number): string {
  const r = Math.max(0.05, toolRadius);
  const minF = clampPct(minPct) / 100;
  if (minF >= 1) return gcode;
  const win = Math.max(0.5, 2 * r);       // Fenster = Fräserdurchmesser
  const lead = Math.max(0.5, r);          // so weit vor/nach der Ecke schon langsam

  const lines = gcode.split("\n");
  let pos = null as Pt | null, z = NaN, mot = 0, base = startFeed ?? NaN;
  /** Kette: je Zeile die Bewegung oder null; Ketten werden an „fremden“ Zeilen getrennt */
  const moves: (Move | null)[] = new Array(lines.length).fill(null);
  const chains: Move[][] = [];
  let chain: Move[] = [];
  const endChain = () => { if (chain.length) chains.push(chain); chain = []; };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const hasComment = /[(;]/.test(raw);
    const code = raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").trim();
    if (!code) continue;
    const w: Record<string, number> = {};
    const gs: number[] = [];
    let other = false;
    for (const m of code.matchAll(WORD)) {
      const k = m[1].toUpperCase(), v = parseFloat(m[2]);
      if (k === "G") gs.push(v); else w[k] = v;
      if (!"GXYZIJF".includes(k)) other = true;
    }
    // Zoll, relativ, andere Ebene: lieber gar nichts ändern
    if (gs.some(g => g === 20 || g === 91 || g === 18 || g === 19)) return gcode;
    const motion = gs.find(g => g === 0 || g === 1 || g === 2 || g === 3);
    if (motion !== undefined) mot = motion;
    if (w.F !== undefined) base = w.F;
    const moving = w.X !== undefined || w.Y !== undefined || w.Z !== undefined;
    if (!moving) {
      // reine F-Zeile oder Kommentar trennt die Kette nicht, alles andere schon
      if (other || gs.some(g => g !== 0 && g !== 1 && g !== 2 && g !== 3)) endChain();
      continue;
    }
    const a: Pt | null = pos;
    const b: Pt | null = a ? { x: w.X ?? a.x, y: w.Y ?? a.y } : (w.X !== undefined && w.Y !== undefined ? { x: w.X, y: w.Y } : null);
    const nz = w.Z ?? z;
    const flat = Number.isFinite(z) && Math.abs(nz - z) < 1e-6;
    let mv: Move | null = null;
    if (a && b && flat && !hasComment && !other && mot >= 1 && Number.isFinite(base) && base > 0
      && gs.every(g => g === mot)) {
      const text = raw.replace(/\s*F\s*[+-]?(?:\d+\.?\d*|\.\d+)/i, "");
      if (mot === 1) {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > 1e-6) { const d = unit(b.x - a.x, b.y - a.y); mv = { line: i, text, g: 1, a, b, z: nz, len, d0: d, d1: d, base, s0: 0 }; }
      } else if (w.I !== undefined || w.J !== undefined) {
        const c = { x: a.x + (w.I ?? 0), y: a.y + (w.J ?? 0) };
        const rad = Math.hypot(a.x - c.x, a.y - c.y);
        if (rad > 1e-4) {
          const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
          let sweep = mot === 2 ? a0 - a1 : a1 - a0;
          while (sweep <= 1e-9) sweep += 2 * Math.PI;
          const tan = (p: Pt) => mot === 3 ? unit(-(p.y - c.y), p.x - c.x) : unit(p.y - c.y, -(p.x - c.x));
          mv = { line: i, text, g: mot as 2 | 3, a, b, z: nz, c, r: rad, len: rad * sweep, d0: tan(a), d1: tan(b), base, s0: 0 };
        }
      }
    }
    if (mv) {
      chain.push(mv); moves[i] = mv;
    } else endChain();
    if (b) pos = b;
    z = nz;
  }
  endChain();

  // ---- Faktoren je Stück berechnen ----
  type Piece = { g: 1 | 2 | 3; a: Pt; b: Pt; c?: Pt; f: number; text?: string };
  const pieces = new Map<number, Piece[]>();
  for (const ch of chains) {
    let s = 0;
    for (const m of ch) { m.s0 = s; s += m.len; }
    const total = s;
    const first = ch[0], last = ch[ch.length - 1];
    const closed = ch.length > 1 && Math.hypot(first.a.x - last.b.x, first.a.y - last.b.y) < 1e-3;
    // Ecken: Sprung am Ende jeder Bewegung (bei geschlossenen Ketten auch am Schluss)
    const kink = ch.map((m, k) => {
      const n = k + 1 < ch.length ? ch[k + 1] : closed ? first : null;
      if (!n) return 0;
      return Math.atan2(Math.abs(m.d1.x * n.d0.y - m.d1.y * n.d0.x), m.d1.x * n.d0.x + m.d1.y * n.d0.y);
    });
    // T(s): Richtungsänderung von 0 bis s (Ecke zählt ab ihrer Stelle)
    const tAt: number[] = [];
    let acc = 0;
    ch.forEach((m, k) => { tAt.push(acc); acc += (m.r ? m.len / m.r : 0) + kink[k]; });
    const tTot = acc;
    const T0 = (u: number): number => {
      if (u <= 0) return 0;
      if (u >= total) return tTot;
      let lo = 0, hi = ch.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ch[mid].s0 <= u) lo = mid; else hi = mid - 1; }
      const m = ch[lo];
      return tAt[lo] + (m.r ? (u - m.s0) / m.r : 0);
    };
    const T = (u: number): number => {
      if (!closed) return u < 0 ? 0 : u >= total ? tTot : T0(u);
      const k = Math.floor(u / total), rest = u - k * total;
      return k * tTot + T0(rest);
    };
    const fAt = (u: number): number => {
      const turn = T(u + win / 2) - T(u - win / 2 - 1e-9);
      if (turn < 1e-9) return 1;
      const rEff = win / turn;
      return rEff / (rEff + r);
    };
    /** kleinster Faktor für das Stück [p, q] einer Bewegung, mit Vor-/Nachlauf */
    const fPiece = (m: Move, p: number, q: number): number => {
      let f = m.len > win ? fAt(m.s0 + m.len / 2) : 1;
      const step = win / 4;
      const sample = (u0: number, u1: number) => {
        if (u1 < u0) return;
        const n = Math.max(1, Math.ceil((u1 - u0) / step));
        for (let k = 0; k <= n; k++) f = Math.min(f, fAt(u0 + (u1 - u0) * k / n));
      };
      sample(p - lead, Math.min(q + lead, m.s0 + win / 2));
      sample(Math.max(p - lead, m.s0 + m.len - win / 2), q + lead);
      if (p - lead < m.s0 + win / 2 && q + lead > m.s0 + m.len - win / 2) sample(p - lead, q + lead);
      return f;
    };
    const quant = (f: number) => f >= 0.9 ? 1 : Math.max(minF, Math.floor(f * 10 + 1e-9) / 10);
    const d = lead + win / 2 + 0.01;
    for (const m of ch) {
      const s0 = m.s0, s1 = m.s0 + m.len;
      let cuts = [s0, s1], fs = [quant(fPiece(m, s0, s1))];
      if (m.len > 2 * d + 0.1) {
        const fa = quant(fPiece(m, s0, s0 + d)), fm = quant(fPiece(m, s0 + d, s1 - d)), fb = quant(fPiece(m, s1 - d, s1));
        cuts = [s0, s0 + d, s1 - d, s1]; fs = [fa, fm, fb];
        // gleiche Nachbarn zusammenfassen
        for (let k = fs.length - 1; k > 0; k--) if (fs[k] === fs[k - 1]) { fs.splice(k, 1); cuts.splice(k, 1); }
      }
      const at = (u: number): Pt => {
        const tt = (u - s0) / m.len;
        if (!m.c || !m.r) return { x: m.a.x + (m.b.x - m.a.x) * tt, y: m.a.y + (m.b.y - m.a.y) * tt };
        const a0 = Math.atan2(m.a.y - m.c.y, m.a.x - m.c.x), an = a0 + (m.g === 3 ? 1 : -1) * (u - s0) / m.r;
        return { x: m.c.x + m.r * Math.cos(an), y: m.c.y + m.r * Math.sin(an) };
      };
      const list: Piece[] = fs.map((f, k) => ({
        g: m.g, a: k === 0 ? m.a : at(cuts[k]), b: k === fs.length - 1 ? m.b : at(cuts[k + 1]), c: m.c, f
      }));
      if (list.length === 1) list[0].text = m.text;
      pieces.set(m.line, list);
    }
  }

  // ---- neu schreiben: F nur bei Änderung ----
  const out: string[] = [];
  let outF = startFeed ?? NaN;
  base = startFeed ?? NaN; mot = 0;
  const withF = (line: string, f: number) => {
    const k = line.search(/[(;]/);
    return k < 0 ? `${line.trimEnd()} F${f}` : `${line.slice(0, k).trimEnd()} F${f} ${line.slice(k)}`;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\([^)]*\)/g, "").replace(/;.*$/, "");
    const fm = /F\s*([+-]?(?:\d+\.?\d*|\.\d+))/i.exec(code);
    const mg = [...code.matchAll(/G\s*0*(\d+)/gi)].map(m => +m[1]).find(g => g <= 3);
    if (mg !== undefined) mot = mg;
    if (fm) base = parseFloat(fm[1]);
    const ps = moves[i] ? pieces.get(i) : undefined;
    if (!ps) {
      // fremde Vorschub-Bewegung ohne F: ursprünglichen Vorschub wiederherstellen
      if (fm) outF = base;
      else if (mot >= 1 && /[XYZ]/i.test(code) && Number.isFinite(base) && outF !== base) { out.push(withF(raw, base)); outF = base; continue; }
      out.push(raw);
      continue;
    }
    for (const p of ps) {
      const f = p.f >= 1 ? base : Math.max(1, Math.round(base * p.f));
      let text = p.text ?? (p.g === 1
        ? `G1 X${fmt(p.b.x)} Y${fmt(p.b.y)}`
        : `G${p.g} X${fmt(p.b.x)} Y${fmt(p.b.y)} I${fmt(p.c!.x - p.a.x)} J${fmt(p.c!.y - p.a.y)}`);
      if (f !== outF) { text = withF(text, f); outF = f; }
      out.push(text);
    }
  }
  // am Ende wieder den ursprünglichen Vorschub, damit folgender Code stimmt
  if (Number.isFinite(base) && outF !== base) {
    const tail = out.length && out[out.length - 1] === "" ? out.pop() : undefined;
    out.push(`F${base}`);
    if (tail !== undefined) out.push(tail);
  }
  return out.join("\n");
}
