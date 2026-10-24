/**
 * HÖHENKARTE (Oberfläche abtasten, Fräse mit GRBL)
 *
 * Der Taster misst ein Raster von Punkten auf dem Werkstück (ui/probePanel.ts). Gespeichert wird die Höhe jedes
 * Punkts relativ zum ersten Punkt (vorne links). Beim Senden eines Jobs (machineStream.ts) wird jede Z-Angabe um die
 * Höhe an dieser Stelle verschoben – so fräst/graviert die Maschine überall gleich tief, auch auf welligem Material.
 *
 * Damit der Fräser der Oberfläche folgt, werden lange Strecken in kurze Stücke geteilt und Bögen (G2/G3) in
 * kurze Geraden umgewandelt. Alles, was nicht sicher umzurechnen ist (G91 relativ, G20 Zoll, G92/G10, Bohrzyklen,
 * andere Ebenen, Drehachse), wird abgelehnt statt falsch gefräst.
 */
import { t } from "./i18n/i18n";

export interface HeightMap {
  x0: number; y0: number;   // erster Punkt (Werkstück-Koordinaten, mm)
  dx: number; dy: number;   // Abstand der Punkte
  nx: number; ny: number;   // Anzahl Punkte
  z: number[];              // Höhe relativ zum ersten Punkt, Zeile für Zeile (z[j * nx + i])
  date: string;
}

const KEY = "cnc_craft_heightmap";
const KEY_ON = "cnc_craft_heightmap_on";
export const HEIGHTMAP_CHANGED = "cnc-heightmap-changed";

let map: HeightMap | null = null;
let enabled = false;

function valid(m: any): m is HeightMap {
  return m && [m.x0, m.y0, m.dx, m.dy].every(Number.isFinite) && Number.isInteger(m.nx) && Number.isInteger(m.ny)
    && m.nx >= 2 && m.ny >= 2 && m.nx <= 50 && m.ny <= 50 && m.dx > 0 && m.dy > 0
    && Array.isArray(m.z) && m.z.length === m.nx * m.ny && m.z.every(Number.isFinite);
}

export function initHeightMap() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || "null");
    map = valid(m) ? m : null;
    enabled = localStorage.getItem(KEY_ON) === "1" && !!map;
  } catch { map = null; enabled = false; }
}

export function getHeightMap(): HeightMap | null { return map; }
export function heightMapEnabled(): boolean { return enabled && !!map; }

export function setHeightMap(m: HeightMap | null) {
  map = m && valid(m) ? m : null;
  if (!map) enabled = false;
  try {
    if (map) localStorage.setItem(KEY, JSON.stringify(map)); else localStorage.removeItem(KEY);
    localStorage.setItem(KEY_ON, enabled ? "1" : "0");
  } catch { /* egal */ }
  window.dispatchEvent(new Event(HEIGHTMAP_CHANGED));
}

export function setHeightMapEnabled(on: boolean) {
  enabled = on && !!map;
  try { localStorage.setItem(KEY_ON, enabled ? "1" : "0"); } catch { /* egal */ }
  window.dispatchEvent(new Event(HEIGHTMAP_CHANGED));
}

/** Kleinste/größte Höhe (für die Anzeige) */
export function heightRange(m: HeightMap): { min: number; max: number } {
  return { min: Math.min(...m.z), max: Math.max(...m.z) };
}

/** Höhe an (x, y): bilinear zwischen den 4 Nachbarpunkten; außerhalb der Karte der nächste Rand */
export function heightAt(m: HeightMap, x: number, y: number): number {
  const fx = Math.min(m.nx - 1, Math.max(0, (x - m.x0) / m.dx));
  const fy = Math.min(m.ny - 1, Math.max(0, (y - m.y0) / m.dy));
  const i = Math.min(m.nx - 2, Math.floor(fx)), j = Math.min(m.ny - 2, Math.floor(fy));
  const u = fx - i, v = fy - j;
  const z = (a: number, b: number) => m.z[b * m.nx + a];
  return (z(i, j) * (1 - u) + z(i + 1, j) * u) * (1 - v) + (z(i, j + 1) * (1 - u) + z(i + 1, j + 1) * u) * v;
}

function inside(m: HeightMap, x: number, y: number, tol = 0.5): boolean {
  return x >= m.x0 - tol && y >= m.y0 - tol && x <= m.x0 + (m.nx - 1) * m.dx + tol && y <= m.y0 + (m.ny - 1) * m.dy + tol;
}

export interface Compensated {
  lines: string[];       // umgerechnete Zeilen zum Senden
  origin: number[];      // je gesendeter Zeile: Nummer der Original-Zeile (0-basiert)
  outside: number;       // so viele Original-Zeilen fahren außerhalb der Karte (dort gilt der Rand)
}

/**
 * G-Code mit der Höhenkarte umrechnen. Wirft einen Fehler (übersetzter Text), wenn der Code nicht sicher
 * umgerechnet werden kann.
 */
export function compensate(src: string[], m: HeightMap): Compensated {
  const seg = Math.min(5, Math.max(0.5, Math.min(m.dx, m.dy) / 3)); // Stücklänge
  const out: string[] = [];
  const origin: number[] = [];
  let outside = 0;
  let abs = true, plane = 17, motion = -1;
  let x: number | null = null, y: number | null = null, z: number | null = null;
  const f = (v: number) => (Math.abs(v) < 5e-4 ? "0" : v.toFixed(3));
  const fail = (key: string, n: number) => { throw new Error(t(key, { n: n + 1 })); };

  src.forEach((raw, li) => {
    const code = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    const words: [string, number][] = [];
    for (const w of code.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)) words.push([w[1], parseFloat(w[2])]);
    const gs = words.filter(w => w[0] === "G").map(w => w[1]);
    const get = (l: string) => words.find(w => w[0] === l)?.[1];
    const pass = () => { out.push(raw); origin.push(li); };

    if (/^\s*\$/.test(raw) || !words.length) return pass();
    if (gs.includes(20)) fail("hm.errInch", li);
    if (gs.some(g => g === 92 || g === 10)) fail("hm.errOffset", li);
    if (gs.some(g => g >= 38 && g < 39)) fail("hm.errProbe", li);
    if (gs.some(g => g >= 81 && g <= 89)) fail("hm.errCycle", li);
    if (words.some(w => w[0] === "A" || w[0] === "B" || w[0] === "C")) fail("hm.errRotary", li);
    if (gs.includes(90)) abs = true;
    if (gs.includes(91)) abs = false;
    for (const p of [17, 18, 19]) if (gs.includes(p)) plane = p;
    for (const g of gs) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    if (gs.includes(80)) motion = -1;
    // Maschinenkoordinaten oder Referenzfahrt: danach ist die Lage unbekannt (unverändert senden)
    if (gs.some(g => g === 53 || g === 28 || g === 30)) { x = y = z = null; return pass(); }

    const X = get("X"), Y = get("Y"), Z = get("Z");
    if (X === undefined && Y === undefined && Z === undefined) return pass();
    if (!abs) fail("hm.errRelative", li);
    if (motion < 0) return pass();
    const tx = X ?? x, ty = Y ?? y, tz = Z ?? z;
    if (tx === null || ty === null || tz === null) { x = tx; y = ty; z = tz; return pass(); } // Lage noch unbekannt
    if (!inside(m, tx, ty)) outside++;

    // übrige Wörter (F, S, M …) bleiben am ersten Stück
    const extra = words.filter(w => !"GXYZIJKRN".includes(w[0])).map(w => w[0] + (Number.isInteger(w[1]) ? w[1] : +w[1].toFixed(4))).join(" ");
    const emit = (g: number, px: number, py: number, pz: number, first: boolean) => {
      out.push(`G${g} X${f(px)} Y${f(py)} Z${f(pz + heightAt(m, px, py))}${first && extra ? " " + extra : ""}`);
      origin.push(li);
    };

    if (motion === 2 || motion === 3) {
      if (plane !== 17) fail("hm.errPlane", li);
      const sx = x!, sy = y!, sz = z!;
      let cx: number, cy: number;
      const I = get("I"), J = get("J"), R = get("R");
      if (R !== undefined) {
        // Mittelpunkt aus dem Radius (negativ = großer Bogen)
        const dxe = tx - sx, dye = ty - sy, d = Math.hypot(dxe, dye);
        if (d < 1e-9 || Math.abs(R) < d / 2 - 1e-6) fail("hm.errArc", li);
        const hgt = Math.sqrt(Math.max(0, R * R - (d * d) / 4)) * ((motion === 2) !== (R < 0) ? -1 : 1);
        cx = sx + dxe / 2 - (dye / d) * hgt; cy = sy + dye / 2 + (dxe / d) * hgt;
      } else {
        cx = sx + (I ?? 0); cy = sy + (J ?? 0);
      }
      const rad = Math.hypot(sx - cx, sy - cy);
      // Start und Ende müssen auf demselben Kreis liegen (wie GRBL prüft) – sonst lieber ablehnen
      if (rad < 1e-6 || Math.abs(rad - Math.hypot(tx - cx, ty - cy)) > 0.01) fail("hm.errArc", li);
      const a0 = Math.atan2(sy - cy, sx - cx);
      let a1 = Math.atan2(ty - cy, tx - cx);
      let sweep = a1 - a0;
      if (motion === 2) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; } // im Uhrzeigersinn
      else if (sweep <= 1e-9) sweep += 2 * Math.PI;
      const n = Math.max(4, Math.ceil((Math.abs(sweep) * rad) / Math.min(seg, 1)));
      for (let k = 1; k <= n; k++) {
        const u = k / n, an = a0 + sweep * u;
        const px = k === n ? tx : cx + rad * Math.cos(an), py = k === n ? ty : cy + rad * Math.sin(an);
        emit(1, px, py, sz + (tz - sz) * u, k === 1);
      }
    } else if (motion === 0 || x === null || y === null || z === null) {
      emit(motion, tx, ty, tz, true); // Eilgang: nur Endpunkt (Z läuft gerade dazwischen)
    } else {
      const len = Math.hypot(tx - x, ty - y);
      const n = Math.max(1, Math.ceil(len / seg));
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        emit(1, x + (tx - x) * u, y + (ty - y) * u, z + (tz - z) * u, k === 1);
      }
    }
    x = tx; y = ty; z = tz;
  });
  return { lines: out, origin, outside };
}

initHeightMap();
