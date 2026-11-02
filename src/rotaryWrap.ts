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
 */

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
}

export type WrapError = "relative" | "inch" | "offset" | "plane" | "arc";
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
  if (o.along !== "y") return wrapInternal(src, o);
  const r = wrapInternal(o.input === "internal" ? src : axesToInternal(src), o);
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
      let cx: number, cy: number;
      const I = get("I"), J = get("J"), Rr = get("R");
      if (Rr !== undefined) {
        const dxe = tx - sx, dye = ty - sy, d = Math.hypot(dxe, dye);
        if (d < 1e-9 || Math.abs(Rr) < d / 2 - 1e-6) return fail("arc", li);
        const hgt = Math.sqrt(Math.max(0, Rr * Rr - (d * d) / 4)) * ((motion === 2) !== (Rr < 0) ? -1 : 1);
        cx = sx + dxe / 2 - (dye / d) * hgt; cy = sy + dye / 2 + (dxe / d) * hgt;
      } else { cx = sx + (I ?? 0); cy = sy + (J ?? 0); }
      const rad = Math.hypot(sx - cx, sy - cy);
      if (rad < 1e-6 || Math.abs(rad - Math.hypot(tx - cx, ty - cy)) > 0.01) return fail("arc", li);
      const a0 = Math.atan2(sy - cy, sx - cx);
      let sweep = Math.atan2(ty - cy, tx - cx) - a0;
      if (motion === 2) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
      else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      // übrige Wörter (S, M …) bleiben am ersten Stück
      const extra = words.filter(w => !"GXYZIJKRFN".includes(w[0])).map(w => w[0] + n4(w[1])).join(" ");
      const n = Math.max(4, Math.ceil((Math.abs(sweep) * rad) / SEG));
      let px = sx, py = sy, pz = sz;
      for (let k = 1; k <= n; k++) {
        const u = k / n, an = a0 + sweep * u;
        const qx = k === n ? tx : cx + rad * Math.cos(an), qy = k === n ? ty : cy + rad * Math.sin(an), qz = sz + (tz - sz) * u;
        out.push(`G1 X${n4(qx)} ${yw}${n4(mapSurfaceY(qy, o))}${zKnown && (qz !== pz || k === 1) ? ` Z${n4(qz)}` : ""}`
          + fWord(feedFor(qx - px, qy - py, qz - pz, (qz + pz) / 2)) + (k === 1 && extra ? " " + extra : ""));
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
