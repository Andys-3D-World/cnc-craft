/**
 * EINRICHTEBLATT: Rechnung und HTML (ohne Abhängigkeiten, Tests: `npm test`)
 *
 * Alle Namen (Werkzeuge, Dateien, Kommentare aus dem G-Code) gehen durch esc().
 * Das HTML braucht kein Skript und keine Datei von außen: läuft im App-Fenster und als gespeicherte Datei.
 */

export const esc = (s: unknown) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface SheetOp { label: string; depth: number | null; feed: number | null; line: number }
export interface SheetChange { line: number; code: string; note: string }

/** Bearbeitungen und Werkzeugwechsel aus dem G-Code lesen */
export function summarizeJob(lines: string[]): { ops: SheetOp[]; changes: SheetChange[] } {
  const ops: SheetOp[] = [];
  const changes: SheetChange[] = [];
  let cur: SheetOp | null = null, motion = 0, feed: number | null = null, k = 1;
  const WORD = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
  lines.forEach((raw, i) => {
    const trimmed = raw.trim();
    const mark = trimmed.match(/^\(-{2,}\s*(.*?)\s*-*\)$/);
    if (mark) { cur = { label: mark[1], depth: null, feed: null, line: i }; ops.push(cur); return; }
    const note = (trimmed.match(/\(([^)]*)\)/) || [])[1] || "";
    const code = trimmed.replace(/\([^)]*\)/g, "").replace(/;.*$/, "").toUpperCase().trim();
    if (!code || code[0] === "$") return;
    let z: number | undefined, xy = false, m: RegExpExecArray | null;
    WORD.lastIndex = 0;
    while ((m = WORD.exec(code)) !== null) {
      const v = parseFloat(m[2]);
      if (m[1] === "G") {
        if (v === 0 || v === 1 || v === 2 || v === 3) motion = v;
        else if (v === 20) k = 25.4;
        else if (v === 21) k = 1;
      } else if (m[1] === "F") feed = v * k;
      else if (m[1] === "Z") z = v * k;
      else if (m[1] === "X" || m[1] === "Y") xy = true;
      else if (m[1] === "M" && (v === 6 || v === 0 || v === 1)) changes.push({ line: i, code: `M${v}`, note });
    }
    if (motion === 0) return;
    if (!cur) { cur = { label: "", depth: null, feed: null, line: i }; ops.push(cur); }
    const c: SheetOp = cur;
    if (z !== undefined && (c.depth === null || z < c.depth)) c.depth = z;
    if (xy && feed !== null && (c.feed === null || feed > c.feed)) c.feed = feed;
  });
  return { ops: ops.filter(o => o.depth !== null || o.feed !== null), changes };
}

export type ZeroWhere = "bl" | "br" | "tl" | "tr" | "center" | "other";

/** Wo liegt X0 Y0 am Teil? tol: so viel mm Abweichung zählt noch als Ecke/Mitte */
export function zeroPosition(b: { minX: number; minY: number; maxX: number; maxY: number }, tol = 2): ZeroWhere {
  const atX = (v: number) => Math.abs(v) <= tol;
  if (atX((b.minX + b.maxX) / 2) && atX((b.minY + b.maxY) / 2)) return "center";
  if (atX(b.minX) && atX(b.minY)) return "bl";
  if (atX(b.maxX) && atX(b.minY)) return "br";
  if (atX(b.minX) && atX(b.maxY)) return "tl";
  if (atX(b.maxX) && atX(b.maxY)) return "tr";
  return "other";
}

/** Bild der Schnitte als SVG (y nach oben; Anzahl Strecken begrenzt, damit die Seite klein bleibt) */
export function jobSvg(
  moves: { n: number; x0: ArrayLike<number>; y0: ArrayLike<number>; x1: ArrayLike<number>; y1: ArrayLike<number>; cut: (i: number) => boolean },
  zones: { pts: { x: number; y: number }[] }[] = [],
  maxSegs = 6000
): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (let i = 0; i < moves.n; i++) {
    if (!moves.cut(i)) continue;
    count++;
    minX = Math.min(minX, moves.x0[i], moves.x1[i]); maxX = Math.max(maxX, moves.x0[i], moves.x1[i]);
    minY = Math.min(minY, moves.y0[i], moves.y1[i]); maxY = Math.max(maxY, moves.y0[i], moves.y1[i]);
  }
  for (const z of zones) for (const p of z.pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  if (minX === Infinity) return "";
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1), pad = Math.max(w, h) * 0.03;
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const Y = (y: number) => maxY - y;
  const step = Math.max(1, Math.ceil(count / maxSegs));
  let d = "", k = 0;
  for (let i = 0; i < moves.n; i++) {
    if (!moves.cut(i)) continue;
    if (k++ % step) continue;
    d += `M${n(moves.x0[i])} ${n(Y(moves.y0[i]))}L${n(moves.x1[i])} ${n(Y(moves.y1[i]))}`;
  }
  const zp = zones.map(z => `<polygon points="${z.pts.map(p => `${n(p.x)},${n(Y(p.y))}`).join(" ")}" fill="rgba(220,40,40,.15)" stroke="#c22" stroke-dasharray="${n(Math.max(w, h) / 60)}" stroke-width="${n(Math.max(w, h) / 400)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX - pad)} ${n(-pad)} ${n(w + 2 * pad)} ${n(h + 2 * pad)}" role="img">`
    + `${zp}<path d="${d}" fill="none" stroke="#111" stroke-width="${n(Math.max(w, h) / 500)}" stroke-linejoin="round"/></svg>`;
}

export interface SheetTool { no: string; name: string; dia: string; type: string; len: string }
export interface SheetData {
  title: string; date: string;
  tools: SheetTool[]; toolsNote: string;
  stock: string; partSize: string;
  time: string; timeBasis: string;
  zero: string; zeroZ: string; wcs: string;
  ops: SheetOp[]; changes: SheetChange[];
  warnings: string[]; zones: string[];
  svg: string;
}

type Tr = (k: string, p?: Record<string, string | number>) => string;

export function sheetHtml(d: SheetData, t: Tr): string {
  const num = (v: number | null, dec = 2) => (v === null ? "–" : v.toFixed(dec));
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const tools = d.tools.length
    ? `<table><thead><tr><th>${esc(t("sheet.toolNo"))}</th><th>${esc(t("sheet.toolName"))}</th><th>Ø</th><th>${esc(t("sheet.toolType"))}</th><th>${esc(t("sheet.toolLen"))}</th></tr></thead><tbody>`
      + d.tools.map(x => `<tr><td>${esc(x.no)}</td><td>${esc(x.name)}</td><td>${esc(x.dia)}</td><td>${esc(x.type)}</td><td>${esc(x.len)}</td></tr>`).join("") + `</tbody></table>`
    : `<p>${esc(d.toolsNote)}</p>`;
  const ops = d.ops.length
    ? `<table><thead><tr><th>#</th><th>${esc(t("sheet.opName"))}</th><th>${esc(t("sheet.opDepth"))}</th><th>${esc(t("sheet.opFeed"))}</th></tr></thead><tbody>`
      + d.ops.map((o, i) => `<tr><td>${i + 1}</td><td>${esc(o.label || t("sheet.wholeJob"))}</td><td>${num(o.depth)}</td><td>${num(o.feed, 0)}</td></tr>`).join("") + `</tbody></table>`
    : `<p>–</p>`;
  const list = (a: string[]) => `<ul>${a.map(s => `<li>${esc(s)}</li>`).join("")}</ul>`;
  return `<h1>${esc(d.title)}</h1><p class="sub">${esc(d.date)}</p>
<div class="two"><div><h2>${esc(t("sheet.setup"))}</h2><table>${
    row(t("sheet.stock"), d.stock) + row(t("sheet.part"), d.partSize) + row(t("sheet.zero"), d.zero) + row(t("sheet.zeroZ"), d.zeroZ)
    + row(t("sheet.wcs"), d.wcs) + row(t("sheet.time"), d.time) + row(t("sheet.timeBasis"), d.timeBasis)
  }</table></div>${d.svg ? `<div class="pic">${d.svg}</div>` : ""}</div>
<h2>${esc(t("sheet.tools"))}</h2>${tools}
<h2>${esc(t("sheet.ops"))}</h2>${ops}
${d.changes.length ? `<h2>${esc(t("sheet.changes"))}</h2>${list(d.changes.map(c => `${c.code}${c.note ? " – " + c.note : ""}`))}` : ""}
${d.zones.length ? `<h2>${esc(t("sheet.zones"))}</h2>${list(d.zones)}` : ""}
${d.warnings.length ? `<h2 class="warn">${esc(t("sheet.warnings"))}</h2>${list(d.warnings)}` : ""}`;
}

/** Aussehen der Seite – dieselben Regeln im Fenster und in der gespeicherten Datei */
export const SHEET_CSS = `
.setup-sheet{background:#fff;color:#111;font:13px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:18px 22px;max-width:190mm;margin:0 auto;}
.setup-sheet h1{font-size:20px;margin:0;color:#111;}
.setup-sheet h2{font-size:14px;margin:14px 0 4px;border-bottom:1px solid #999;color:#111;}
.setup-sheet h2.warn{color:#b00;}
.setup-sheet .sub{margin:0 0 6px;color:#555;}
.setup-sheet table{border-collapse:collapse;width:100%;}
.setup-sheet th,.setup-sheet td{border:1px solid #bbb;padding:2px 6px;text-align:left;vertical-align:top;color:#111;background:#fff;font-weight:normal;}
.setup-sheet thead th,.setup-sheet tbody th{background:#eee;}
.setup-sheet ul{margin:2px 0;padding-left:18px;}
.setup-sheet .two{display:flex;gap:12px;align-items:flex-start;}
.setup-sheet .two>div:first-child{flex:1;}
.setup-sheet .pic{width:45%;border:1px solid #bbb;padding:4px;}
.setup-sheet .pic svg{display:block;width:100%;height:auto;max-height:70mm;}
`;

export function sheetDocument(body: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${SHEET_CSS}</style></head><body><div class="setup-sheet">${body}</div></body></html>`;
}
