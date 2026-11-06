/**
 * MATERIALABTRAG LIVE IN DER SIMULATION
 *
 * Dasselbe Höhenraster wie die 3D-Ansicht (view3d/carveSim.ts): jede Zelle merkt sich, wie hoch dort noch
 * Material steht (Oberkante Z = 0, Unterseite −T). Anders als dort wird es Schritt für Schritt aufgebaut –
 * genau bis zu der Stelle, an der die Simulation (oder der echte Job) gerade steht, auch mitten in einer Bewegung.
 *
 * Vorwärts: nur das Stück seit dem letzten Bild wird eingedrückt. Rückwärts geht das nicht (Material wächst nicht
 * nach) – dafür gibt es Zwischenstände (alle paar Millionen Rechenschritte, als 16-Bit-Zahlen, höchstens ~64 MB).
 * Ein Sprung nimmt den letzten Zwischenstand davor und rechnet von dort weiter.
 * advance() rechnet höchstens ein paar Millisekunden je Bild – große Sprünge holen über mehrere Bilder auf.
 *
 * Nebenbei erkannt (Warnung mit G-Code-Zeile):
 *   Eilgang (G0) oder Fahrt mit Spindel aus, die Material wegnimmt · Schaft über der Schneide oder
 *   Spannzange/Halter berührt das Material
 *
 * Laser und Plasma: statt der Höhe merkt sich jede Zelle die „Energie“ (Dosis), die dort angekommen ist – jede
 * Bewegung zählt je Zelle einmal. Laser: Dosis = Leistung (S / S-Max) × 1000 / Vorschub; ab 0,5 × Dicke (mm) gilt
 * die Stelle als durchgeschnitten, darunter wird sie je nach Dosis dunkler (Brandspur). Plasma: alles im
 * Schnittspalt ist durch, daneben Anlauffarbe.
 *
 * Drehachse: Das Raster ist die abgewickelte Oberfläche (entlang der Achse × rundherum, schließt sich rundum).
 * Die gewickelten Bahnen (rotarySim.ts, Stücke ≤ 2°) werden dafür zurückgerechnet: Winkel × R und Abstand zur
 * Achse − R. Gezeigt wird es wieder um den Zylinder (simCarveGl.ts).
 * Andere Rohteile: Das Raster ist genauso die Abwicklung, jede Zelle zählt die Tiefe unter der echten Oberfläche
 * (Bahnen im Raster-System aus rotarySim.ts). Eckig: Der Fräser wirkt nur auf der Fläche, auf der er gerade steht –
 * über die Kante hinaus ist Luft (dass er die Nachbarfläche an der Ecke anschneiden kann, ist nicht nachgebildet).
 * Kegel: Rundherum sind die Zellen am dünnen Ende schmaler (Fräser dort über mehr Zeilen), und entlang der Achse
 * steigt die Oberfläche unter dem waagerechten Fräser an.
 */
import { kernel, profile, type Kernel } from "../view3d/carveSim.ts";
import { MOVE_CUT, MOVE_RAPID, type SimProgram } from "./gcodeParser.ts";
import type { ToolGeom } from "../toolGraphics.ts";
import { type RotaryStock, faces, isPrism, perimeter, cornerRadius, coneRadius } from "../rotaryStock.ts";

const MAX_CELLS = 1_000_000;
const MAX_SIDE = 4096;           // Textur-Größe, die jede Grafikkarte kann
const Q = 0.005;                 // mm je Stufe in den Zwischenständen (Int16: bis −163 mm)
const SNAP_BYTES = 64e6;         // Speicher für alle Zwischenstände zusammen
const TOUCH = 0.05;              // mm: so viel muss weggenommen werden / anliegen, damit es zählt
const DOSE_MAX = 150;            // Laser/Plasma: höher zählt nicht (passt in die Zwischenstände)
/** Plasma: Dosis im Schnittspalt (immer „durch“) und daneben (Anlauffarbe) */
export const PLASMA_CUT = 100, PLASMA_HEAT = 0.6;

/** mill = Höhe abtragen · laser/plasma = Dosis sammeln */
export type CarveKind = "mill" | "laser" | "plasma";

export type WarnKind = "rapid" | "spindleOff" | "shank" | "holder";
export interface CarveWarning { line: number; kind: WarnKind }

/** Fräser mit Schaft, Spannzange und Spindel (vereinfacht, für Anzeige und Kollision) */
export interface ToolHolder {
  R: number;          // Schneiden-Radius
  shankR: number;
  fluteLen: number;   // Schneidenlänge (bei V-Fräsern mindestens die Kegelhöhe)
  stickout: number;   // so weit ragt das Werkzeug aus der Spannzange
  holderR: number;    // Spannmutter
  holderH: number;
  spindleR: number;
  spindleH: number;
}

export function holderFor(tl: ToolGeom | null): ToolHolder {
  const R = Math.max(0.05, (tl?.diameter || 3) / 2);
  const cone = profile(tl)(R);
  const shankR = Math.max(0.5, (tl?.shankDia || tl?.diameter || 3) / 2);
  const fluteLen = Math.max(0.5, tl?.fluteLen || 4 * R, Number.isFinite(cone) ? cone : 0);
  const length = Math.max(fluteLen + 5, tl?.length || 38);
  const stickout = Math.max(fluteLen + 3, length * 0.6);
  // ER11 / ER16 / ER20 je nach Schaft
  const holderR = shankR <= 3.6 ? 9.5 : shankR <= 5.1 ? 14 : 17.5;
  return { R, shankR, fluteLen, stickout, holderR, holderH: 18, spindleR: Math.max(26, holderR + 6), spindleH: 70 };
}

/** Abschnitt (Werkzeug) je Zeile: nach jedem M0/M1/M6 kommt der nächste Fräser – wie carveSim.ts */
export function toolSections(lines: string[]): Int32Array {
  const sect = new Int32Array(lines.length + 1);
  let k = 0;
  lines.forEach((l, i) => {
    sect[i] = k;
    if (/^\s*M0?[016]\b/i.test(l.replace(/\([^)]*\)/g, ""))) k++;
  });
  sect[lines.length] = k;
  return sect;
}

interface Pos { i: number; u: number }
const before = (a: Pos, b: Pos) => a.i < b.i || (a.i === b.i && a.u < b.u - 1e-9);

export interface LiveCarveOptions {
  kind?: CarveKind;
  tools: (ToolGeom | null)[];
  /** Materialdicke (mm); tiefer = durchgefräst, Laser: braucht mehr Dosis zum Durchschneiden */
  thickness: number;
  /** Laser: S-Wert für 100 % · Laserpunkt-Ø (mm) */
  sMax?: number;
  beam?: number;
  /** Plasma: Schnittspalt (mm) */
  kerf?: number;
  /** Rohteil-Platte (Rohteil-Verwaltung, stock.ts), Ecke bei 0/0 – null = nur um die Bahnen */
  stock?: { w: number; h: number } | null;
}

export class LiveCarve {
  readonly nx: number; readonly ny: number;
  readonly x0: number; readonly y0: number;
  readonly cell: number;
  readonly T: number;
  readonly h: Float32Array;
  /** geänderter Bereich seit dem letzten Hochladen [i0, j0, i1, j1) – null = nichts */
  dirty: [number, number, number, number] | null;
  warnings: CarveWarning[] = [];
  /** ändert sich, wenn eine Warnung dazukommt */
  warnVersion = 0;
  readonly kind: CarveKind;
  /** um die Drehachse: Raster = abgewickelte Oberfläche (y = Winkel × R ab −πR), Radius R */
  readonly cyl: { R: number; alongY: boolean; stock: RotaryStock } | null;
  /** Laser: ab dieser Dosis durchgeschnitten */
  readonly cutDose: number;

  private readonly p: SimProgram;
  // Bewegungen im Raster-System (ohne Drehachse: die des Programms)
  private readonly X0: ArrayLike<number>; private readonly Y0: ArrayLike<number>; private readonly Z0: ArrayLike<number>;
  private readonly X1: ArrayLike<number>; private readonly Y1: ArrayLike<number>; private readonly Z1: ArrayLike<number>;
  private readonly pow: Float32Array | null;     // Laser: Leistung je Zeile (0…1)
  private readonly spot: number;                 // Laser/Plasma: Radius (mm)
  private readonly touched: Int32Array | null;   // Laser/Plasma: zuletzt von welcher Bewegung getroffen
  private readonly tools: (ToolGeom | null)[];
  private readonly sect: Int32Array;
  private readonly kernels = new Map<ToolGeom | null, Kernel>();
  private readonly discs = new Map<number, Kernel>();
  private readonly holders = new Map<ToolGeom | null, ToolHolder>();
  private readonly warned = new Set<string>();
  // Eckig: Fläche je Bewegung, Zeilen je Fläche, gerade gültige Zeilen · Kegel
  private readonly faceOf: Int16Array | null;
  private faceRows: [number, number][] = [];
  private jLo = 0; private jHi = Infinity;
  private cone: RotaryStock | null = null;
  private at: Pos = { i: 0, u: 0 };
  private target: Pos = { i: 0, u: 0 };
  private snaps: { i: number; d: Int16Array }[] = [];
  private maxSnaps: number;
  private snapEvery = 3e6;
  private work = 0;           // Rechenschritte seit dem letzten Zwischenstand
  private startI = 0;         // für die Fortschrittsanzeige

  /** null = nichts zu fräsen (keine Bewegung unter Z = 0) */
  static create(p: SimProgram, o: LiveCarveOptions): LiveCarve | null {
    const kind = o.kind ?? "mill";
    const sect = toolSections(p.lines);
    const tools = o.tools.length ? o.tools : [null];
    const toolOf = (m: number) => tools[Math.min(tools.length - 1, sect[p.line[m]] ?? 0)] ?? null;
    const spot = kind === "laser" ? Math.max(0.02, (o.beam ?? 0.15) / 2) : Math.max(0.1, (o.kerf ?? 1.5) / 2);
    const g = rasterMoves(p);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let m = 0; m < p.n; m++) {
      if (kind === "mill" ? Math.min(g.Z0[m], g.Z1[m]) >= 0 : p.type[m] !== MOVE_CUT) continue;
      const R = kind === "mill" ? Math.max(0.05, (toolOf(m)?.diameter || 3) / 2) : spot * (kind === "plasma" ? 2 : 1);
      x0 = Math.min(x0, g.X0[m] - R, g.X1[m] - R); x1 = Math.max(x1, g.X0[m] + R, g.X1[m] + R);
      y0 = Math.min(y0, g.Y0[m] - R, g.Y1[m] - R); y1 = Math.max(y1, g.Y0[m] + R, g.Y1[m] + R);
    }
    if (!(x1 > x0)) return null;
    const margin = Math.max(4, 0.06 * Math.max(x1 - x0, y1 - y0));
    let a = { x0: x0 - margin, y0: y0 - margin, x1: x1 + margin, y1: y1 + margin };
    // Drehachse: rundherum ganz, entlang der Achse nur um die Bahnen
    if (g.cyl) {
      const st = g.cyl.stock, P = perimeter(st);
      a = isPrism(st) ? { x0: a.x0, x1: a.x1, y0: 0, y1: P } : { x0: a.x0, x1: a.x1, y0: -P / 2, y1: P / 2 };
      // Kegel: ganz zeigen
      if (st.shape === "cone") { a.x0 = Math.min(a.x0, 0); a.x1 = Math.max(a.x1, st.coneLen); }
    }
    // Rohteil-Platte: kleine Platte ganz zeigen, große nur um die Bahnen (Ränder der Platte bleiben echte Kanten)
    const s = g.cyl ? null : o.stock;
    if (s && s.w > 0 && s.h > 0) {
      if (s.w * s.h <= 4 * (a.x1 - a.x0) * (a.y1 - a.y0)) {
        a = { x0: Math.min(0, x0), y0: Math.min(0, y0), x1: Math.max(s.w, x1), y1: Math.max(s.h, y1) };
      } else {
        const c = { x0: Math.max(a.x0, Math.min(0, x0)), y0: Math.max(a.y0, Math.min(0, y0)), x1: Math.min(a.x1, Math.max(s.w, x1)), y1: Math.min(a.y1, Math.max(s.h, y1)) };
        if (c.x1 > c.x0 && c.y1 > c.y0) a = c;
      }
    }
    return new LiveCarve(p, g, kind, tools, sect, a, o, spot);
  }

  private constructor(p: SimProgram, g: RasterMoves, kind: CarveKind, tools: (ToolGeom | null)[], sect: Int32Array,
    a: { x0: number; y0: number; x1: number; y1: number }, o: LiveCarveOptions, spot: number) {
    this.p = p; this.tools = tools; this.sect = sect; this.kind = kind; this.cyl = g.cyl; this.spot = spot;
    this.X0 = g.X0; this.Y0 = g.Y0; this.Z0 = g.Z0; this.X1 = g.X1; this.Y1 = g.Y1; this.Z1 = g.Z1;
    const w = a.x1 - a.x0, hh = a.y1 - a.y0;
    let c = Math.max(0.03, Math.sqrt((w * hh) / MAX_CELLS));
    c = Math.max(c, w / MAX_SIDE, hh / MAX_SIDE);
    // rundherum: ganze Zahl von Zellen, damit sich das Raster genau schließt
    if (g.cyl) c = hh / Math.max(8, Math.round(hh / c));
    this.cell = c;
    this.nx = Math.max(2, Math.ceil(w / c)); this.ny = Math.max(2, g.cyl ? Math.round(hh / c) : Math.ceil(hh / c));
    this.x0 = a.x0; this.y0 = a.y0;
    // Fräsen um die Achse: tiefer als bis zur Achse geht nicht
    this.T = g.cyl && kind === "mill" ? cornerRadius(g.cyl.stock) : Math.max(0.2, Math.min(160, o.thickness));
    this.faceOf = g.face;
    if (g.face && g.cyl) this.faceRows = faces(g.cyl.stock).map(f => [Math.floor(f.start / this.cell), Math.ceil(f.end / this.cell)]);
    if (g.cyl?.stock.shape === "cone") this.cone = g.cyl.stock;
    this.cutDose = 0.5 * Math.max(0.2, o.thickness);
    this.pow = kind === "laser" ? linePower(p.lines, o.sMax ?? 1000) : null;
    this.touched = kind === "mill" ? null : new Int32Array(this.nx * this.ny).fill(-1);
    this.h = new Float32Array(this.nx * this.ny);
    this.dirty = [0, 0, this.nx, this.ny];
    this.maxSnaps = Math.max(4, Math.min(64, Math.floor(SNAP_BYTES / (this.nx * this.ny * 2))));
  }

  get program(): SimProgram { return this.p; }

  /** nicht rund: Winkel des Teils an der aktuellen Stelle (rad) – oben liegt gerade diese Stelle */
  get spinNow(): number | null {
    const th = this.p.rotary?.theta;
    if (!th || !th.length) return null;
    return th[Math.max(0, Math.min(th.length - 1, this.target.i))];
  }

  /** Fräser der Bewegung m */
  toolOf(m: number): ToolGeom | null {
    const p = this.p;
    if (!p.n) return this.tools[0] ?? null;
    const line = p.line[Math.max(0, Math.min(p.n - 1, m))];
    return this.tools[Math.min(this.tools.length - 1, this.sect[line] ?? 0)] ?? null;
  }

  holderOf(m: number): ToolHolder {
    const tl = this.toolOf(m);
    let hd = this.holders.get(tl);
    if (!hd) { hd = holderFor(tl); this.holders.set(tl, hd); }
    return hd;
  }

  /** bis hierher fräsen: Bewegung i zum Anteil u (i = n: alles) */
  setTarget(i: number, u: number) {
    const t = { i: Math.max(0, Math.min(this.p.n, i)), u: i >= this.p.n ? 0 : Math.max(0, Math.min(1, u)) };
    if (t.i === this.target.i && Math.abs(t.u - this.target.u) < 1e-9) return;
    this.target = t;
    this.startI = this.at.i;
  }

  /** noch nicht am Ziel */
  get busy(): boolean { return before(this.at, this.target) || before(this.target, this.at); }

  /** Fortschritt eines großen Sprungs (0…1) */
  get progress(): number {
    const span = this.target.i - this.startI;
    return span > 0 ? Math.max(0, Math.min(1, (this.at.i - this.startI) / span)) : 1;
  }

  /** höchstens ms Millisekunden weiterrechnen; true = Raster geändert */
  advance(ms: number): boolean {
    if (!this.busy) return false;
    const t0 = performance.now();
    let changed = false;
    // Zwischenstand nehmen: rückwärts immer, vorwärts wenn einer näher am Ziel liegt
    let best: { i: number; d: Int16Array } | null = null;
    for (const s of this.snaps) if (s.i <= this.target.i) best = s;
    const bi = best ? best.i : 0;
    if (before(this.target, this.at) || bi > this.at.i) {
      if (best) { const d = best.d, h = this.h; for (let k = 0; k < h.length; k++) h[k] = d[k] * Q; }
      else this.h.fill(0);
      this.touched?.fill(-1);
      this.at = { i: bi, u: 0 };
      this.dirty = [0, 0, this.nx, this.ny];
      this.work = 0;
      changed = true;
    }
    const p = this.p;
    while (before(this.at, this.target)) {
      const m = this.at.i;
      if (m >= p.n) break;
      const ub = m === this.target.i ? this.target.u : 1;
      // lange Bewegungen in Stücken, damit ein Bild nie zu lange dauert
      const len = Math.hypot(this.X1[m] - this.X0[m], this.Y1[m] - this.Y0[m], this.Z1[m] - this.Z0[m]);
      const piece = len > 1e-9 ? (300 * Math.max(this.cell, 0.05)) / len : 1;
      const ue = Math.min(ub, this.at.u + piece);
      if (this.carveSpan(m, this.at.u, ue)) changed = true;
      if (ue >= 1 - 1e-9) {
        this.at = { i: m + 1, u: 0 };
        if (this.work >= this.snapEvery) this.snapshot();
      } else this.at = { i: m, u: ue };
      if (performance.now() - t0 > ms) break;
    }
    return changed;
  }

  /** Bewegung m von Anteil ua bis ub eindrücken; true = etwas geändert */
  private carveSpan(m: number, ua: number, ub: number): boolean {
    if (this.kind !== "mill") return this.burnSpan(m, ua, ub);
    const p = this.p;
    const ax = this.X0[m], ay = this.Y0[m], az = this.Z0[m];
    const dx = this.X1[m] - ax, dy = this.Y1[m] - ay, dz = this.Z1[m] - az;
    const za = az + dz * ua, zb = az + dz * ub;
    if (Math.min(za, zb) >= (this.cone ? 50 : 0) || ub <= ua) return false;
    const tl = this.toolOf(m);
    let K = this.kernels.get(tl);
    if (!K) { K = kernel(tl, this.cell); this.kernels.set(tl, K); }
    const f = profile(tl), c = this.cell;
    // so weit reicht der Fräser bis zur Oberkante (V-Fräser in geringer Tiefe nur ein kleiner Kreis) – wie carveSim.ts
    const zmin = Math.min(za, zb);
    let reach = K.R;
    if (f(K.R) > -zmin) { let lo = 0, hi = K.R; for (let it = 0; it < 20; it++) { const mid = (lo + hi) / 2; if (f(mid) <= -zmin) lo = mid; else hi = mid; } reach = lo + c; }
    const len = Math.hypot(dx, dy, dz) * (ub - ua);
    const step = Math.max(c * 0.7, Math.min(reach / 4, c * 3));
    const n = Math.max(1, Math.ceil(len / step));
    const hd = this.holderOf(m);
    const kind = p.type[m];
    if (this.faceOf) {
      const fk = this.faceOf[m];
      if (fk < 0) return false;   // Teil dreht gerade (Werkzeug über der Ecke)
      [this.jLo, this.jHi] = this.faceRows[fk];
    }
    let removed = 0, shank = false, holder = false;
    for (let s = 0; s <= n; s++) {
      const u = ua + ((ub - ua) * s) / n, z = az + dz * u;
      const x = ax + dx * u, y = ay + dy * u;
      // Kegel: Die Oberfläche steigt unter dem waagerechten Fräser an – er kann auch mit Spitze „darüber“ anstoßen
      if (z >= (this.cone ? Math.abs(this.cone.d1 - this.cone.d0) / 2 / this.cone.coneLen * K.R : 0)) continue;
      removed = Math.max(removed, this.stamp(K, x, y, z, reach));
      // Schaft über der Schneide / Spannzange unter der Oberkante: liegt dort noch Material an?
      if (!shank && z + hd.fluteLen < -TOUCH && hd.shankR > reach && this.touches(hd.shankR, x, y, z + hd.fluteLen)) shank = true;
      if (!holder && z + hd.stickout < -TOUCH && this.touches(hd.holderR, x, y, z + hd.stickout)) holder = true;
    }
    this.work += n * Math.min(K.di.length, Math.PI * (reach / c) ** 2);
    const line = p.line[m];
    if (removed > TOUCH && kind !== MOVE_CUT) this.warn(line, kind === MOVE_RAPID ? "rapid" : "spindleOff");
    if (shank) this.warn(line, "shank");
    if (holder) this.warn(line, "holder");
    return removed > 0;
  }

  /** Fräser an Punkt (x, y) mit Spitze auf z; Ergebnis: am meisten weggenommen (mm) */
  private stamp(K: Kernel, x: number, y: number, z: number, reach: number): number {
    const { nx, ny, h, x0, y0, cell: c } = this;
    const ci = Math.floor((x - x0) / c), cj0 = Math.floor((y - y0) / c);
    const r = Math.ceil(reach / c) + 1;
    const wrap = !!this.cyl;
    const cj = wrap ? ((cj0 % ny) + ny) % ny : cj0;
    if (ci + r < 0 || ci - r >= nx || (!wrap && (cj + r < 0 || cj - r >= ny))) return 0;
    const { di, dj, dz, dist } = K;
    const floor = -this.T - 1;
    const { jLo, jHi, cone } = this;
    let most = 0;
    if (cone) {
      // Rundherum: am dünnen Ende sind die Zellen schmaler → Fräser über mehr Zeilen; entlang: Oberfläche steigt an
      const rr = coneRadius(cone, x), kY = (perimeter(cone) / (2 * Math.PI)) / rr;
      const inside = x > 0 && x < cone.coneLen;
      const slope = inside ? (cone.d1 - cone.d0) / 2 / cone.coneLen : 0;
      for (let q = 0; q < di.length; q++) {
        if (dist[q] > reach) break;
        const i = ci + di[q];
        if (i < 0 || i >= nx) continue;
        const v = Math.max(floor, z + dz[q] - slope * di[q] * c);
        const ja = Math.ceil((dj[q] - 0.5) * kY), jb = Math.ceil((dj[q] + 0.5) * kY) - 1;
        for (let jj = ja; jj <= jb; jj++) {
          const j = ((cj + jj) % ny + ny) % ny, id = j * nx + i;
          const d = h[id] - v;
          if (d > 0) { h[id] = v; if (d > most) most = d; }
        }
      }
      if (most > 0) this.markDirty(ci, cj, Math.ceil(r * kY));
      return most;
    }
    for (let q = 0; q < di.length; q++) {
      if (dist[q] > reach) break;
      const i = ci + di[q];
      let j = cj + dj[q];
      if (wrap) j = j < 0 ? j + ny : j >= ny ? j - ny : j;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      if (j < jLo || j >= jHi) continue;
      const v = Math.max(floor, z + dz[q]), id = j * nx + i;
      const d = h[id] - v;
      if (d > 0) { h[id] = v; if (d > most) most = d; }
    }
    if (most > 0) this.markDirty(ci, cj, r);
    return most;
  }

  private markDirty(ci: number, cj: number, r: number) {
    const { nx, ny } = this, a = this.dirty;
    const i0 = Math.max(0, ci - r), i1 = Math.min(nx, ci + r + 1);
    // rundherum über die Naht: ganze Höhe
    let j0 = Math.max(0, cj - r), j1 = Math.min(ny, cj + r + 1);
    if (this.cyl && (cj - r < 0 || cj + r >= ny)) { j0 = 0; j1 = ny; }
    this.dirty = a ? [Math.min(a[0], i0), Math.min(a[1], j0), Math.max(a[2], i1), Math.max(a[3], j1)] : [i0, j0, i1, j1];
  }

  /** Laser/Plasma: Bewegung m von ua bis ub – Dosis je getroffener Zelle einmal */
  private burnSpan(m: number, ua: number, ub: number): boolean {
    const p = this.p;
    if (p.type[m] !== MOVE_CUT || ub <= ua) return false;
    const ax = this.X0[m], ay = this.Y0[m];
    const dx = this.X1[m] - ax, dy = this.Y1[m] - ay;
    const c = this.cell;
    const plasma = this.kind === "plasma";
    let dose = PLASMA_CUT;
    if (!plasma) {
      // Vorschub aus Länge und Dauer (mm/min)
      const len3 = Math.hypot(dx, dy, this.Z1[m] - this.Z0[m]);
      const d = (p.durPlain || p.dur)[m]; // programmierter Vorschub: Rampen sollen die Vorschau nicht abdunkeln
      const feed = d > 1e-9 ? Math.max(10, (len3 / d) * 60) : 1000;
      dose = (this.pow ? this.pow[p.line[m]] : 1) * (1000 / feed);
      if (len3 < 1e-6) dose = (this.pow ? this.pow[p.line[m]] : 1) * Math.max(0.2, d) * 5; // Stillstand (Punkt)
      if (dose <= 0) return false;
    }
    const outer = plasma ? this.spot * 2 : this.spot;
    const reach = Math.max(outer, c * 0.55);
    // kernel() nimmt Zellen bis Radius + halbe Zelle: schmaler Strahl = nur die Zelle darunter
    const key = -Math.round(reach * 1000) - 1;
    let K = this.discs.get(key);
    if (!K) { K = kernel({ type: "endmill", diameter: 2 * Math.max(0.005, reach - c * 0.5) } as ToolGeom, c); this.discs.set(key, K); }
    const inner = Math.max(this.spot, c * 0.55);
    const len = Math.hypot(dx, dy) * (ub - ua);
    const n = Math.max(1, Math.ceil(len / Math.max(c * 0.6, Math.min(reach, c * 2))));
    const { nx, ny, h, x0, y0 } = this, touched = this.touched!, wrap = !!this.cyl;
    let any = false;
    for (let s = 0; s <= n; s++) {
      const u = ua + ((ub - ua) * s) / n;
      const ci = Math.floor((ax + dx * u - x0) / c), cj0 = Math.floor((ay + dy * u - y0) / c);
      const cj = wrap ? ((cj0 % ny) + ny) % ny : cj0;
      let hit = false;
      for (let q = 0; q < K.di.length; q++) {
        const i = ci + K.di[q];
        let j = cj + K.dj[q];
        if (wrap) j = j < 0 ? j + ny : j >= ny ? j - ny : j;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const id = j * nx + i;
        if (plasma) {
          const v = K.dist[q] <= inner ? PLASMA_CUT : PLASMA_HEAT;
          if (h[id] < v) { h[id] = v; hit = true; }
        } else if (touched[id] !== m) {
          touched[id] = m;
          h[id] = Math.min(DOSE_MAX, h[id] + dose);
          hit = true;
        }
      }
      if (hit) { any = true; this.markDirty(ci, cj, Math.ceil(reach / c) + 1); }
    }
    this.work += n * K.di.length;
    return any;
  }

  /** steht innerhalb des Kreises (Radius r um x, y) Material über der Höhe z? */
  private touches(r: number, x: number, y: number, z: number): boolean {
    const key = Math.round(r * 100);
    let D = this.discs.get(key);
    if (!D) { D = kernel({ type: "endmill", diameter: 2 * r } as ToolGeom, this.cell); this.discs.set(key, D); }
    const { nx, ny, h, x0, y0, cell: c } = this;
    const ci = Math.floor((x - x0) / c), cj0 = Math.floor((y - y0) / c);
    const cj = this.cyl ? ((cj0 % ny) + ny) % ny : cj0;
    const lim = z + TOUCH;
    for (let q = 0; q < D.di.length; q++) {
      const i = ci + D.di[q];
      let j = cj + D.dj[q];
      if (this.cyl) j = j < 0 ? j + ny : j >= ny ? j - ny : j;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      if (j < this.jLo || j >= this.jHi) continue;
      if (h[j * nx + i] > lim) return true;
    }
    return false;
  }

  private warn(line: number, kind: WarnKind) {
    const key = line + ":" + kind;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    // nach Zeile sortiert halten (Sprünge können später Zeilen zuerst finden)
    let k = this.warnings.length;
    while (k > 0 && this.warnings[k - 1].line > line) k--;
    this.warnings.splice(k, 0, { line, kind });
    this.warnVersion++;
  }

  private snapshot() {
    const h = this.h, d = new Int16Array(h.length);
    for (let k = 0; k < h.length; k++) d[k] = Math.round(h[k] / Q);
    this.snaps.push({ i: this.at.i, d });
    this.work = 0;
    // zu viele: jeden zweiten wegwerfen, ab jetzt halb so oft
    if (this.snaps.length > this.maxSnaps) {
      this.snaps = this.snaps.filter((_, k) => k % 2 === 1);
      this.snapEvery *= 2;
    }
  }
}

interface RasterMoves {
  X0: ArrayLike<number>; Y0: ArrayLike<number>; Z0: ArrayLike<number>;
  X1: ArrayLike<number>; Y1: ArrayLike<number>; Z1: ArrayLike<number>;
  cyl: { R: number; alongY: boolean; stock: RotaryStock } | null;
  face: Int16Array | null;
}

/**
 * Bewegungen im Raster-System. Ohne Drehachse die des Programms; um die Achse zurück auf die Abwicklung:
 * x = entlang der Achse, y = Winkel × R (stetig, über die Naht hinaus), z = Abstand zur Achse − R
 */
function rasterMoves(p: SimProgram): RasterMoves {
  const rot = p.rotary;
  if (!rot) return { X0: p.x0, Y0: p.y0, Z0: p.z0, X1: p.x1, Y1: p.y1, Z1: p.z1, cyl: null, face: null };
  // Nicht rund: schon fertig im Raster-System
  if (rot.raster) {
    const q = rot.raster;
    return { X0: q.x0, Y0: q.y0, Z0: q.z0, X1: q.x1, Y1: q.y1, Z1: q.z1, cyl: { R: rot.R, alongY: rot.along === "y", stock: rot.stock }, face: q.face };
  }
  const R = rot.R, ay = rot.along === "y", n = p.n;
  const X0 = new Float32Array(n), Y0 = new Float32Array(n), Z0 = new Float32Array(n);
  const X1 = new Float32Array(n), Y1 = new Float32Array(n), Z1 = new Float32Array(n);
  const P = Math.PI * R;
  for (let m = 0; m < n; m++) {
    for (const end of [0, 1]) {
      const x = end ? p.x1[m] : p.x0[m], y = end ? p.y1[m] : p.y0[m], z = end ? p.z1[m] : p.z0[m];
      const along = ay ? y : x, q = ay ? -x : y;
      const v = Math.atan2(q, z + R) * R, d = Math.hypot(q, z + R) - R;
      if (end) {
        let w = v;
        while (w - Y0[m] > P) w -= 2 * P;
        while (w - Y0[m] < -P) w += 2 * P;
        X1[m] = along; Y1[m] = w; Z1[m] = d;
      } else { X0[m] = along; Y0[m] = v; Z0[m] = d; }
    }
  }
  return { X0, Y0, Z0, X1, Y1, Z1, cyl: { R, alongY: ay, stock: rot.stock }, face: null };
}

/** Laserleistung je Zeile (S modal, 0…1); ohne S-Befehle überall 1 */
function linePower(lines: string[], sMax: number): Float32Array {
  const out = new Float32Array(lines.length);
  const max = Math.max(1, sMax);
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].replace(/\([^)]*\)|;.*$/g, "").match(/S\s*(\d*\.?\d+)/i);
    if (m) s = parseFloat(m[1]);
    out[i] = s < 0 ? 1 : Math.min(1, s / max);
  }
  return out;
}
