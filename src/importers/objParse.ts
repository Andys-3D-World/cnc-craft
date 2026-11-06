/**
 * OBJ-LESER (Wavefront): nur Eckpunkte (v) und Flächen (f). Materialien, Texturen, Normalen und Gruppen werden übergangen.
 * Vielecke werden zu Dreiecken aufgefächert; negative Nummern zählen von hinten.
 * Arbeitet direkt auf den Bytes (kein riesiger Text im Speicher). Kaputte oder zu große Dateien: ObjError statt Absturz.
 */
import { numAt } from "./meshScan.ts";

/** Grenzen: mehr Dreiecke sind für einen Fräs-Job sinnlos und füllen nur den Speicher */
export const OBJ_MAX_TRIANGLES = 5_000_000;
export const OBJ_MAX_VERTICES = 20_000_000;
export const OBJ_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_COORD = 1e9;

export type ObjErrorCode = "tooBigFile" | "tooMany" | "badNumber" | "badIndex" | "noVertices" | "noFaces";

export class ObjError extends Error {
  code: ObjErrorCode;
  line: number;
  constructor(code: ObjErrorCode, line = 0) { super(`OBJ ${code} (line ${line})`); this.code = code; this.line = line; }
}

export interface ObjMesh { positions: Float32Array; triangles: number; vertices: number; skipped: number }

const isSpace = (c: number) => c === 32 || c === 9 || c === 13;

export function parseObjBytes(b: Uint8Array): ObjMesh {
  if (b.length > OBJ_MAX_BYTES) throw new ObjError("tooBigFile");
  let verts = new Float64Array(3 * 4096), nv = 0;
  let tris = new Uint32Array(3 * 4096), nt = 0;
  let line = 0, skipped = 0, maxRef = -1, maxRefLine = 0;
  const n = b.length;
  const face: number[] = [];
  let i = 0;
  while (i < n) {
    line++;
    let start = i, end = i;
    // Zeilenende; "\" am Ende verbindet mit der nächsten Zeile
    for (;;) {
      while (end < n && b[end] !== 10) end++;
      let e = end;
      while (e > start && isSpace(b[e - 1])) e--;
      if (end < n && e > start && b[e - 1] === 92) { end++; line++; continue; }
      break;
    }
    i = end + 1;
    while (start < end && isSpace(b[start])) start++;
    if (start >= end) continue;
    const c0 = b[start], c1 = start + 1 < end ? b[start + 1] : 32;
    if (!(isSpace(c1) || c1 === 92)) continue;          // vn, vt, usemtl, mtllib, o, g, s …
    if (c0 === 118 /* v */) {
      if (nv + 3 > verts.length) {
        if (nv / 3 >= OBJ_MAX_VERTICES) throw new ObjError("tooMany", line);
        const g = new Float64Array(verts.length * 2); g.set(verts); verts = g;
      }
      let p = start + 1;
      for (let a = 0; a < 3; a++) {
        while (p < end && (isSpace(b[p]) || b[p] === 92 || b[p] === 10)) p++;
        const t0 = p;
        while (p < end && !isSpace(b[p]) && b[p] !== 92 && b[p] !== 10) p++;
        const v = t0 < p ? numAt(b, t0, p) : NaN;
        if (!Number.isFinite(v) || Math.abs(v) > MAX_COORD) throw new ObjError("badNumber", line);
        verts[nv + a] = v;
      }
      nv += 3;
    } else if (c0 === 102 /* f */) {
      face.length = 0;
      let p = start + 1;
      while (p < end) {
        while (p < end && (isSpace(b[p]) || b[p] === 92 || b[p] === 10)) p++;
        if (p >= end) break;
        // Nummer vor dem ersten "/"
        let neg = false, v = 0, digits = 0;
        if (b[p] === 45) { neg = true; p++; } else if (b[p] === 43) p++;
        while (p < end && b[p] >= 48 && b[p] <= 57) { v = v * 10 + (b[p] - 48); digits++; p++; }
        if (!digits || v === 0 || v > 4294967295) throw new ObjError("badIndex", line);
        if (p < end && !isSpace(b[p]) && b[p] !== 47 && b[p] !== 92 && b[p] !== 10) throw new ObjError("badIndex", line);
        while (p < end && !isSpace(b[p]) && b[p] !== 92 && b[p] !== 10) p++;   // /vt/vn übergehen
        const idx = neg ? nv / 3 - v : v - 1;
        if (idx < 0) throw new ObjError("badIndex", line);
        if (idx > maxRef) { maxRef = idx; maxRefLine = line; }
        face.push(idx);
      }
      if (face.length < 3) { skipped++; continue; }
      for (let k = 1; k + 1 < face.length; k++) {
        const a = face[0], q = face[k], r = face[k + 1];
        if (a === q || q === r || a === r) { skipped++; continue; }
        if (nt / 3 >= OBJ_MAX_TRIANGLES) throw new ObjError("tooMany", line);
        if (nt + 3 > tris.length) { const g = new Uint32Array(tris.length * 2); g.set(tris); tris = g; }
        tris[nt++] = a; tris[nt++] = q; tris[nt++] = r;
      }
    }
  }
  const vertices = nv / 3;
  if (!vertices) throw new ObjError("noVertices");
  if (!nt) throw new ObjError("noFaces");
  if (maxRef >= vertices) throw new ObjError("badIndex", maxRefLine);
  const positions = new Float32Array(nt * 3);
  for (let k = 0; k < nt; k++) {
    const q = tris[k] * 3;
    positions[k * 3] = verts[q]; positions[k * 3 + 1] = verts[q + 1]; positions[k * 3 + 2] = verts[q + 2];
  }
  return { positions, triangles: nt / 3, vertices, skipped };
}
