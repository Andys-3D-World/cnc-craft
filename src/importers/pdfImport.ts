/**
 * PDF- UND AI-IMPORT (Vektorgrafiken aus PDF, Adobe Illustrator ab CS mit PDF-Inhalt)
 *
 * Liest die Zeichenbefehle der Seiten: Linien, Bézierkurven, Rechtecke,
 * Transformationen (cm, q/Q). Text, Bilder und Schnittmasken werden übersprungen.
 * Mehrere Seiten landen übereinander.
 *
 * Das ist ein vereinfachter Leser: für die meisten Exporte aus Inkscape, Illustrator,
 * CorelDRAW, Affinity und CAD-Programmen reicht er. Wenn etwas fehlt: als SVG oder DXF exportieren.
 */
import { ImportResult, emptyResult, Mat, matMul, matApply, flattenCubic, CURVE_TOL, Pt } from "./common";
import { t } from "../i18n/i18n";

const PT_TO_MM = 25.4 / 72;

export async function parsePdf(bytes: Uint8Array): Promise<ImportResult> {
  const res = emptyResult();
  const latin = new TextDecoder("latin1").decode(bytes);
  if (!latin.startsWith("%PDF")) {
    if (latin.startsWith("%!PS")) throw new Error(t("pdf.errPostscript"));
    throw new Error(t("pdf.errNotPdf"));
  }

  // ---- Alle Streams finden ----
  const contents: string[] = [];
  let skippedFilters = 0;
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    const dictStart = latin.lastIndexOf("obj", m.index);
    const dict = dictStart >= 0 ? latin.slice(dictStart, m.index) : "";
    re.lastIndex = end + 9;

    // Nur Seiteninhalte: keine Bilder, Schriften, Farbprofile, Metadaten, Objekt-Streams
    if (/\/Subtype\s*\/|\/Length[123]\b|\/Type\s*\/(XRef|ObjStm|Metadata|XObject|EmbeddedFile)|\/FunctionType|\/ShadingType|\/PatternType|\/N\s+[134]\b/.test(dict)) continue;

    let data = bytes.subarray(start, end);
    // abschließendes Zeilenende abschneiden
    while (data.length && (data[data.length - 1] === 10 || data[data.length - 1] === 13)) data = data.subarray(0, data.length - 1);

    const filters = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] || "").match(/\/\w+/g) || [];
    let ok = true;
    for (const f of filters) {
      try {
        if (f === "/FlateDecode" || f === "/Fl") data = await inflate(data);
        else if (f === "/ASCII85Decode" || f === "/A85") data = ascii85(data);
        else if (f === "/ASCIIHexDecode" || f === "/AHx") data = asciiHex(data);
        else ok = false;
      } catch { ok = false; }
    }
    if (!ok) { skippedFilters++; continue; }
    const text = new TextDecoder("latin1").decode(data);
    if (/(^|\s)(re|m)\s/.test(text) && /(^|\s)[SsfFBb]\*?(\s|$)/.test(text)) contents.push(text);
  }

  let texts = 0;
  for (const c of contents) texts += runContent(c, res);

  if (!contents.length) throw new Error(t("pdf.errNoVectors"));
  if (texts) res.warnings.push(t("pdf.textSkipped"));
  if (skippedFilters) res.warnings.push(t("pdf.filterSkipped", { n: skippedFilters }));
  if (contents.length > 1) res.warnings.push(t("pdf.multiple", { n: contents.length }));
  res.info = t("pdf.info", { n: res.paths.length });
  return res;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (!DS) throw new Error(t("pdf.errInflate"));
  const ds = new DS("deflate");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function ascii85(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const s = new TextDecoder("latin1").decode(src).replace(/^<~/, "");
  for (const ch of s) {
    if (ch === "~") break;
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0);
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

function asciiHex(src: Uint8Array): Uint8Array {
  const s = new TextDecoder("latin1").decode(src).replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.ceil(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((s.substr(i * 2, 2) + "0").slice(0, 2), 16);
  return out;
}

/** Führt die PDF-Zeichenbefehle aus. Gibt die Anzahl übersprungener Textblöcke zurück. */
function runContent(src: string, res: ImportResult): number {
  const stack: Mat[] = [];
  let ctm: Mat = [PT_TO_MM, 0, 0, PT_TO_MM, 0, 0];
  let ops: (number | string)[] = [];
  let subpaths: { pts: Pt[]; closed: boolean }[] = [];
  let cur = null as Pt[] | null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let inText = false;
  let textBlocks = 0;

  const T = (x: number, y: number) => matApply(ctm, x, y);
  const startSub = (x: number, y: number) => {
    if (cur && cur.length >= 2) subpaths.push({ pts: cur, closed: false });
    cur = [T(x, y)];
    cx = sx = x; cy = sy = y;
  };
  const paint = (keep: boolean) => {
    if (cur && cur.length >= 2) subpaths.push({ pts: cur, closed: false });
    if (keep) for (const sp of subpaths) res.paths.push(sp);
    subpaths = [];
    cur = null;
  };
  const n = (k: number) => Number(ops[ops.length - k]);

  let i = 0;
  const L = src.length;
  while (i < L) {
    const ch = src[i];
    // Leerraum
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0") { i++; continue; }
    // Kommentar
    if (ch === "%") { while (i < L && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    // String (...)
    if (ch === "(") {
      let depth = 1; i++;
      while (i < L && depth > 0) {
        if (src[i] === "\\") i += 2;
        else { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; i++; }
      }
      ops.push("(str)"); continue;
    }
    // Hex-String oder Dictionary
    if (ch === "<") {
      if (src[i + 1] === "<") { let depth = 1; i += 2; while (i < L && depth) { if (src.startsWith("<<", i)) { depth++; i += 2; } else if (src.startsWith(">>", i)) { depth--; i += 2; } else i++; } ops.push("(dict)"); continue; }
      const e = src.indexOf(">", i); i = e < 0 ? L : e + 1; ops.push("(hex)"); continue;
    }
    if (ch === "[" || ch === "]") { i++; continue; }
    if (ch === "/") { let j = i + 1; while (j < L && !/[\s/[\]()<>{}%]/.test(src[j])) j++; ops.push(src.slice(i, j)); i = j; continue; }

    // Zahl oder Operator
    let j = i;
    while (j < L && !/[\s/[\]()<>{}%]/.test(src[j])) j++;
    const tok = src.slice(i, j);
    i = j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) { ops.push(parseFloat(tok)); continue; }

    // ---- Operator ----
    if (inText) {
      if (tok === "ET") inText = false;
      ops = [];
      continue;
    }
    switch (tok) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() || ctm; break;
      case "cm": ctm = matMul(ctm, [n(6), n(5), n(4), n(3), n(2), n(1)]); break;
      case "m": startSub(n(2), n(1)); break;
      case "l":
        if (!cur) startSub(cx, cy);
        cx = n(2); cy = n(1); cur!.push(T(cx, cy));
        break;
      case "c": case "v": case "y": {
        if (!cur) startSub(cx, cy);
        let p1: Pt, p2: Pt, p3: Pt;
        if (tok === "c") { p1 = { x: n(6), y: n(5) }; p2 = { x: n(4), y: n(3) }; p3 = { x: n(2), y: n(1) }; }
        else if (tok === "v") { p1 = { x: cx, y: cy }; p2 = { x: n(4), y: n(3) }; p3 = { x: n(2), y: n(1) }; }
        else { p1 = { x: n(4), y: n(3) }; p2 = { x: n(2), y: n(1) }; p3 = { ...p2 }; }
        const a = T(cx, cy), b = T(p1.x, p1.y), c = T(p2.x, p2.y), d = T(p3.x, p3.y);
        cur!.push(...flattenCubic(a, b, c, d, CURVE_TOL));
        cx = p3.x; cy = p3.y;
        break;
      }
      case "h":
        if (cur && cur.length >= 2) { subpaths.push({ pts: cur, closed: true }); }
        cur = null; cx = sx; cy = sy;
        break;
      case "re": {
        if (cur && cur.length >= 2) subpaths.push({ pts: cur, closed: false });
        const x = n(4), y = n(3), w = n(2), h = n(1);
        subpaths.push({ pts: [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)], closed: true });
        cur = null; cx = sx = x; cy = sy = y;
        break;
      }
      case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*":
        if ((tok === "s" || tok === "b" || tok === "b*") && cur && cur.length >= 2) { subpaths.push({ pts: cur, closed: true }); cur = null; }
        paint(true);
        break;
      case "n": paint(false); break; // Schnittmaske -> nicht übernehmen
      case "BT": inText = true; textBlocks++; break;
      case "BI": { const e = src.indexOf("EI", i); i = e < 0 ? L : e + 2; break; } // eingebettetes Bild
      default: break;
    }
    ops = [];
  }
  // Geschlossene Pfade: doppelten Endpunkt entfernen
  for (const p of res.paths) {
    if (p.closed && p.pts.length > 2) {
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) p.pts.pop();
    }
  }
  return textBlocks;
}

