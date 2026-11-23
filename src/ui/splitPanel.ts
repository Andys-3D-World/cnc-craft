/**
 * GROSSES TEIL TEILEN – Bedienung (Geometrie: seamSplit.ts, Betten und Werkzeuge: splitJob.ts)
 *
 *  - Fenster neben der Zeichenfläche: gleichmäßig/passend teilen, Fugen-Liste, Einstellungen der gewählten Fuge,
 *    Stücke mit Größe (rot = passt nicht aufs Bett), Hinweise
 *  - Zeichenfläche: Fugen mit ihrer Verbindung, Stücke eingefärbt und beschriftet; Fugen lassen sich ziehen
 *  - ohne offenes Fenster zeigt das Original-Bett seine Fugen als gestrichelte Linien mit den Stück-Namen
 *
 * Hier wird nichts an die Maschine geschickt. Es stehen nur eigene Texte und Zahlen im HTML.
 */
import { t } from "../i18n/i18n";
import { app, bedSizeMm } from "../editor/editorState";
import { activeBed, bedName, bedPiece, bedSplit, pieceBeds, setBedSplit, splitSource, switchBed, twoSidedOn } from "../editor/beds";
import { MM_TO_PIXEL, groupBounds, newId } from "../shapeTransform";
import { fmtLenShort, fmtLenU, unitName } from "../units";
import { openToolPanel, rowCss, checkCss, type ToolPanel } from "./toolPanel";
import {
  cloneSplit, defaultSeam, fitGrid, gridSeams, pieceName, cleanSeam, MAX_SEAMS, SEAM_JOINTS,
  type Issue, type Seam, type SeamAxis, type SplitResult, type SplitSetup,
} from "../seamSplit";
import { computeSplit, makePieces, splitBlocked, splitOptions } from "../splitJob";

let redraw = () => {};
let log: (s: string) => void = () => {};

let panel: ToolPanel | null = null;
let draft: SplitSetup | null = null;
let draftBed = -1;
let sel = 0;
let res: SplitResult | null = null;
let drag = -1;
/** erst wenn die Felder gefüllt sind, darf aus ihnen gelesen werden (das Fenster meldet schon beim Öffnen eine Änderung) */
let ready = false;

const KEY = "cnc_craft_seam";
const K = MM_TO_PIXEL;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Vorlage für neue Fugen: die zuletzt benutzten Einstellungen */
function template(): Seam {
  let raw: any = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* Standard */ }
  return cleanSeam({ ...defaultSeam(), ...(raw && typeof raw === "object" ? raw : {}), axis: "x", pos: 0 }) ?? defaultSeam();
}
function remember(s: Seam) {
  const { joint, size, depth, count, spacing, clearance, alternate } = s;
  try { localStorage.setItem(KEY, JSON.stringify({ joint, size, depth, count, spacing, clearance, alternate })); } catch { /* egal */ }
}

/** Hinweis als Text */
export function issueText(i: Issue): string {
  const p: Record<string, string | number> = {
    seam: (i.seam ?? 0) + 1, piece: i.piece ?? "", n: i.n ?? 0,
    v: i.v !== undefined ? fmtLenU(i.v, 2) : "", w: i.w !== undefined ? fmtLenShort(i.w, 1) : "", h: i.h !== undefined ? fmtLenShort(i.h, 1) : "",
    x: i.x !== undefined ? fmtLenShort(i.x, 1) : "", y: i.y !== undefined ? fmtLenShort(i.y, 1) : "", u: unitName(),
  };
  return t("seam.i." + i.code, p);
}

function recompute() {
  res = draft ? computeSplit(app().shapes, draft) : null;
}

/** Rahmen der Zeichnung in mm (für neue Fugen und die Grenzen beim Ziehen) */
function drawingBox() {
  const b = res?.bounds;
  if (b) return b;
  const g = groupBounds(app().shapes);
  return g ? { minX: g.minX / K, minY: g.minY / K, maxX: g.maxX / K, maxY: g.maxY / K } : null;
}

// =====================================================================
// FENSTER
// =====================================================================

export function openSplitPanel() {
  const blocked = splitBlocked();
  if (blocked) { log(t(blocked)); return; }
  // auf einem Stück-Bett: zum Original wechseln, dort stehen die Fugen
  const piece = bedPiece();
  if (piece) {
    const src = splitSource(piece.of);
    if (src < 0) { log(t("seam.sourceGone", { name: piece.name })); return; }
    switchBed(src);
    log(t("seam.toSource", { name: bedName(src) }));
  }
  if (twoSidedOn()) { log(t("seam.noTwoSided")); return; }
  if (!app().shapes.length) { log(t("seam.empty")); return; }
  const stored = bedSplit();
  draft = stored ? cloneSplit(stored) : { id: newId(), seams: [] };
  draftBed = activeBed();
  sel = 0;
  ready = false;
  recompute();
  if (res && !res.bounds) { log(t("seam.i.noOutline")); draft = null; res = null; return; }
  // erstes Öffnen: gleich so teilen, dass jedes Stück passt
  if (!stored) {
    const g = fitGrid(app().shapes, template(), splitOptions());
    if (g) draft.seams = g.seams;
    recompute();
  }
  const bed = bedSizeMm();
  const b = drawingBox()!;
  const numRow = (label: string, id: string, attrs: string) => `<label style="${rowCss}">${label}<input type="number" id="${id}" class="prop-input" style="width:84px;" ${attrs}></label>`;
  panel = openToolPanel({
    id: "seam-split-panel", ico: "seamSplit", title: t("seam.title"), ok: "✔ " + t(stored && pieceBeds(stored.id).length ? "seam.remake" : "seam.make"), redraw: () => redraw(),
    body: `
      <div style="font-size:0.78rem;color:var(--text-muted);">${esc(t("seam.hint", { w: fmtLenShort(b.maxX - b.minX, 1), h: fmtLenShort(b.maxY - b.minY, 1), bw: fmtLenShort(bed.w, 1), bh: fmtLenShort(bed.h, 1), u: unitName() }))}</div>
      <div style="display:flex;gap:6px;align-items:center;font-size:0.85rem;flex-wrap:wrap;">
        <button type="button" class="btn-secondary btn-compact" data-act="fit" title="${esc(t("seam.fitTip"))}">⤢ ${esc(t("seam.fit"))}</button>
        <input type="number" id="ss-cols" data-unit="none" class="prop-input" min="1" max="${MAX_SEAMS + 1}" step="1" style="width:46px;" title="${esc(t("seam.cols"))}">
        ×
        <input type="number" id="ss-rows" data-unit="none" class="prop-input" min="1" max="${MAX_SEAMS + 1}" step="1" style="width:46px;" title="${esc(t("seam.rows"))}">
        <button type="button" class="btn-secondary btn-compact" data-act="even" title="${esc(t("seam.evenTip"))}">${esc(t("seam.even"))}</button>
      </div>
      <b style="font-size:0.85rem;">${esc(t("seam.list"))}</b>
      <div id="ss-list" style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow:auto;flex-shrink:0;"></div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="btn-secondary btn-compact" data-act="addx" style="flex:1;">＋ ${esc(t("seam.addX"))}</button>
        <button type="button" class="btn-secondary btn-compact" data-act="addy" style="flex:1;">＋ ${esc(t("seam.addY"))}</button>
        <button type="button" class="btn-secondary btn-compact" data-act="del" title="${esc(t("seam.del"))}">🗑</button>
      </div>
      <div id="ss-fields" style="display:flex;flex-direction:column;gap:6px;">
        ${numRow(esc(t("seam.pos")), "ss-pos", `data-unit="mm" step="1"`)}
        <label style="${rowCss}">${esc(t("seam.joint"))}
          <select id="ss-joint" class="prop-input" style="width:170px;">${SEAM_JOINTS.map(j => `<option value="${j}">${esc(t("seam.joint." + j))}</option>`).join("")}</select></label>
        <span id="ss-size-row">${numRow(esc(t("seam.sizeKnob")), "ss-size", `data-unit="mm" min="1" step="1"`)}</span>
        <span id="ss-fsize-row">${numRow(esc(t("seam.sizeFinger")), "ss-fsize", `data-unit="mm" min="1" step="1"`)}</span>
        <span id="ss-depth-row">${numRow(esc(t("seam.depth")), "ss-depth", `data-unit="mm" min="0.5" step="1"`)}</span>
        <span id="ss-count-row">${numRow(esc(t("seam.count")), "ss-count", `data-unit="none" min="0" max="200" step="1"`)}</span>
        <span id="ss-spacing-row">${numRow(esc(t("seam.spacing")), "ss-spacing", `data-unit="mm" min="2" step="10"`)}</span>
        <span id="ss-clear-row">${numRow(esc(t("seam.clear")), "ss-clear", `data-unit="mm" min="0" max="5" step="0.05"`)}</span>
        <label style="${checkCss}" id="ss-alt-row"><input type="checkbox" id="ss-alt"> ${esc(t("seam.alt"))}</label>
        <button type="button" class="btn-secondary btn-compact" data-act="all">${esc(t("seam.toAll"))}</button>
      </div>
      <div id="ss-gap" style="font-size:0.78rem;color:var(--text-muted);"></div>
      <b style="font-size:0.85rem;">${esc(t("seam.pieces"))}</b>
      <div id="ss-pieces" style="display:flex;flex-wrap:wrap;gap:4px;font-size:0.8rem;"></div>
      <div id="ss-issues" style="font-size:0.78rem;display:flex;flex-direction:column;gap:3px;"></div>
      <div style="font-size:0.75rem;color:var(--text-muted);">${esc(t("seam.testNote"))}</div>
      ${stored ? `<button type="button" class="btn-secondary btn-compact" data-act="remove">${esc(t("seam.remove"))}</button>` : ""}`,
    onChange: p => { if (!ready) return; readFields(p); recompute(); show(p, false); },
    onOk: () => create(),
    onClose: () => { panel = null; draft = null; res = null; drag = -1; draftBed = -1; ready = false; },
  });
  const p = panel;
  p.$<HTMLInputElement>("#ss-cols").value = String((res?.cols ?? 1));
  p.$<HTMLInputElement>("#ss-rows").value = String((res?.rows ?? 1));
  p.el.addEventListener("click", e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act],[data-seam]");
    if (!el || !draft) return;
    if (el.dataset.seam !== undefined) { sel = Number(el.dataset.seam); show(p, true); redraw(); return; }
    act(p, el.dataset.act!);
  });
  show(p, true);
  ready = true;
  redraw();
}

function act(p: ToolPanel, a: string) {
  if (!draft) return;
  const box = drawingBox();
  if (!box) return;
  const cur = draft.seams[sel];
  const like = cur ? { ...cur } : template();
  if (a === "fit") {
    const g = fitGrid(app().shapes, like, splitOptions());
    if (!g) { p.info(t("seam.fitNone"), true); return; }
    draft.seams = g.seams; sel = 0;
    p.$<HTMLInputElement>("#ss-cols").value = String(g.cols);
    p.$<HTMLInputElement>("#ss-rows").value = String(g.rows);
  } else if (a === "even") {
    draft.seams = gridSeams(box, p.num("#ss-cols", 1), p.num("#ss-rows", 1), like); sel = 0;
  } else if (a === "addx" || a === "addy") {
    const axis: SeamAxis = a === "addx" ? "x" : "y";
    const same = draft.seams.filter(s => s.axis === axis);
    if (same.length >= MAX_SEAMS) { p.info(t("seam.max", { n: MAX_SEAMS }), true); return; }
    // in die Mitte der größten Lücke
    const lo = axis === "x" ? box.minX : box.minY, hi = axis === "x" ? box.maxX : box.maxY;
    const marks = [lo, ...same.map(s => s.pos).sort((x, y) => x - y), hi];
    let at = (lo + hi) / 2, gap = 0;
    for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > gap) { gap = marks[i] - marks[i - 1]; at = (marks[i] + marks[i - 1]) / 2; }
    draft.seams.push({ ...like, axis, pos: Math.round(at * 10) / 10 });
    sel = draft.seams.length - 1;
  } else if (a === "del") {
    if (!cur) return;
    draft.seams.splice(sel, 1);
    sel = Math.max(0, Math.min(sel, draft.seams.length - 1));
  } else if (a === "all") {
    if (!cur) return;
    draft.seams = draft.seams.map(s => ({ ...cur, axis: s.axis, pos: s.pos }));
  } else if (a === "remove") {
    const stored = bedSplit();
    if (!stored) return;
    const n = pieceBeds(stored.id).length;
    if (n && !window.confirm(t("seam.confirmRemove", { n }))) return;
    setBedSplit(null);
    log(t("seam.removed"));
    p.close();
    return;
  }
  recompute();
  show(p, true);
  redraw();
}

/** Felder der gewählten Fuge lesen */
function readFields(p: ToolPanel) {
  const s = draft?.seams[sel];
  if (!s) return;
  const joint = p.$<HTMLSelectElement>("#ss-joint").value as Seam["joint"];
  const next = cleanSeam({
    axis: s.axis, pos: p.num("#ss-pos", s.pos), joint, size: p.num(s.joint === "finger" ? "#ss-fsize" : "#ss-size", s.size), depth: p.num("#ss-depth", s.depth),
    count: p.num("#ss-count", s.count), spacing: p.num("#ss-spacing", s.spacing), clearance: p.num("#ss-clear", s.clearance), alternate: p.check("#ss-alt"),
  });
  if (!next) return;
  const jointChanged = next.joint !== s.joint;
  draft!.seams[sel] = next;
  remember(next);
  if (jointChanged) { rows(p, next); p.$<HTMLInputElement>("#ss-size").value = p.$<HTMLInputElement>("#ss-fsize").value = String(next.size); }
}

/** Welche Zeilen zur Verbindung gehören */
function rows(p: ToolPanel, s: Seam | undefined) {
  const on = (id: string, yes: boolean) => { p.$<HTMLElement>(id).style.display = yes ? "" : "none"; };
  const j = s?.joint;
  p.$<HTMLElement>("#ss-fields").style.display = s ? "flex" : "none";
  on("#ss-size-row", j === "puzzle"); on("#ss-fsize-row", j === "finger"); on("#ss-depth-row", j === "finger"); on("#ss-count-row", j !== "butt");
  on("#ss-spacing-row", j === "puzzle"); on("#ss-clear-row", j !== "butt"); on("#ss-alt-row", j === "puzzle");
}

/** Fenster füllen. fields = auch die Eingabefelder neu setzen (nicht, während darin getippt wird) */
function show(p: ToolPanel, fields: boolean) {
  if (!draft) return;
  const s = draft.seams[sel];
  p.$<HTMLElement>("#ss-list").innerHTML = draft.seams.length
    ? draft.seams.map((m, i) => `<button type="button" data-seam="${i}" class="${i === sel ? "btn-primary" : "btn-secondary"} btn-compact" style="text-align:left;">${esc(t(m.axis === "x" ? "seam.rowX" : "seam.rowY", { n: i + 1, pos: fmtLenU(m.pos, 1), joint: t("seam.joint." + m.joint) }))}</button>`).join("")
    : `<span style="font-size:0.8rem;color:var(--text-muted);">${esc(t("seam.none"))}</span>`;
  if (fields) {
    rows(p, s);
    if (s) {
      const set = (id: string, v: number) => { p.$<HTMLInputElement>(id).value = String(+v.toFixed(3)); };
      set("#ss-pos", s.pos); set("#ss-size", s.size); set("#ss-fsize", s.size); set("#ss-depth", s.depth); set("#ss-count", s.count); set("#ss-spacing", s.spacing); set("#ss-clear", s.clearance);
      p.$<HTMLSelectElement>("#ss-joint").value = s.joint;
      p.$<HTMLInputElement>("#ss-alt").checked = s.alternate;
    }
  }
  const r = res;
  p.$<HTMLElement>("#ss-gap").textContent = r && s && s.joint !== "butt"
    ? t("seam.gap", { g: fmtLenU(2 * s.clearance, 2), d: fmtLenU(r.toolDia, 2) }) : r ? t("seam.tool", { d: fmtLenU(r.toolDia, 2) }) : "";
  p.$<HTMLElement>("#ss-pieces").innerHTML = r ? r.pieces.map(pc => {
    const w = pc.extent ? pc.extent.maxX - pc.extent.minX : 0, h = pc.extent ? pc.extent.maxY - pc.extent.minY : 0;
    return `<span style="padding:1px 6px;border-radius:6px;border:1px solid ${pc.fits ? "var(--border-color)" : "#ff5a5a"};color:${pc.fits ? "inherit" : "#ff7a7a"};" title="${esc(t(pc.fits ? "seam.fits" : "seam.noFits"))}">`
      + `<b>${esc(pc.name)}</b> ${esc(fmtLenShort(w, 1))} × ${esc(fmtLenShort(h, 1))} ${pc.fits ? "✓" : "✗"}</span>`;
  }).join("") : "";
  const list = r ? r.issues.filter(i => i.code !== "noFit") : [];
  p.$<HTMLElement>("#ss-issues").innerHTML = list.map(i => `<span style="color:${i.level === "error" ? "#ff7a7a" : "var(--lt-amber, #ffb454)"};">${i.level === "error" ? "⛔" : "⚠"} ${esc(issueText(i))}</span>`).join("");
  const bad = r ? r.pieces.filter(pc => !pc.fits).map(pc => pc.name) : [];
  p.info(!r ? "" : !r.ok ? t("seam.fixFirst") : bad.length ? t("seam.someNoFit", { names: bad.join(", ") }) : t("seam.allFit", { n: r.pieces.length }), !!r && (!r.ok || bad.length > 0));
}

/** OK: Stücke erzeugen (false = Fenster bleibt offen) */
function create(): boolean {
  if (!draft || !res) return false;
  recompute();
  const r = res as SplitResult | null;
  if (!r || !r.ok) { panel?.info(t("seam.fixFirst"), true); return false; }
  if (!draft.seams.length || r.pieces.length < 2) { panel?.info(t("seam.needSeam"), true); return false; }
  const bad = r.pieces.filter(pc => !pc.fits);
  if (bad.length && !window.confirm(t("seam.confirmNoFit", { names: bad.map(pc => pc.name).join(", ") }))) return false;
  const stored = bedSplit(), old = stored ? pieceBeds(stored.id).length : 0;
  if (old && !window.confirm(t("seam.confirmRemake", { n: old }))) return false;
  const n = makePieces(draft, app().shapes, r);
  log(t("seam.made", { n, names: r.pieces.map(pc => pc.name).join(", ") }));
  for (const i of r.issues) if (i.code !== "noFit") log(`${t("log.warning")} ${issueText(i)}`);
  return true;
}

// =====================================================================
// ZEICHENFLÄCHE
// =====================================================================

/** Wird nach dem normalen Zeichnen aufgerufen (main.ts) – ohne Fugen passiert nichts */
export function drawSplit(ctx: CanvasRenderingContext2D) {
  const live = panel && draft && draftBed === activeBed();
  const setup = live ? draft! : bedSplit();
  if (!setup || !setup.seams.length) return;
  const st = app(), scale = st.scale, bh = bedSizeMm().h * K;
  const sx = (x: number) => x * K * scale + st.offsetX, sy = (y: number) => (bh - y * K) * scale + st.offsetY;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (live && res && res.bounds) {
    // Stücke einfärben: grün passt, rot passt nicht
    for (const pc of res.pieces) {
      ctx.beginPath();
      for (const poly of pc.region) for (const ring of poly) {
        ring.forEach((q, i) => (i ? ctx.lineTo(sx(q[0]), sy(q[1])) : ctx.moveTo(sx(q[0]), sy(q[1]))));
        ctx.closePath();
      }
      ctx.fillStyle = pc.fits ? "rgba(52,209,123,0.10)" : "rgba(255,90,90,0.20)";
      ctx.fill("evenodd");
      ctx.strokeStyle = pc.fits ? "rgba(52,209,123,0.9)" : "rgba(255,90,90,0.95)";
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    // Fugen (Trennlinie mit Verbindung), die gewählte dicker
    for (const l of res.seams) {
      ctx.beginPath();
      l.line.forEach((q, i) => (i ? ctx.lineTo(sx(q[0]), sy(q[1])) : ctx.moveTo(sx(q[0]), sy(q[1]))));
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = l.index === sel ? 2.4 : 1.2;
      ctx.setLineDash(l.index === sel ? [] : [7, 4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const pc of res.pieces) label(ctx, pc.name, pc.region.length ? centre(pc.region) : null, sx, sy, pc.fits);
  } else {
    // gespeicherte Fugen: gerade gestrichelte Linien und die Namen der Zellen
    const g = groupBounds(st.shapes);
    if (!g) { ctx.restore(); return; }
    const b = { minX: g.minX / K, minY: g.minY / K, maxX: g.maxX / K, maxY: g.maxY / K };
    ctx.strokeStyle = "rgba(255,180,84,0.85)";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 4]);
    ctx.beginPath();
    for (const m of setup.seams) {
      if (m.axis === "x") { ctx.moveTo(sx(m.pos), sy(b.minY) + 10); ctx.lineTo(sx(m.pos), sy(b.maxY) - 10); }
      else { ctx.moveTo(sx(b.minX) - 10, sy(m.pos)); ctx.lineTo(sx(b.maxX) + 10, sy(m.pos)); }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const xs = [b.minX, ...setup.seams.filter(m => m.axis === "x" && m.pos > b.minX && m.pos < b.maxX).map(m => m.pos).sort((p, q) => p - q), b.maxX];
    const ys = [b.minY, ...setup.seams.filter(m => m.axis === "y" && m.pos > b.minY && m.pos < b.maxY).map(m => m.pos).sort((p, q) => p - q), b.maxY];
    for (let c = 0; c + 1 < xs.length; c++) for (let r = 0; r + 1 < ys.length; r++) {
      label(ctx, pieceName(c, ys.length - 2 - r), [(xs[c] + xs[c + 1]) / 2, (ys[r] + ys[r + 1]) / 2], sx, sy, true);
    }
  }
  ctx.restore();
}

function centre(m: [number, number][][][]): [number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const q of poly[0]) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

function label(ctx: CanvasRenderingContext2D, name: string, at: [number, number] | null, sx: (x: number) => number, sy: (y: number) => number, ok: boolean) {
  if (!at) return;
  const x = sx(at[0]), y = sy(at[1]);
  ctx.font = "700 18px system-ui, sans-serif";
  const w = ctx.measureText(name).width + 14;
  ctx.fillStyle = ok ? "rgba(20,24,30,0.78)" : "rgba(120,20,20,0.85)";
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 14, w, 28, 7);
  ctx.fill();
  ctx.fillStyle = "#ffcf8f";
  ctx.fillText(name, x, y + 1);
}

// =====================================================================
// FUGEN ZIEHEN
// =====================================================================

export function initSplitPanel(onRedraw: () => void, onLog: (s: string) => void) {
  redraw = onRedraw;
  log = onLog;
  const canvas = document.getElementById("cnc-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const world = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect(), st = app(), bh = bedSizeMm().h * K;
    const px = (e.clientX - r.left) * (canvas.width / r.width), py = (e.clientY - r.top) * (canvas.height / r.height);
    return { x: (px - st.offsetX) / st.scale / K, y: (bh - (py - st.offsetY) / st.scale) / K };
  };
  const hit = (e: MouseEvent): number => {
    if (!panel || !draft || draftBed !== activeBed()) return -1;
    const p = world(e), tol = 6 / (app().scale * K);
    let best = -1, bd = tol;
    draft.seams.forEach((m, i) => { const d = Math.abs((m.axis === "x" ? p.x : p.y) - m.pos); if (d <= bd) { bd = d; best = i; } });
    return best;
  };
  // läuft vor dem normalen Klick (capture), damit dort keine Auswahl-Box startet
  canvas.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    const i = hit(e);
    if (i < 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    drag = i; sel = i;
    if (panel) show(panel, true);
    redraw();
  }, true);
  let pending = false;
  window.addEventListener("mousemove", e => {
    if (drag < 0 || !draft || !panel) {
      if (panel && draft) { const i = hit(e); canvas.style.cursor = i < 0 ? "" : draft.seams[i].axis === "x" ? "col-resize" : "row-resize"; }
      return;
    }
    const m = draft.seams[drag], box = drawingBox();
    if (!m || !box) return;
    const p = world(e), lo = (m.axis === "x" ? box.minX : box.minY) + 1, hi = (m.axis === "x" ? box.maxX : box.maxY) - 1;
    // auf halbe Millimeter, mit Umschalt frei
    const raw = m.axis === "x" ? p.x : p.y;
    m.pos = Math.max(lo, Math.min(hi, e.shiftKey ? Math.round(raw * 100) / 100 : Math.round(raw * 2) / 2));
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!panel || !draft) return;
      recompute();
      show(panel, true);
      redraw();
    });
  });
  window.addEventListener("mouseup", () => {
    if (drag < 0) return;
    drag = -1;
    if (panel && draft) { recompute(); show(panel, true); redraw(); }
  });
  window.addEventListener("cnc-unit-changed", () => { if (panel) show(panel, true); });
}
