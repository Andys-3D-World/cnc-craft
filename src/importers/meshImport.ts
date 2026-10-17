/**
 * 3D-MODELLE: 3MF und STEP (zusätzlich zu STL)
 *
 * Beide Formate werden in dieselbe Dreiecksliste umgewandelt wie STL (StlMesh) und laufen
 * danach durch den bekannten Dialog (Ansicht wählen, Schnitthöhe, als 2D-Konturen einfügen).
 *
 * 3MF  – ZIP-Archiv mit XML (3D/3dmodel.model). Eigener ZIP-Leser + Entpacker (Deflate, RFC 1951),
 *        damit es auch auf älteren Systemen ohne DecompressionStream läuft.
 *        Unterstützt: mehrere Objekte, Bauteile (components), Transformationen, Einheiten,
 *        Objekte in eigenen Dateien (Production-Erweiterung von Bambu Studio / PrusaSlicer).
 * STEP – exakte CAD-Geometrie (B-Rep). Umrechnung in Dreiecke mit OpenCascade als WebAssembly
 *        (occt-import-js, LGPL-2.1, Dateien in public/occt/). Läuft in einem eigenen Thread
 *        (Web Worker), damit das Fenster nicht einfriert; wird erst beim ersten STEP geladen.
 */
import { StlMesh, meshFromPositions } from "../stlLoader";
import { t } from "../i18n/i18n";

// =====================================================================
// Deflate entpacken (RFC 1951) – nach dem bewährten „puff“-Verfahren
// =====================================================================

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { count: Uint16Array; symbol: Uint16Array }

function buildHuff(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

let FIXED: { l: Huff; d: Huff } | null = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { l: buildHuff(l, 288), d: buildHuff(d, 30) };
  return FIXED;
}

/** Roh-Deflate entpacken. size = erwartete Größe (aus dem ZIP), wenn bekannt */
export function inflateRaw(src: Uint8Array, size = 0): Uint8Array {
  let out = new Uint8Array(size > 0 ? size : Math.max(1024, src.length * 4));
  let op = 0, ip = 0, bitBuf = 0, bitCnt = 0;
  const need = (n: number) => {
    if (op + n <= out.length) return;
    let len = out.length * 2;
    while (len < op + n) len *= 2;
    const o2 = new Uint8Array(len); o2.set(out.subarray(0, op)); out = o2;
  };
  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (ip >= src.length) throw new Error("inflate: unexpected end");
      bitBuf |= src[ip++] << bitCnt; bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n; bitCnt -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - first < c) return h.symbol[index + code - first];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("inflate: bad code");
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;                       // auf Byte-Grenze
      if (ip + 4 > src.length) throw new Error("inflate: unexpected end");
      const len = src[ip] | (src[ip + 1] << 8);
      ip += 4;
      if (ip + len > src.length) throw new Error("inflate: unexpected end");
      need(len); out.set(src.subarray(ip, ip + len), op); op += len; ip += len;
      continue;
    }
    let lt: Huff, dt: Huff;
    if (type === 1) ({ l: lt, d: dt } = fixedTables());
    else if (type === 2) {
      const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i]] = bits(3);
      const ch = buildHuff(lengths, 19);
      const ll = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(ch);
        if (sym < 16) { ll[i++] = sym; continue; }
        let rep = 0, val = 0;
        if (sym === 16) { if (!i) throw new Error("inflate: bad repeat"); val = ll[i - 1]; rep = 3 + bits(2); }
        else if (sym === 17) rep = 3 + bits(3);
        else rep = 11 + bits(7);
        if (i + rep > nlen + ndist) throw new Error("inflate: bad lengths");
        while (rep--) ll[i++] = val;
      }
      lt = buildHuff(ll.subarray(0, nlen), nlen);
      dt = buildHuff(ll.subarray(nlen), ndist);
    } else throw new Error("inflate: bad block type");
    for (;;) {
      const sym = decode(lt);
      if (sym < 256) { need(1); out[op++] = sym; continue; }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= 29) throw new Error("inflate: bad length");
      const len = LBASE[li] + bits(LEXT[li]);
      const di = decode(dt);
      if (di >= 30) throw new Error("inflate: bad distance");
      const dist = DBASE[di] + bits(DEXT[di]);
      if (dist > op) throw new Error("inflate: distance too far");
      need(len);
      for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
    }
  }
  return op === out.length ? out : out.slice(0, op);
}

/** Entpacken: wenn vorhanden mit dem eingebauten DecompressionStream (schneller), sonst selbst */
async function inflateAuto(data: Uint8Array, size: number): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (DS) {
    try {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* ältere WebViews: "deflate-raw" fehlt -> eigener Entpacker */ }
  }
  return inflateRaw(data, size);
}

// =====================================================================
// ZIP lesen
// =====================================================================

export interface ZipEntry { name: string; method: number; compSize: number; size: number; offset: number }

export function readZipDirectory(z: Uint8Array): ZipEntry[] {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  // „End of central directory“ von hinten suchen
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(t("m3d.errZip"));
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder("utf-8");
  const list: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= z.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(z.subarray(p + 46, p + 46 + nameLen));
    list.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + commLen;
  }
  return list;
}

export async function readZipEntry(z: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error(t("m3d.errZip"));
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = z.subarray(start, start + e.compSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateAuto(data, e.size);
  throw new Error(t("m3d.errZipMethod", { m: e.method }));
}

// =====================================================================
// 3MF
// =====================================================================

const UNITS: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
type M = number[]; // 3×4 Zeilen-Matrix: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
const IDENT: M = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMatrix(s: string | null): M {
  if (!s) return IDENT;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENT;
}
/** erst a, dann b anwenden (3MF: Punkt als Zeilenvektor, p' = p · M) */
function compose(a: M, b: M): M {
  const r: M = new Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  for (let j = 0; j < 3; j++) r[9 + j] = a[9] * b[j] + a[10] * b[3 + j] + a[11] * b[6 + j] + b[9 + j];
  return r;
}

interface Obj3 { verts: Float64Array | null; tris: Uint32Array | null; comps: { id: string; path: string | null; m: M }[] }

function parseModelXml(xml: string): { unit: number; objects: Map<string, Obj3>; build: { id: string; path: string | null; m: M }[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(t("m3d.err3mf"));
  const model = doc.getElementsByTagNameNS("*", "model")[0];
  const unit = UNITS[(model?.getAttribute("unit") || "millimeter").toLowerCase()] ?? 1;
  const pathOf = (el: Element) => el.getAttributeNS(NS_PROD, "path") || el.getAttribute("p:path");
  const objects = new Map<string, Obj3>();
  for (const o of Array.from(doc.getElementsByTagNameNS("*", "object"))) {
    const id = o.getAttribute("id") || "";
    const obj: Obj3 = { verts: null, tris: null, comps: [] };
    const mesh = o.getElementsByTagNameNS("*", "mesh")[0];
    if (mesh) {
      const vs = mesh.getElementsByTagNameNS("*", "vertex");
      const verts = new Float64Array(vs.length * 3);
      for (let i = 0; i < vs.length; i++) {
        verts[i * 3] = +(vs[i].getAttribute("x") || 0);
        verts[i * 3 + 1] = +(vs[i].getAttribute("y") || 0);
        verts[i * 3 + 2] = +(vs[i].getAttribute("z") || 0);
      }
      const ts = mesh.getElementsByTagNameNS("*", "triangle");
      const tris = new Uint32Array(ts.length * 3);
      for (let i = 0; i < ts.length; i++) {
        tris[i * 3] = +(ts[i].getAttribute("v1") || 0);
        tris[i * 3 + 1] = +(ts[i].getAttribute("v2") || 0);
        tris[i * 3 + 2] = +(ts[i].getAttribute("v3") || 0);
      }
      obj.verts = verts; obj.tris = tris;
    }
    for (const c of Array.from(o.getElementsByTagNameNS("*", "component"))) {
      obj.comps.push({ id: c.getAttribute("objectid") || "", path: pathOf(c), m: parseMatrix(c.getAttribute("transform")) });
    }
    objects.set(id, obj);
  }
  const build = Array.from(doc.getElementsByTagNameNS("*", "item")).map(it => ({
    id: it.getAttribute("objectid") || "", path: pathOf(it), m: parseMatrix(it.getAttribute("transform"))
  }));
  return { unit, objects, build };
}

export async function parse3mf(bytes: Uint8Array): Promise<StlMesh> {
  const entries = readZipDirectory(bytes);
  const norm = (n: string) => n.replace(/^\/+/, "").toLowerCase();
  const byName = new Map(entries.map(e => [norm(e.name), e]));
  const text = async (name: string) => {
    const e = byName.get(norm(name));
    if (!e) throw new Error(t("m3d.err3mfPart", { p: name }));
    return new TextDecoder("utf-8").decode(await readZipEntry(bytes, e));
  };
  // Hauptmodell über _rels/.rels finden, sonst die erste .model-Datei
  let root = "";
  try {
    const rels = await text("_rels/.rels");
    const m = rels.match(/<Relationship[^>]*Type="[^"]*3dmodel"[^>]*>/i);
    const tg = m && m[0].match(/Target="([^"]+)"/i);
    if (tg) root = tg[1];
  } catch { /* egal */ }
  if (!root || !byName.has(norm(root))) root = entries.find(e => /\.model$/i.test(e.name))?.name || "";
  if (!root) throw new Error(t("m3d.err3mf"));

  const files = new Map<string, ReturnType<typeof parseModelXml>>();
  const load = async (path: string) => {
    const k = norm(path);
    if (!files.has(k)) files.set(k, parseModelXml(await text(path)));
    return files.get(k)!;
  };
  const main = await load(root);
  const scale = main.unit;

  const out: number[] = [];
  let guard = 0;
  const emit = async (path: string, id: string, m: M, depth: number) => {
    if (depth > 32 || ++guard > 200000) return;
    const file = await load(path);
    const o = file.objects.get(id);
    if (!o) return;
    if (o.verts && o.tris) {
      const v = o.verts, tr = o.tris;
      for (let i = 0; i < tr.length; i++) {
        const k = tr[i] * 3;
        if (k + 2 >= v.length) continue;
        const x = v[k], y = v[k + 1], z = v[k + 2];
        out.push((x * m[0] + y * m[3] + z * m[6] + m[9]) * scale,
                 (x * m[1] + y * m[4] + z * m[7] + m[10]) * scale,
                 (x * m[2] + y * m[5] + z * m[8] + m[11]) * scale);
      }
    }
    for (const c of o.comps) await emit(c.path || path, c.id, compose(c.m, m), depth + 1);
  };
  if (main.build.length) for (const it of main.build) await emit(it.path || root, it.id, it.m, 0);
  else for (const [id, o] of main.objects) if (o.verts) await emit(root, id, IDENT, 0);
  const usable = out.length - (out.length % 9);
  if (!usable) throw new Error(t("stl.errNoTriangles"));
  return meshFromPositions(new Float32Array(out.slice(0, usable)), "3mf");
}

// =====================================================================
// STEP (OpenCascade als WebAssembly)
// =====================================================================

const OCCT_DIR = "/occt/";
/** Feinheit der Dreiecke: Bruchteil der Modellgröße und Winkel (rad) */
export const STEP_PARAMS = { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.0005, angularDeflection: 0.1 };

let worker: Worker | null = null;

function runInWorker(bytes: Uint8Array): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    try {
      if (!worker) worker = new Worker(OCCT_DIR + "cnc-step-worker.js");
    } catch (e) { reject(e); return; }
    const w = worker;
    const done = () => { w.onmessage = null; w.onerror = null; };
    w.onmessage = (ev: MessageEvent) => {
      done();
      if (ev.data && ev.data.ok) resolve(ev.data.positions as Float32Array);
      else reject(new Error(ev.data?.error === "read" ? t("m3d.errStep") : String(ev.data?.error || "STEP")));
    };
    w.onerror = (ev) => { done(); worker?.terminate(); worker = null; reject(new Error(ev.message || "worker")); };
    const copy = bytes.slice();
    w.postMessage({ buffer: copy, params: STEP_PARAMS }, [copy.buffer]);
  });
}

/** Ausweg, falls Web Worker nicht gehen: OpenCascade im Hauptfenster laden */
let occtMain: Promise<any> | null = null;
function loadOcctMain(): Promise<any> {
  if (occtMain) return occtMain;
  occtMain = new Promise((resolve, reject) => {
    const go = () => (window as any).occtimportjs({ locateFile: (p: string) => OCCT_DIR + p }).then(resolve, reject);
    if ((window as any).occtimportjs) { go(); return; }
    const s = document.createElement("script");
    s.src = OCCT_DIR + "occt-import-js.js";
    s.onload = go;
    s.onerror = () => { occtMain = null; reject(new Error(t("m3d.errOcct"))); };
    document.head.appendChild(s);
  });
  return occtMain;
}

function flatten(result: any): Float32Array {
  if (!result || !result.success) throw new Error(t("m3d.errStep"));
  let total = 0;
  for (const m of result.meshes) total += m.index.array.length;
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const m of result.meshes) {
    const P = m.attributes.position.array, I = m.index.array;
    for (let i = 0; i < I.length; i++) { const k = I[i] * 3; pos[o++] = P[k]; pos[o++] = P[k + 1]; pos[o++] = P[k + 2]; }
  }
  return pos;
}

export async function parseStep(bytes: Uint8Array): Promise<StlMesh> {
  let positions: Float32Array;
  try {
    positions = await runInWorker(bytes);
  } catch (e) {
    // Datei kaputt -> Fehler zeigen; Worker-Problem -> im Hauptfenster versuchen
    if (e instanceof Error && e.message === t("m3d.errStep")) throw e;
    const occt = await loadOcctMain();
    positions = flatten(occt.ReadStepFile(bytes, STEP_PARAMS));
  }
  // leere Datei: meist eine Baugruppe, deren Teile in eigenen STEP-Dateien liegen
  if (!positions.length) throw new Error(t("m3d.errStepEmpty"));
  return meshFromPositions(positions, "step");
}

/** Alle 3D-Formate */
export const MODEL_EXTENSIONS = ["stl", "3mf", "step", "stp"];
