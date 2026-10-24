/**
 * QR-CODE erzeugen (eigener kleiner Encoder nach ISO/IEC 18004, keine fremde Bibliothek)
 *
 * Byte-Modus (UTF-8), Fehlerkorrektur L/M/Q/H, Versionen 1–40 (kleinste passende wird gewählt),
 * alle 8 Masken werden probiert, die mit den wenigsten Strafpunkten gewinnt.
 * qrOutlines() macht aus den dunklen Modulen geschlossene Umrisse (Löcher inklusive) –
 * so lasert/fräst die Maschine zusammenhängende Flächen statt hunderter Einzelquadrate.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

const ECC_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_IDX: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// Fehlerkorrektur-Bytes je Block und Anzahl Blöcke (Index = Version, 0 unbenutzt)
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];

export interface QrCode { version: number; size: number; modules: boolean[][] }

/** Module (ohne Funktionsmuster) für Daten + Fehlerkorrektur */
function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number, e: number): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
}

// ---- Reed-Solomon über GF(256), Polynom 0x11D ----
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    for (let i = 0; i < div.length; i++) r[i] ^= gfMul(div[i], f);
  }
  return r;
}

function alignPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = ver * 4 + 17 - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

/** Text als QR-Code (null = zu lang für Version 40) */
export function encodeQr(text: string, ecc: QrEcc = "M"): QrCode | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  const e = ECC_IDX[ecc];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver, e) * 8) break;
  }
  if (ver > 40) return null;

  // ---- Bitfolge: Modus 0100 (Byte), Länge, Daten, Ende, Füllbytes ----
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, e) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // ---- Blöcke + Fehlerkorrektur, verschränkt ----
  const nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ec = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ec));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0].length; i++)
    for (let j = 0; j < blocks.length; j++)
      if (i !== shortLen - eccLen || j >= nShort) all.push(blocks[j][i]);

  // ---- Matrix ----
  const size = ver * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x: number, y: number, dark: boolean) => { mod[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = alignPositions(ver);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      setF(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (ECC_BITS[ecc] << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
    setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const bit = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setF(a, c, bit); setF(c, a, bit);
    }
  }

  // Daten im Zickzack von rechts unten
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < all.length * 8) { mod[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }

  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      let inv: boolean;
      switch (m) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      }
      if (inv) mod[y][x] = !mod[y][x];
    }
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty(mod);
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return { version: ver, size, modules: mod };
}

/** Strafpunkte nach der Norm (lange Reihen, 2×2-Blöcke, Sucher-ähnliche Muster, Hell/Dunkel-Verhältnis) */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let p = 0, dark = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else { if (run >= 5) p += run - 2; run = 1; }
    }
    // 1:1:3:1:1 mit 4 hellen Modulen davor oder dahinter
    for (let i = 0; i + 6 < n; i++) {
      if (get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6)) {
        const lightBefore = i >= 4 && !get(i - 1) && !get(i - 2) && !get(i - 3) && !get(i - 4);
        const lightAfter = i + 10 < n && !get(i + 7) && !get(i + 8) && !get(i + 9) && !get(i + 10);
        if (lightBefore || lightAfter) p += 40;
      }
    }
  };
  for (let y = 0; y < n; y++) line(i => m[y][i]);
  for (let x = 0; x < n; x++) line(i => m[i][x]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  const total = n * n;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * Umrisse der dunklen Flächen in Modul-Einheiten (x nach rechts, y nach UNTEN wie im Raster).
 * Außenkanten laufen im Uhrzeigersinn, Löcher andersherum – mit gerade/ungerade-Füllung passt beides.
 */
export function qrOutlines(m: boolean[][]): { x: number; y: number }[][] {
  const n = m.length;
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && m[y][x];
  const key = (x: number, y: number) => y * (n + 1) + x;
  // Kanten: Start-Ecke -> Liste der End-Ecken
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(key(x1, y1));
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!m[y][x]) continue;
    if (!dark(x, y - 1)) add(x, y, x + 1, y);
    if (!dark(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!dark(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!dark(x - 1, y)) add(x, y + 1, x, y);
  }
  const W = n + 1;
  const loops: { x: number; y: number }[][] = [];
  for (const [start, list] of out) {
    while (list.length) {
      const pts: number[] = [start];
      let prev = start, cur = list.pop()!;
      while (cur !== start) {
        pts.push(cur);
        const next = out.get(cur)!;
        // berühren sich zwei Flächen nur an einer Ecke: rechts abbiegen -> getrennte Umrisse
        let pick = 0;
        if (next.length > 1) {
          const dx = cur % W - prev % W, dy = Math.floor(cur / W) - Math.floor(prev / W);
          pick = next.findIndex(k => { const ex = k % W - cur % W, ey = Math.floor(k / W) - Math.floor(cur / W); return dx * ey - dy * ex > 0; });
          if (pick < 0) pick = 0;
        }
        prev = cur;
        cur = next.splice(pick, 1)[0];
      }
      // Punkte auf geraden Strecken weglassen
      const p = pts.map(k => ({ x: k % W, y: Math.floor(k / W) }));
      const simple = p.filter((q, i) => {
        const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length];
        return (q.x - a.x) * (b.y - q.y) - (q.y - a.y) * (b.x - q.x) !== 0;
      });
      loops.push(simple);
    }
  }
  return loops;
}
