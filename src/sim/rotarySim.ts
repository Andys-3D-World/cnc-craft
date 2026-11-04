/**
 * SIMULATION MIT DREHACHSE: Bahnen um das runde Teil wickeln (3D-Ansicht in simView.ts)
 *
 * Gezeigt wird das Teil, wie es im Futter liegt: Achse entlang X auf Höhe z = −R (Z 0 = Oberkante des Rohteils),
 * die Bahnen dort, wo der Fräser/Laser das Teil berührt. Zwei Fälle:
 *   - „surface“: G-Code der Zeichnung vor der Umrechnung (Y = mm rundherum auf der Oberfläche) → Winkel = Y / R
 *   - „a“: fertiger G-Code mit A-Achse (Grad), Y = Querfahrt (meist 0, beim Fräsen von mehreren Seiten nicht)
 * Der Fräser steht oben (+Z); bei Winkel θ berührt er die Stelle (y, z) des Teils, die um +X um θ gedreht oben liegt
 * – gleiche Richtung wie cam3d.rs (rotary_field) und rotary3d.ts.
 * Bewegungen mit Drehung werden in Stücke von höchstens 2° geteilt, damit sie auf dem Zylinder rund aussehen.
 * Achse entlang Y: intern gerechnet wie entlang X (X_i = Y, Y_i = −X, siehe rotaryWrap.ts), gezeigt wird das Teil
 * wieder entlang Y. „Drehrichtung umkehren“: A bedeutet die Gegenrichtung.
 * Andere Rohteile: Z 0 liegt bei refRadius über der Achse (R = refRadius) – dieselbe Rechnung stimmt für fertigen
 * G-Code mit A auch beim Vieleck und beim Kegel. Zeichnung auf dem Kegel: Winkel = Weg / örtlicher Radius.
 * Die Tiefe für die Farben kommt je Bewegung aus dem Abstand zur echten Oberfläche (rotaryStock.surfaceRadius).
 * Für den Materialabtrag (simCarve.ts) entstehen nicht runde Bahnen gleich im Raster-System:
 *   Kegel: x = entlang, y = Winkel × größter Radius, z = Abstand zur Achse − örtlicher Radius.
 *   Eckig: x = entlang, y = Stelle im Band (Flächenmitte + Querfahrt), z = Tiefe unter dieser Fläche; dazu die Fläche.
 */
import type { SimProgram } from "./gcodeParser";
import { type RotaryStock, surfaceRadius, coneRadius, coneCenter, faces, isPrism, perimeter } from "../rotaryStock.ts";

const STEP = (2 * Math.PI) / 180;   // höchstens 2° je Stück
const MAX_MOVES = 4_000_000;

export interface WrapSimOpts {
  aScale?: number;        // Teil-Drehung je Grad A (Rollen-Drehachse: Rolle Ø / Teil Ø, sonst 1)
  along?: "x" | "y";      // Lage der Drehachse
  reverse?: boolean;      // Drehrichtung umgekehrt
  stock?: RotaryStock;    // Form des Rohteils (fehlt = rund mit Radius R)
}

export function wrapSimProgram(p: SimProgram, R: number, mode: "surface" | "a", o: WrapSimOpts = {}): SimProgram {
  const useA = mode === "a" && !!p.a0 && !!p.a1;
  const ay = o.along === "y";
  const aK = (o.aScale ?? 1) * (o.reverse ? -1 : 1);
  // intern: entlang (ax) und quer (cr)
  const ax = (i: number, end: boolean) => ay ? (end ? p.y1[i] : p.y0[i]) : (end ? p.x1[i] : p.x0[i]);
  const cr = (i: number, end: boolean) => ay ? -(end ? p.x1[i] : p.x0[i]) : (end ? p.y1[i] : p.y0[i]);
  const stock: RotaryStock = o.stock ?? { shape: "round", diameter: 2 * R, width: 0, height: 0, sides: 4, flats: 0, d0: 0, d1: 0, coneLen: 1 };
  // Zeichnung auf dem Kegel: Winkel und Höhe hängen von der Stelle entlang der Achse ab
  const cone = !useA && stock.shape === "cone";
  const coneMid = (ay ? -1 : 1) * coneCenter(stock);
  const thAt = (axial: number, cross: number) => cone ? (cross - coneMid) / coneRadius(stock, axial) : cross / R;
  const th = (i: number, end: boolean) => useA
    ? ((end ? p.a1![i] : p.a0![i]) * Math.PI * aK) / 180
    : thAt(ax(i, end), cr(i, end));
  // Stückzahl je Bewegung (bei sehr vielen Bewegungen gröber)
  let total = 0;
  const pieces = new Uint32Array(p.n);
  for (let i = 0; i < p.n; i++) {
    pieces[i] = Math.max(1, Math.ceil(Math.abs(th(i, true) - th(i, false)) / STEP - 1e-9));
    // Kegel: auch ohne viel Drehung in Stücke, der Winkel ändert sich entlang der Achse
    if (cone) pieces[i] = Math.max(pieces[i], Math.ceil(Math.abs(ax(i, true) - ax(i, false)) / 5));
    total += pieces[i];
  }
  if (total > MAX_MOVES) {
    const k = MAX_MOVES / total;
    total = 0;
    for (let i = 0; i < p.n; i++) { pieces[i] = Math.max(1, Math.floor(pieces[i] * k)); total += pieces[i]; }
  }
  const x0 = new Float32Array(total), y0 = new Float32Array(total), z0 = new Float32Array(total);
  const x1 = new Float32Array(total), y1 = new Float32Array(total), z1 = new Float32Array(total);
  const depth = new Float32Array(total);
  // nicht rund: Raster für den Materialabtrag
  const body = stock.shape !== "round";
  const fs = isPrism(stock) ? faces(stock) : [];
  const Rmax = perimeter(stock) / (2 * Math.PI), a0 = fs[0]?.apothem ?? R;
  const band = ay ? -1 : 1;  // Achse entlang Y: intern läuft das Band andersherum
  const nb = body ? total : 0;
  const theta = new Float32Array(nb);
  const rx0 = new Float32Array(nb), ry0 = new Float32Array(nb), rz0 = new Float32Array(nb);
  const rx1 = new Float32Array(nb), ry1 = new Float32Array(nb), rz1 = new Float32Array(nb);
  const rface = fs.length ? new Int16Array(nb).fill(-1) : null;
  /** Fläche, die bei Winkel t (rad, intern) oben liegt, −1 = dazwischen */
  const faceOn = (t: number) => {
    const d = ((((t * band * 180) / Math.PI) % 360) + 360) % 360;
    return fs.findIndex(f => Math.min(Math.abs(d - f.angle), 360 - Math.abs(d - f.angle)) < 0.01);
  };
  const type = new Uint8Array(total), line = new Uint32Array(total), t0 = new Float64Array(total), dur = new Float32Array(total);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let aMin = Infinity, aMax = -Infinity;
  let cutMin = Infinity, cutMax = -Infinity;
  /** Abstand Punkt – Oberfläche an der Stelle (negativ = im Material); along = entlang der Achse */
  const depthAt = (along: number, q: number, zz: number) => {
    const u = zz + R;
    return Math.hypot(q, u) - surfaceRadius(stock, along, Math.atan2(q, u));
  };
  // Punkt (x, Querfahrt ym, Höhe z, Winkel t) → Lage am Teil
  const put = (x: number, ym: number, z: number, t: number, X: Float32Array, Y: Float32Array, Z: Float32Array, k: number) => {
    const c = Math.cos(t), s = Math.sin(t), r = R + z;
    const py = ym * c + r * s, pz = -ym * s + r * c - R;
    // gezeigt: Achse entlang X (x, py) oder zurück gedreht entlang Y (−py, x)
    const qx = ay ? -py : x, qy = ay ? x : py;
    X[k] = qx; Y[k] = qy; Z[k] = pz;
    if (qx < minX) minX = qx; if (qx > maxX) maxX = qx;
    if (qy < minY) minY = qy; if (qy > maxY) maxY = qy;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
  };
  let k = 0;
  for (let i = 0; i < p.n; i++) {
    const n = pieces[i];
    const ta = th(i, false), tb = th(i, true);
    aMin = Math.min(aMin, ta, tb); aMax = Math.max(aMax, ta, tb);
    const ya = useA ? cr(i, false) : 0, yb = useA ? cr(i, true) : 0;
    const xa = ax(i, false), xb = ax(i, true);
    for (let q = 0; q < n; q++, k++) {
      const u0 = q / n, u1 = (q + 1) / n;
      const L = (a: number, b: number, u: number) => a + (b - a) * u;
      // Kegel: Winkel je Stück neu, Höhe über der Schräge (Z 0 = Anfang des Kegels)
      const tAt = (u: number) => cone ? thAt(L(xa, xb, u), L(cr(i, false), cr(i, true), u)) : L(ta, tb, u);
      const zAt = (u: number) => L(p.z0[i], p.z1[i], u) + (cone ? coneRadius(stock, L(xa, xb, u)) - R : 0);
      put(L(xa, xb, u0), L(ya, yb, u0), zAt(u0), tAt(u0), x0, y0, z0, k);
      put(L(xa, xb, u1), L(ya, yb, u1), zAt(u1), tAt(u1), x1, y1, z1, k);
      const q0 = ay ? -x0[k] : y0[k], q1 = ay ? -x1[k] : y1[k];
      const d = Math.min(depthAt(L(xa, xb, u0), q0, z0[k]), depthAt(L(xa, xb, u1), q1, z1[k]));
      depth[k] = d;
      if (p.type[i] === 1) { if (d < cutMin) cutMin = d; if (d > cutMax) cutMax = d; }
      if (body) {
        const t0 = tAt(u0), t1 = tAt(u1), z0k = zAt(u0), z1k = zAt(u1), a0k = L(xa, xb, u0), a1k = L(xa, xb, u1);
        theta[k] = t1;
        rx0[k] = a0k; rx1[k] = a1k;
        if (fs.length) {
          // Eckig: A steht still = auf der Fläche; sonst dreht das Teil gerade, das Werkzeug ist oben (kein Abtrag)
          const fk = Math.abs(t1 - t0) < 1e-5 ? faceOn(t1) : -1;
          rface![k] = fk;
          if (fk >= 0) {
            const f = fs[fk], dz = f.apothem - a0;
            ry0[k] = f.center + band * L(ya, yb, u0); ry1[k] = f.center + band * L(ya, yb, u1);
            rz0[k] = z0k - dz; rz1[k] = z1k - dz;
          } else { rz0[k] = rz1[k] = 1e3; }
        } else {
          ry0[k] = t0 * Rmax; ry1[k] = t1 * Rmax;
          rz0[k] = R + z0k - coneRadius(stock, a0k); rz1[k] = R + z1k - coneRadius(stock, a1k);
        }
      }
      type[k] = p.type[i]; line[k] = p.line[i];
      dur[k] = p.dur[i] / n;
      t0[k] = p.t0[i] + (p.dur[i] * q) / n;
    }
  }
  if (!total) { minX = minY = minZ = maxX = maxY = maxZ = 0; aMin = aMax = 0; }
  const deg = 180 / Math.PI;
  return {
    ...p, n: total, x0, y0, z0, x1, y1, z1, type, line, t0, dur, a0: undefined, a1: undefined,
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    // Farben: bei runden Teilen wie im G-Code, sonst aus den Abständen zur Oberfläche
    ...(stock.shape !== "round" && cutMin <= cutMax ? { cutMinZ: cutMin, cutMaxZ: cutMax } : {}),
    rotary: { R, flat: p.bounds, aMin: aMin * deg, aMax: aMax * deg, along: ay ? "y" : "x", stock, depth,
      ...(body ? { theta, raster: { x0: rx0, y0: ry0, z0: rz0, x1: rx1, y1: ry1, z1: rz1, face: rface } } : {}) }
  };
}

/** Tiefe eines Punkts am gewickelten Teil (Abstand zur Achse − R) – für die Farben nach Tiefe; q = quer zur Achse */
export function radialDepth(q: number, z: number, R: number): number {
  return Math.hypot(q, z + R) - R;
}
