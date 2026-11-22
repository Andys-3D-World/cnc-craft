/**
 * SAME PATH? Reads a posted file back with the simulation's G-code reader and compares it with the neutral program.
 * The reader knows nothing about the post-processor, so a mistake in the translation (wrong unit, lost move, G0
 * instead of G1, arc turned the other way) shows up here. Used before a posted file is saved and in the tests.
 *
 * Compared are: every corner of the path and the middle of every move (with its kind: rapid, cut, travel), in order,
 * within `tol` mm, in both directions; every feed (F) and every spindle speed (S), word by word; the unit of the file.
 * Not compared: waiting times, comments, tool numbers.
 */
import { parseGcodeProgram, type SimProgram } from "../sim/gcodeParser.ts";

export interface PathCheck {
  ok: boolean;
  /** what differs: "" = nothing */
  why: "" | "path" | "feed" | "speed" | "unit";
  /** largest distance between the two paths (mm) */
  maxDev: number;
  /** line (1-based) of the first difference – in the neutral program, or in the posted file when `inPosted` */
  line: number;
  inPosted: boolean;
}

/** arcs are cut into pieces for the comparison: finer than the simulation needs */
const ARC_TOL = 0.002;

interface Follow { ok: boolean; dev: number; line: number }

/** every point of A (corners, middles with the kind of move) must lie on B, in the same order */
function follow(A: SimProgram, B: SimProgram, tol: number): Follow {
  let j = 0, tj = 0, dev = 0;
  const tol2 = tol * tol;
  let nearT = 0;
  /** squared distance from the point to move k of B, not before `lo` on that move; the place is left in nearT */
  const near = (k: number, lo: number, px: number, py: number, pz: number): number => {
    const ax = B.x0[k], ay = B.y0[k], az = B.z0[k];
    const dx = B.x1[k] - ax, dy = B.y1[k] - ay, dz = B.z1[k] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    const t = Math.max(lo, Math.min(1, l2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0));
    const qx = ax + dx * t - px, qy = ay + dy * t - py, qz = az + dz * t - pz;
    nearT = t;
    return qx * qx + qy * qy + qz * qz;
  };
  const match = (px: number, py: number, pz: number, kind: number): boolean => {
    for (let k = j; k < B.n; k++) {
      if (kind >= 0 && B.type[k] !== kind) continue;
      let d2 = near(k, k === j ? tj : 0, px, py, pz);
      if (d2 > tol2) continue;
      // The first move close enough is taken (going further could skip the partner of the next point where the path
      // doubles back). For the reported distance look a few moves ahead: with very short moves the true partner
      // is often one of the next ones.
      const t = nearT;
      for (let m = k + 1; m < B.n && m <= k + 16 && d2 > 0; m++) {
        if (kind >= 0 && B.type[m] !== kind) break;
        const n2 = near(m, 0, px, py, pz);
        if (n2 < d2) d2 = n2;
      }
      j = k; tj = t;
      if (d2 > dev) dev = d2;
      return true;
    }
    return false;
  };
  if (A.n && !B.n) return { ok: false, dev: 0, line: A.line[0] + 1 };
  for (let i = 0; i < A.n; i++) {
    const x0 = A.x0[i], y0 = A.y0[i], z0 = A.z0[i], x1 = A.x1[i], y1 = A.y1[i], z1 = A.z1[i];
    if (i === 0 && !match(x0, y0, z0, -1)) return { ok: false, dev: Math.sqrt(dev), line: A.line[i] + 1 };
    const long = Math.hypot(x1 - x0, y1 - y0, z1 - z0) > 4 * tol;
    if (long && !match((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, A.type[i])) return { ok: false, dev: Math.sqrt(dev), line: A.line[i] + 1 };
    if (!match(x1, y1, z1, -1)) return { ok: false, dev: Math.sqrt(dev), line: A.line[i] + 1 };
  }
  return { ok: true, dev: Math.sqrt(dev), line: 0 };
}

interface Words { f: number[]; fLine: number[]; s: number[]; sLine: number[]; inch: boolean | null }

/** F and S words in order (outside comments), F in mm/min; the unit is the first G20/G21 of the file */
function feedsAndSpeeds(code: string): Words {
  const w: Words = { f: [], fLine: [], s: [], sLine: [], inch: null };
  const lines = code.split(/\r?\n/);
  let inch = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw[0] === "%") continue;
    const text = raw.replace(/\([^)]*\)/g, " ").replace(/;.*$/, "").toUpperCase();
    const re = /([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
    let m: RegExpExecArray | null, f: number | null = null, s: number | null = null;
    while ((m = re.exec(text))) {
      const v = parseFloat(m[2]);
      if (m[1] === "G" && (v === 20 || v === 21)) { inch = v === 20; if (w.inch === null) w.inch = inch; }
      else if (m[1] === "F") f = v;
      else if (m[1] === "S") s = v;
    }
    if (f !== null) { w.f.push(inch ? f * 25.4 : f); w.fLine.push(i + 1); }
    if (s !== null) { w.s.push(s); w.sLine.push(i + 1); }
  }
  return w;
}

/**
 * @param inch  unit the posted file is meant to have
 * @param tol   mm – 0.02 is far below anything a router can show and far above rounding to 4 decimals of an inch
 */
export function samePath(neutral: string, posted: string, inch: boolean, tol = 0.02): PathCheck {
  const bad = (why: PathCheck["why"], line: number, inPosted: boolean, maxDev = 0): PathCheck => ({ ok: false, why, maxDev, line, inPosted });
  const a = feedsAndSpeeds(neutral), b = feedsAndSpeeds(posted);
  if (b.inch !== inch) return bad("unit", 1, true);
  if (a.f.length !== b.f.length) return bad("feed", b.fLine[Math.min(a.f.length, b.f.length)] ?? 1, true);
  for (let i = 0; i < a.f.length; i++) {
    // 2 decimals of an inch per minute = 0.13 mm/min
    if (Math.abs(a.f[i] - b.f[i]) > 0.2 + a.f[i] * 0.001) return bad("feed", b.fLine[i], true);
  }
  if (a.s.length !== b.s.length) return bad("speed", b.sLine[Math.min(a.s.length, b.s.length)] ?? 1, true);
  for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return bad("speed", b.sLine[i], true);

  const A = parseGcodeProgram(neutral.split(/\r?\n/), { arcTol: ARC_TOL });
  const B = parseGcodeProgram(posted.split(/\r?\n/), { arcTol: ARC_TOL });
  const ab = follow(A, B, tol);
  if (!ab.ok) return bad("path", ab.line, false, ab.dev);
  const ba = follow(B, A, tol);
  if (!ba.ok) return bad("path", ba.line, true, ba.dev);
  return { ok: true, why: "", maxDev: Math.max(ab.dev, ba.dev), line: 0, inPosted: false };
}
