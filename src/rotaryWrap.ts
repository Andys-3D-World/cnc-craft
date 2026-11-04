/**
 * DREHACHSE – G-Code auf den Zylinder umrechnen (Laser und Fräse, ohne Abhängigkeiten → testbar)
 *
 * Der G-Code ist für die abgewickelte Fläche gerechnet (Y = mm rundherum auf der Oberfläche). Hier wird:
 *   1. Y in die Drehung umgerechnet: A in Grad (eigene A-Achse) oder Y-Weg (Drehachse am Y-Anschluss)
 *   2. jeder Bogen (G2/G3) in kurze Geraden zerlegt – ein Bogen in X/Y ist auf dem Zylinder keiner mehr
 *   3. der Vorschub je Fahrt neu gesetzt: GRBL & Co. rechnen F über alle Achsen zusammen, bei A also in
 *      „Grad pro Minute“. F wird so umgerechnet, dass die Geschwindigkeit auf der Oberfläche stimmt.
 *      Fräse: Die Schneide steht tiefer (Z < 0 = in den Zylinder hinein), dort ist der Weg rundherum kürzer.
 * Was nicht sicher umzurechnen ist (G91 relativ, G20 Zoll, G92/G10, Bögen außerhalb G17), wird abgelehnt.
 *
 * LAGE DER DREHACHSE: Gerechnet wird immer so, als läge die Achse entlang X („intern“). Liegt sie an der Maschine
 * entlang Y, wird vorher und nachher um 90° gedreht (axesToInternal / axesToMachine) – eine Drehung, keine
 * Spiegelung: X_intern = Y, Y_intern = −X. A dreht dann (rechte Hand) um +Y statt um +X.
 * Andersherum drehende Achse („Drehrichtung umkehren“): der Wert für die Drehung bekommt ein Minus.
 *
 * ROHTEIL-FORM (rotaryStock.ts):
 *  - Eckig/Vieleck (wrapPrism): Die Flächen liegen nebeneinander im Band. Jede Fläche wird eben bearbeitet: A dreht
 *    auf die Fläche, dann normaler X/Y/Z-Code (Bögen bleiben Bögen, Vorschub bleibt). Quer = Abstand zur Flächenmitte,
 *    Z 0 = Fläche 1; niedrigere/höhere Flächen werden ausgeglichen. VOR JEDER DREHUNG fährt Z über die Ecke.
 *    Wozu eine Fläche gehört, entscheidet die Mitte der Schnitte zwischen zwei Eilgängen; läuft ein Schnitt weiter als
 *    `overrun` über die Kante, wird abgelehnt.
 *  - Kegel (wrapCone): rundherum zählt die Oberfläche am örtlichen Durchmesser (Winkel = Weg / örtlicher Radius),
 *    Z folgt der Schräge; Stücke höchstens 1 mm, weil der Winkel sich entlang der Achse ändert.
 */
import { type RotaryStock, faces, faceAt, isPrism, cornerRadius, coneRadius, coneCenter } from "./rotaryStock.ts";

export interface WrapOptions {
  axis: "y" | "a";      // eigene A-Achse (Grad) oder Y-Anschluss (Y-Weg)
  driveDia: number;     // Durchmesser, der die Drehung bestimmt (Rolle oder Teil)
  partDia: number;      // Durchmesser des Teils (für den Vorschub an der Schneide)
  mmPerRot: number;     // Y-Weg pro Umdrehung (nur Y-Anschluss)
  depthFeed: boolean;   // Fräse: Vorschub auf den Radius an der Schneide (R + Z) beziehen
  along?: "x" | "y";    // Lage der Drehachse an der Maschine (Standard X)
  reverse?: boolean;    // Drehrichtung umkehren
  /** "internal": G-Code ist schon intern (Achse entlang X, z. B. 3D rundum) – nur am Ende auf die Maschine drehen */
  input?: "machine" | "internal";
  stock?: RotaryStock;  // Form des Rohteils (fehlt = rund)
  overrun?: number;     // Eckig: so weit (mm) darf ein Schnitt über die Kante laufen (Fräser-Überstand, Laser-Auslauf)
  laser?: boolean;      // Laser: vor dem Drehen zusätzlich S0
  faceLabel?: (k: number) => string; // Kommentar an der Drehung (Fläche k)
}

export type WrapError = "relative" | "inch" | "offset" | "plane" | "arc" | "crossing" | "cycle";
export type WrapResult = { ok: true; lines: string[] } | { ok: false; error: WrapError; line: number };

/** Y (mm auf der Oberfläche) → Wert für die Maschine */
export function mapSurfaceY(y: number, o: WrapOptions): number {
  const turns = (o.reverse ? -y : y) / (Math.PI * o.driveDia);
  return o.axis === "a" ? turns * 360 : turns * o.mmPerRot;
}

/** Wörter X/Y/I/J umbenennen (mit Vorzeichen), Kommentare bleiben – eine Drehung um 90° um Z */
function remapAxes(src: string[], map: Record<string, [string, number]>): string[] {
  const n4 = (v: number) => (Math.abs(v) < 5e-5 ? "0" : String(+v.toFixed(4)));
  return src.map(line => /^\s*\$/.test(line) ? line : line.replace(/(\([^)]*\)|;.*$)|(?<![A-Z])([XYIJ])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi,
    (m, comment, l, v) => {
      if (comment) return m;
      const [nl, sg] = map[l.toUpperCase()];
      return nl + n4(sg * parseFloat(v));
    }));
}
/** Maschine (Achse entlang Y) → intern (Achse entlang X): X_i = Y, Y_i = −X */
export const axesToInternal = (src: string[]) => remapAxes(src, { X: ["Y", -1], Y: ["X", 1], I: ["J", -1], J: ["I", 1] });
/** intern → Maschine (Achse entlang Y): X = −Y_i, Y = X_i */
export const axesToMachine = (src: string[]) => remapAxes(src, { X: ["Y", 1], Y: ["X", -1], I: ["J", 1], J: ["I", -1] });

const SEG = 0.5; // Bögen: höchstens so lange Geraden (mm)

export function wrapGcode(src: string[], o: WrapOptions): WrapResult {
  if (o.stock && isPrism(o.stock)) return wrapPrism(src, o, o.stock);
  const inner = (l: string[]) => o.stock?.shape === "cone" ? wrapCone(l, o, o.stock) : wrapInternal(l, o);
  if (o.along !== "y") return inner(src);
  const r = inner(o.input === "internal" ? src : axesToInternal(src));
  return r.ok ? { ok: true, lines: axesToMachine(r.lines) } : r;
}

function wrapInternal(src: string[], o: WrapOptions): WrapResult {
  const out: string[] = [];
  const R = o.partDia / 2;
  const n4 = (v: number) => (Math.abs(v) < 5e-5 ? "0" : String(+v.toFixed(4)));
  const yw = o.axis === "a" ? "A" : "Y";
  let abs = true, plane = 17, motion = -1;
  let x: number | null = null, y: number | null = null, z: number | null = null;
  let feed: number | null = null;      // Vorschub laut Programm (mm/min auf der Oberfläche)
  let sentF: number | null = null;     // zuletzt an die Maschine geschickter Vorschub
  const fail = (error: WrapError, line: number): WrapResult => ({ ok: false, error, line: line + 1 });

  /** Vorschub für eine Schnittfahrt, damit die Oberfläche mit `feed` läuft */
  const feedFor = (dx: number, dy: number, dz: number, zMid: number): number | null => {
    if (feed === null) return null;
    const dm = mapSurfaceY(dy, o);
    // Weg an der Schneide rundherum: auf der Oberfläche dy, in der Tiefe entsprechend kürzer
    const k = o.depthFeed && R > 0 ? Math.max(0.05, (R + Math.min(0, zMid)) / R) : 1;
    const surf = Math.hypot(dx, dy * k, dz), mach = Math.hypot(dx, dm, dz);
    return surf > 1e-9 ? feed * (mach / surf) : feed;
  };
  const fWord = (f: number | null): string => {
    if (f === null) return "";
    const r = Math.max(1, Math.round(f));
    if (r === sentF) return "";
    sentF = r;
    return " F" + r;
  };

  for (let li = 0; li < src.length; li++) {
    const raw = src[li];
    const code = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    if (/^\s*\$/.test(raw) || !code.trim()) { out.push(raw); continue; }
    const words: [string, number][] = [];
    for (const w of code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) words.push([w[1], parseFloat(w[2])]);
    const gs = words.filter(w => w[0] === "G").map(w => w[1]);
    const get = (l: string) => words.find(w => w[0] === l)?.[1];

    if (gs.includes(20)) return fail("inch", li);
    if (gs.some(g => g === 92 || g === 10)) return fail("offset", li);
    if (gs.includes(90)) abs = true;
    if (gs.includes(91)) abs = false;
    for (const p of [17, 18, 19]) if (gs.includes(p)) plane = p;
    for (const g of gs) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    if (gs.some(g => g === 80 || (g >= 81 && g <= 89))) motion = -1;
    const F = get("F");
    if (F !== undefined) feed = F;
    // Maschinenkoordinaten / Referenzfahrt: unverändert, Lage danach unbekannt
    if (gs.some(g => g === 53 || g === 28 || g === 30)) { out.push(raw); x = y = z = null; continue; }

    const X = get("X"), Y = get("Y"), Z = get("Z");
    const moves = X !== undefined || Y !== undefined || Z !== undefined;
    if (moves && !abs) return fail("relative", li);

    // Bogen → Geraden
    if (moves && (motion === 2 || motion === 3)) {
      if (plane !== 17) return fail("plane", li);
      if (x === null || y === null) return fail("arc", li);
      // Laser fährt kein Z: dann bleibt Z auch in den Stücken weg
      const zKnown: boolean = z !== null || Z !== undefined;
      const sx: number = x, sy: number = y, sz: number = z ?? Z ?? 0;
      const tx = X ?? sx, ty = Y ?? sy, tz = Z ?? sz;
      const pts = arcPoints(sx, sy, tx, ty, motion === 2, get("I"), get("J"), get("R"));
      if (!pts) return fail("arc", li);
      // übrige Wörter (S, M …) bleiben am ersten Stück
      const extra = words.filter(w => !"GXYZIJKRFN".includes(w[0])).map(w => w[0] + n4(w[1])).join(" ");
      let px = sx, py = sy, pz = sz;
      for (let k = 0; k < pts.length; k++) {
        const [qx, qy, u] = pts[k], qz = sz + (tz - sz) * u;
        out.push(`G1 X${n4(qx)} ${yw}${n4(mapSurfaceY(qy, o))}${zKnown && (qz !== pz || k === 0) ? ` Z${n4(qz)}` : ""}`
          + fWord(feedFor(qx - px, qy - py, qz - pz, (qz + pz) / 2)) + (k === 0 && extra ? " " + extra : ""));
        px = qx; py = qy; pz = qz;
      }
      x = tx; y = ty; z = zKnown ? tz : null;
      continue;
    }

    // alle anderen Zeilen: Y umrechnen, F bei Schnittfahrten neu setzen (Kommentare bleiben unangetastet)
    let line = raw.replace(/(\([^)]*\))|(?<![A-Z])Y\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi, (m, comment, v) =>
      comment ? m : yw + n4(mapSurfaceY(parseFloat(v), o)));
    const cut = moves && motion === 1;
    if (!cut && F !== undefined) sentF = Math.max(1, Math.round(F)); // Bohrzyklus, Vorschub ohne Fahrt …
    if (cut) {
      line = line.replace(/(\([^)]*\))|\s*(?<![A-Z])F\s*[-+]?(?:\d+\.?\d*|\.\d+)/gi, (m, comment) => comment ? m : "");
      const tx = X ?? x, ty = Y ?? y, tz = Z ?? z;
      // Z unbekannt (Laser): zählt als 0
      const z0 = z ?? tz ?? 0, z1 = tz ?? z0;
      const known = x !== null && y !== null && tx !== null && ty !== null;
      const fw = fWord(known ? feedFor(tx! - x!, ty! - y!, z1 - z0, (z0 + z1) / 2) : feed);
      // F vor einen Kommentar am Zeilenende setzen
      const cm = line.match(/\s*(\([^)]*\)|;.*)\s*$/);
      line = cm ? line.slice(0, cm.index) + fw + line.slice(cm.index) : line + fw;
    }
    out.push(line);
    if (moves && motion >= 0) { x = X ?? x; y = Y ?? y; z = Z ?? z; }
    else if (moves && motion === -1) { x = X ?? x; y = Y ?? y; } // Bohrzyklus: X/Y bleiben, Z endet oben
  }
  return { ok: true, lines: out };
}

const CLEAR_ROTATE = 5;  // mm über der höchsten Ecke beim Drehen

/** Wörter einer Zeile (ohne Kommentare) */
function lineWords(raw: string) {
  const code = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
  const words: [string, number][] = [];
  for (const w of code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) words.push([w[1], parseFloat(w[2])]);
  return { words, gs: words.filter(w => w[0] === "G").map(w => w[1]), get: (l: string) => words.find(w => w[0] === l)?.[1] };
}

/** Punkte eines Bogens (ohne Start, mit Ende), null = ungültig */
function arcPoints(sx: number, sy: number, tx: number, ty: number, cw: boolean, I?: number, J?: number, Rr?: number, seg = SEG): [number, number, number][] | null {
  let cx: number, cy: number;
  if (Rr !== undefined) {
    const dxe = tx - sx, dye = ty - sy, d = Math.hypot(dxe, dye);
    if (d < 1e-9 || Math.abs(Rr) < d / 2 - 1e-6) return null;
    const hgt = Math.sqrt(Math.max(0, Rr * Rr - (d * d) / 4)) * (cw !== (Rr < 0) ? -1 : 1);
    cx = sx + dxe / 2 - (dye / d) * hgt; cy = sy + dye / 2 + (dxe / d) * hgt;
  } else { cx = sx + (I ?? 0); cy = sy + (J ?? 0); }
  const rad = Math.hypot(sx - cx, sy - cy);
  if (rad < 1e-6 || Math.abs(rad - Math.hypot(tx - cx, ty - cy)) > 0.01) return null;
  const a0 = Math.atan2(sy - cy, sx - cx);
  let sweep = Math.atan2(ty - cy, tx - cx) - a0;
  if (cw) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
  else if (sweep <= 1e-9) sweep += 2 * Math.PI;
  const n = Math.max(4, Math.ceil((Math.abs(sweep) * rad) / seg));
  const out: [number, number, number][] = [];
  for (let k = 1; k <= n; k++) {
    const u = k / n, an = a0 + sweep * u;
    out.push([k === n ? tx : cx + rad * Math.cos(an), k === n ? ty : cy + rad * Math.sin(an), u]);
  }
  return out;
}

/**
 * ECKIG / VIELECK: siehe oben. Gerechnet wird direkt in den Achsen der Maschine: u = Y (Achse entlang X) bzw.
 * X (Achse entlang Y) – der Wert wird zum Abstand von der Flächenmitte; die andere Achse bleibt, wie sie ist.
 */
function wrapPrism(src: string[], o: WrapOptions, stock: RotaryStock): WrapResult {
  const fs = faces(stock);
  const ay = o.along === "y";
  const U = ay ? "X" : "Y", AX = ay ? "Y" : "X";
  const overrun = o.overrun ?? 5;
  const sign = (ay ? -1 : 1) * (o.reverse ? -1 : 1);
  const a0 = fs[0].apothem;
  const zSafe = cornerRadius(stock) - a0 + CLEAR_ROTATE;
  const n3 = (v: number) => (Math.abs(v) < 5e-4 ? "0" : String(+v.toFixed(3)));
  const fail = (error: WrapError, line: number): WrapResult => ({ ok: false, error, line: line + 1 });

  // 1. Durchgang: Gruppen (Eilgang über dem Material bis zum nächsten) und ihr Bereich im Band
  interface Group { start: number; u: number | null; min: number; max: number; firstCut: number }
  const groups: Group[] = [{ start: -1, u: null, min: Infinity, max: -Infinity, firstCut: -1 }];
  let abs = true, plane = 17, motion = -1;
  let cu: number | null = null, ca: number | null = null, cz: number | null = null;
  for (let li = 0; li < src.length; li++) {
    if (/^\s*\$/.test(src[li])) continue;
    const { words, gs, get } = lineWords(src[li]);
    if (!words.length) continue;
    if (gs.includes(20)) return fail("inch", li);
    if (gs.some(g => g === 92 || g === 10)) return fail("offset", li);
    if (gs.some(g => g >= 73 && g <= 89 && g !== 80)) return fail("cycle", li);
    if (gs.includes(90)) abs = true;
    if (gs.includes(91)) abs = false;
    for (const p of [17, 18, 19]) if (gs.includes(p)) plane = p;
    for (const g of gs) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    if (gs.some(g => g === 53 || g === 28 || g === 30)) continue;
    const Wu = get(U), Wa = get(AX), Wz = get("Z");
    if (Wu === undefined && Wa === undefined && Wz === undefined) continue;
    if (!abs) return fail("relative", li);
    if (motion < 0) continue;
    const tu: number | null = Wu ?? cu, ta: number | null = Wa ?? ca, tz: number | null = Wz ?? cz;
    const g = groups[groups.length - 1];
    const lateral = Wu !== undefined || Wa !== undefined;
    if (motion === 0 && lateral && (cz ?? 0) >= -1e-6 && (tz ?? 0) >= -1e-6) {
      groups.push({ start: li, u: tu, min: Infinity, max: -Infinity, firstCut: -1 });
    } else {
      // Schnitt (oder Eilgang im Material): zählt zum Bereich
      const add = (v: number | null) => { if (v !== null) { if (g.firstCut < 0) g.firstCut = li; g.min = Math.min(g.min, v); g.max = Math.max(g.max, v); } };
      add(cu); add(tu);
      if (motion === 2 || motion === 3) {
        if (plane !== 17) return fail("plane", li);
        if (cu === null || ca === null) return fail("arc", li);
        // Achsen wie im Programm: (X, Y)
        const sx = ay ? cu : ca, sy = ay ? ca : cu, ex = ay ? (tu ?? cu) : (ta ?? ca), ey = ay ? (ta ?? ca) : (tu ?? cu);
        const pts = arcPoints(sx, sy, ex, ey, motion === 2, get("I"), get("J"), get("R"), 2);
        if (!pts) return fail("arc", li);
        for (const p of pts) add(ay ? p[0] : p[1]);
      }
    }
    cu = tu; ca = ta; cz = tz;
  }
  // Fläche je Gruppe
  const faceOf: { face: typeof fs[number]; center: number }[] = [];
  let prev = { face: fs[0], center: fs[0].center };
  for (const g of groups) {
    let f = prev;
    if (g.min <= g.max) {
      f = faceAt(fs, (g.min + g.max) / 2);
      const lo = f.center - f.face.width / 2 - overrun, hi = f.center + f.face.width / 2 + overrun;
      if (g.min < lo || g.max > hi) return fail("crossing", g.firstCut);
    } else if (g.u !== null) f = faceAt(fs, g.u);
    faceOf.push(f);
    prev = f;
  }

  // 2. Durchgang: ausgeben
  const out: string[] = [];
  let gi = 0, cur = faceOf[0], sentA: number | null = null;
  let begun = false;
  cu = ca = cz = null; abs = true; motion = -1;
  const rotate = (f: typeof cur) => {
    out.push(`G0 Z${n3(zSafe)}${o.laser ? " S0" : ""}`);
    const want = f.face.angle * sign;
    // der kurze Weg: ganze Umdrehungen dazu oder weg
    const a = sentA === null ? want : want + 360 * Math.round((sentA - want) / 360);
    sentA = a;
    out.push(`G0 A${n3(a)}${o.faceLabel ? ` (${o.faceLabel(f.face.k)})` : ""}`);
  };
  const rewrite = (raw: string, f: typeof cur) => {
    const dz = f.face.apothem - a0;
    return raw.replace(/(\([^)]*\)|;.*$)|(?<![A-Z])([XYZ])\s*([-+]?(?:\d+\.?\d*|\.\d+))/gi, (m, comment, l, v) => {
      if (comment) return m;
      const L = l.toUpperCase();
      if (L === U) return U + n3(parseFloat(v) - f.center);
      if (L === "Z") return "Z" + n3(parseFloat(v) + dz);
      return m;
    });
  };
  for (let li = 0; li < src.length; li++) {
    const raw = src[li];
    if (/^\s*\$/.test(raw)) { out.push(raw); continue; }
    const { words, gs, get } = lineWords(raw);
    if (!words.length) { out.push(raw); continue; }
    for (const g of gs) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    const moves = get(U) !== undefined || get(AX) !== undefined || get("Z") !== undefined;
    const machineCoord = gs.some(g => g === 53 || g === 28 || g === 30);
    if (!moves || motion < 0 || machineCoord) { out.push(raw); continue; }
    // vor der ersten Fahrt: sicher hoch, A auf die erste Fläche
    if (!begun) { begun = true; rotate(cur); }
    const tu: number | null = get(U) ?? cu, ta: number | null = get(AX) ?? ca, tz: number | null = get("Z") ?? cz;
    if (gi + 1 < groups.length && groups[gi + 1].start === li) {
      gi++;
      const next = faceOf[gi];
      if (next.face.k !== cur.face.k) {
        rotate(next);
        cur = next;
        // erst querfahren, dann auf die alte Höhe über der neuen Fläche
        if (tu !== null) out.push(`G0 ${ta !== null ? `${AX}${n3(ta)} ` : ""}${U}${n3(tu - cur.center)}`);
        out.push(rewrite(raw, cur));
        if (get("Z") === undefined) out.push(`G0 Z${n3((tz ?? 0) + cur.face.apothem - a0)}`);
        cu = tu; ca = ta; cz = tz;
        continue;
      }
      cur = next;
    }
    out.push(rewrite(raw, cur));
    cu = tu; ca = ta; cz = tz;
  }
  return { ok: true, lines: out };
}

/**
 * KEGEL (intern: Achse entlang X, y = Weg rundherum): siehe oben. Vorschub wie wrapInternal: Oberflächen-Weg am
 * Radius der Schneide gegen den Weg, den die Steuerung über alle Achsen rechnet.
 */
function wrapCone(src: string[], o: WrapOptions, stock: RotaryStock): WrapResult {
  const out: string[] = [];
  const n4 = (v: number) => (Math.abs(v) < 5e-5 ? "0" : String(+v.toFixed(4)));
  const yw = o.axis === "a" ? "A" : "Y";
  const r0 = coneRadius(stock, 0);
  // Mitte des Bands intern: Achse entlang Y zählt die Zeichnung in X, intern Y = −X
  const yc = (o.along === "y" ? -1 : 1) * coneCenter(stock);
  const turn = (y: number, x: number) => {
    const t = (((o.reverse ? -1 : 1) * (y - yc)) / coneRadius(stock, x)) / (2 * Math.PI);
    return o.axis === "a" ? t * 360 : t * o.mmPerRot;
  };
  const fail = (error: WrapError, line: number): WrapResult => ({ ok: false, error, line: line + 1 });
  let abs = true, plane = 17, motion = -1;
  let x: number | null = null, y: number | null = null, z = 0;
  let feed: number | null = null, sentF: number | null = null;
  for (let li = 0; li < src.length; li++) {
    const raw = src[li];
    if (/^\s*\$/.test(raw)) { out.push(raw); continue; }
    const { words, gs, get } = lineWords(raw);
    if (!words.length) { out.push(raw); continue; }
    if (gs.includes(20)) return fail("inch", li);
    if (gs.some(g => g === 92 || g === 10)) return fail("offset", li);
    if (gs.some(g => g >= 73 && g <= 89 && g !== 80)) return fail("cycle", li);
    if (gs.includes(90)) abs = true;
    if (gs.includes(91)) abs = false;
    for (const p of [17, 18, 19]) if (gs.includes(p)) plane = p;
    for (const g of gs) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    const F = get("F");
    if (F !== undefined) feed = F;
    if (gs.some(g => g === 53 || g === 28 || g === 30)) { out.push(raw); continue; }
    const X = get("X"), Y = get("Y"), Z = get("Z");
    if (X === undefined && Y === undefined && Z === undefined) {
      if (F !== undefined) sentF = Math.max(1, Math.round(F));
      out.push(raw);
      continue;
    }
    if (!abs) return fail("relative", li);
    if (motion < 0) { out.push(raw); continue; }
    const tx: number | null = X ?? x, ty: number | null = Y ?? y, tz: number = Z ?? z;
    const comment = raw.match(/\([^)]*\)/)?.[0];
    const extra = words.filter(w => !"GXYZIJKRFN".includes(w[0])).map(w => w[0] + n4(w[1])).join(" ");
    if (tx === null || ty === null) {
      // Lage noch unbekannt (z. B. „G0 Z5“ am Anfang): Z gilt über dem Anfang des Kegels
      if (tx !== null || ty !== null) { x = tx; y = ty; }
      out.push(`G${motion} Z${n4(tz + (tx === null ? 0 : coneRadius(stock, tx) - r0))}${extra ? " " + extra : ""}${comment ? " " + comment : ""}`);
      z = tz;
      continue;
    }
    const sx = x ?? tx, sy = y ?? ty, sz = z;
    let pts: [number, number, number][];
    if (motion === 2 || motion === 3) {
      if (plane !== 17) return fail("plane", li);
      const a = arcPoints(sx, sy, tx, ty, motion === 2, get("I"), get("J"), get("R"));
      if (!a) return fail("arc", li);
      pts = a;
    } else if (motion === 0 || Math.abs(tx - sx) < 1e-9) {
      pts = [[tx, ty, 1]];
    } else {
      const n = Math.max(1, Math.ceil(Math.hypot(tx - sx, ty - sy)));
      pts = Array.from({ length: n }, (_, k) => {
        const u = (k + 1) / n;
        return [sx + (tx - sx) * u, sy + (ty - sy) * u, u] as [number, number, number];
      });
    }
    let px = sx, py = sy, pz = sz;
    const g = motion === 0 ? 0 : 1;
    pts.forEach(([qx, qy, u], k) => {
      const qz = sz + (tz - sz) * u;
      const rq = coneRadius(stock, qx), rp = coneRadius(stock, px);
      const zm = qz + rq - r0;
      let fw = "";
      if (g === 1 && feed !== null) {
        const zmP = pz + rp - r0, dT = turn(qy, qx) - turn(py, px);
        const kCut = o.depthFeed ? Math.max(0.05, (rq + Math.min(0, qz)) / rq) : 1;
        const surf = Math.hypot(qx - px, (qy - py) * kCut, qz - pz), mach = Math.hypot(qx - px, dT, zm - zmP);
        const f = Math.max(1, Math.round(surf > 1e-9 ? feed * (mach / surf) : feed));
        if (f !== sentF) { sentF = f; fw = " F" + f; }
      }
      out.push(`G${g} X${n4(qx)} ${yw}${n4(turn(qy, qx))} Z${n4(zm)}${fw}${k === 0 && extra ? " " + extra : ""}${k === 0 && comment ? " " + comment : ""}`);
      px = qx; py = qy; pz = qz;
    });
    x = tx; y = ty; z = tz;
  }
  return { ok: true, lines: out };
}
