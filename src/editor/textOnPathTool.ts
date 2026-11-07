/**
 * TEXT AUF PFAD: Fenster und Übernahme (Rechnung in textOnPath.ts).
 *
 * Auswahl: ein Text und eine Kurve (Linie, Bogen, Kreis, Polylinie …). Das Ergebnis bleibt Text: textData und die Kurve
 * (textPath, am ersten Teil der Gruppe) werden mitgespeichert, Doppelklick öffnet dieses Fenster wieder. Die gemerkte Kurve
 * geht beim Verschieben, Drehen und Skalieren mit (shapeTransform.ts); die sichtbare Kurve darf gelöscht werden.
 */
import { app } from "./editorState";
import { checkpoint } from "./history";
import { selectedShapes } from "./selection";
import { livePreview } from "./livePreview";
import { Glyph, OnPathOptions, OnPathResult, P, layoutOnPath, orientPath } from "./textOnPath";
import { TEXT_DEFAULTS, TextParams, TracedText, traceGlyphsWithFont } from "./textTool";
import { traceSingleLine } from "./singleLine";
import { FALLBACK_FONT, resolveFont } from "./fonts";
import { createFontPicker } from "./fontPicker";
import { MM_TO_PIXEL, createPolyline, newId, shapeToPaths } from "../shapeTransform";
import { updateDimensionInputs } from "../uiInputs";
import { t } from "../i18n/i18n";
import { openToolPanel, rowCss, checkCss, ToolPanel } from "../ui/toolPanel";
import { esc } from "../setupSheet";

let redrawFn: () => void = () => {};
let log: (s: string) => void = () => {};

export function initTextOnPath(redraw: () => void, appendToConsole: (s: string) => void) {
  redrawFn = redraw;
  log = appendToConsole;
}

/** Was am ersten Teil des Textes gespeichert wird */
export interface TextPathData {
  pts: P[]; closed: boolean;
  offsetMm: number; side: "above" | "below"; flip: boolean; anchor: "start" | "center" | "end";
  spacingMm: number; distanceMm: number;
}

const KEEP = ["toolId", "laserLayerId", "plasmaCutId", "millingDepth", "source"];

interface Traced { glyphs: Glyph[]; baseline: number; missing: boolean }

/** Text → Buchstaben in Welt-Pixeln, einzeln, mit ihrem Abstand wie im geraden Schriftzug */
async function traceForPath(p: TextParams): Promise<Traced> {
  const rf = await resolveFont(p.font, p.bold, p.italic);
  const flat = { ...p, text: p.text.replace(/\s*\n\s*/g, " "), letterSpacing: 0 };
  const scale = (l: P[]) => l.map(q => ({ x: q.x * MM_TO_PIXEL, y: q.y * MM_TO_PIXEL }));
  if (rf.singleLine) {
    const tr: TracedText = await traceSingleLine(flat);
    const by = new Map<number, Glyph>();
    tr.loops.forEach((l, i) => {
      const k = tr.glyphOf?.[i] ?? i;
      if (!by.has(k)) by.set(k, { loops: [], closed: [] });
      by.get(k)!.loops.push(scale(l));
      by.get(k)!.closed!.push(tr.closed?.[i] ?? false);
    });
    return { glyphs: [...by.values()], baseline: (tr.baseline ?? 0) * MM_TO_PIXEL, missing: false };
  }
  const list = (await traceGlyphsWithFont(flat)) ?? [];
  return {
    glyphs: list.map(g => ({ loops: g.loops.map(scale) })),
    baseline: (list.find(g => g.baseline !== undefined)?.baseline ?? 0) * MM_TO_PIXEL,
    missing: rf.missing
  };
}

/** Auswahl prüfen und Fenster öffnen */
export function openTextOnPathDialog() {
  const sel = selectedShapes();
  const texts = sel.filter((s: any) => s.textData);
  const others = sel.filter((s: any) => !s.textData);
  const curves = others.filter((s: any) => shapeToPaths(s).some(q => q.pts.length >= 2));
  if (curves.length !== 1 || others.length !== 1) { log(t("topath.select")); return; }
  const path = shapeToPaths(curves[0])[0];
  const carrier = texts.find((s: any) => s.textPath);
  const params: TextParams = { ...TEXT_DEFAULTS, ...(texts[0]?.textData ?? {}) };
  showPanel(params, { pts: path.pts.map(q => ({ x: q.x, y: q.y })), closed: path.closed, ...settings(carrier?.textPath) }, texts, curves[0]);
}

/** Vorhandenen Text auf einem Pfad wieder bearbeiten (Doppelklick, siehe textTool.ts) */
export function openTextOnPathEdit(members: any[]) {
  const carrier = members.find((m: any) => m.textPath);
  showPanel({ ...TEXT_DEFAULTS, ...carrier.textData }, { ...carrier.textPath }, members, null);
}

function settings(d?: Partial<TextPathData>) {
  return {
    offsetMm: d?.offsetMm ?? 0, side: d?.side ?? "above" as const, flip: d?.flip ?? false,
    anchor: d?.anchor, spacingMm: d?.spacingMm ?? 0, distanceMm: d?.distanceMm ?? 0
  };
}

function showPanel(initial: TextParams, data: Omit<TextPathData, "anchor"> & { anchor?: TextPathData["anchor"] }, oldMembers: any[], curve: any | null) {
  const anchor = data.anchor ?? (data.closed ? "center" : "start");
  const numberRow = (label: string, id: string, val: number, step: string) =>
    `<label style="${rowCss}">${label}<input id="${id}" type="number" value="${val}" step="${step}" style="width:90px;"></label>`;
  const body = `
    <textarea id="tp-text" rows="2" style="width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text-main);border:1px solid var(--border-color);border-radius:6px;padding:6px;" placeholder="${esc(t("text.placeholder"))}">${esc(initial.text)}</textarea>
    <label style="display:flex;flex-direction:column;gap:3px;font-size:0.85rem;">${t("text.font")}<div id="tp-font"></div></label>
    ${numberRow(t("text.height"), "tp-height", initial.heightMm, "0.5")}
    <div style="display:flex;gap:14px;">
      <label style="${checkCss}"><input id="tp-bold" type="checkbox" ${initial.bold ? "checked" : ""}> <b>${t("text.bold")}</b></label>
      <label style="${checkCss}"><input id="tp-italic" type="checkbox" ${initial.italic ? "checked" : ""}> <i>${t("text.italic")}</i></label>
    </div>
    ${numberRow(t("topath.offset"), "tp-offset", data.offsetMm, "1")}
    ${numberRow(t("topath.spacing"), "tp-spacing", data.spacingMm, "0.1")}
    ${numberRow(t("topath.distance"), "tp-distance", data.distanceMm, "0.5")}
    <label style="${rowCss}">${t("topath.anchor")}
      <select id="tp-anchor" style="width:150px;">
        <option value="start">${t("topath.anchor.start")}</option>
        <option value="center">${t("topath.anchor.center")}</option>
        <option value="end">${t("topath.anchor.end")}</option>
      </select></label>
    <label style="${rowCss}">${t("topath.side")}
      <select id="tp-side" style="width:150px;">
        <option value="above">${t("topath.side.above")}</option>
        <option value="below">${t("topath.side.below")}</option>
      </select></label>
    <label style="${checkCss}"><input id="tp-flip" type="checkbox" ${data.flip ? "checked" : ""}> ${t("topath.flip")}</label>
    ${curve ? `<label style="${checkCss}"><input id="tp-del" type="checkbox"> ${t("topath.deleteCurve")}</label>` : `<div style="font-size:0.78rem;color:var(--text-muted);">${t("topath.editHint")}</div>`}`;

  let traced: Traced | null = null;
  let tracedKey = "";
  let run = 0;
  let timer = 0;
  let picker: { get: () => string; setMissing: (m: boolean) => void } | null = null;

  const read = (p: ToolPanel): TextParams => ({
    ...initial,
    text: p.$<HTMLTextAreaElement>("#tp-text").value,
    font: picker?.get() || initial.font || FALLBACK_FONT,
    heightMm: Math.max(0.5, p.num("#tp-height", initial.heightMm)),
    bold: p.check("#tp-bold"),
    italic: p.check("#tp-italic"),
    letterSpacing: 0
  });
  const readData = (p: ToolPanel): TextPathData => ({
    pts: data.pts, closed: data.closed,
    offsetMm: p.num("#tp-offset"), spacingMm: p.num("#tp-spacing"), distanceMm: p.num("#tp-distance"),
    side: p.$<HTMLSelectElement>("#tp-side").value as "above" | "below",
    anchor: p.$<HTMLSelectElement>("#tp-anchor").value as TextPathData["anchor"],
    flip: p.check("#tp-flip")
  });
  const lay = (p: ToolPanel, tr: Traced): OnPathResult => {
    const d = readData(p), text = read(p);
    const o: OnPathOptions = {
      offset: d.offsetMm * MM_TO_PIXEL, spacing: d.spacingMm * MM_TO_PIXEL, distance: d.distanceMm * MM_TO_PIXEL,
      side: d.side, anchor: d.anchor, capHeight: text.heightMm * MM_TO_PIXEL, baseline: tr.baseline
    };
    return layoutOnPath(tr.glyphs, orientPath(d.pts, d.closed, d.flip), d.closed, o);
  };
  const show = (p: ToolPanel) => {
    if (!traced) return;
    const r = lay(p, traced);
    livePreview.paths = r.loops;
    const mm = (v: number) => (v / MM_TO_PIXEL).toFixed(1);
    if (traced.missing) p.info(t("text.fontMissing", { font: read(p).font, fallback: FALLBACK_FONT }), true);
    else if (r.overflow) p.info(t("topath.overflow", { text: mm(r.textLength), path: mm(r.pathLength) }), true);
    else p.info(t("topath.info", { text: mm(r.textLength), path: mm(r.pathLength) }));
    redrawFn();
  };
  /** Nachzeichnen kostet Zeit und ist nur bei geänderter Schrift oder Text nötig; alles andere rechnet sofort */
  const ensure = async (p: ToolPanel) => {
    const text = read(p);
    const key = JSON.stringify([text.text, text.font, text.heightMm, text.bold, text.italic]);
    if (traced && key === tracedKey) return;
    const my = ++run;
    let res: Traced = { glyphs: [], baseline: 0, missing: false };
    try { res = await traceForPath(text); } catch { /* Schrift nicht lesbar -> leere Vorschau */ }
    if (my !== run) return;
    traced = res;
    tracedKey = key;
    picker?.setMissing(res.missing);
    show(p);
  };

  const panel = openToolPanel({
    id: "text-on-path-panel", ico: "textOnPath", title: t("topath.title"), body, ok: "✔ " + t("topath.run"), redraw: redrawFn,
    onChange: p => {
      show(p);
      clearTimeout(timer);
      timer = window.setTimeout(() => { ensure(p); }, 120);
    },
    onOk: async p => {
      clearTimeout(timer);
      await ensure(p);
      if (!traced) return false;
      const r = lay(p, traced);
      if (!r.loops.length) { p.info(t("topath.empty"), true); return false; }
      const text = read(p), d = readData(p);
      const like = oldMembers[0] ?? curve;
      const extra: Record<string, any> = {};
      for (const k of KEEP) if (like?.[k] !== undefined) extra[k] = like[k];
      const groupId = "text-" + newId();
      const shapes = r.loops.map(l => createPolyline(l.pts, l.closed, oldMembers[0]?.millingMode || "on-line", { ...extra, groupId, textData: { ...text } }));
      shapes[0].textPath = d;
      const gone = new Set<any>(oldMembers);
      if (curve && p.check("#tp-del")) gone.add(curve);
      const st = app();
      st.shapes = [...st.shapes.filter((s: any) => !gone.has(s)), ...shapes];
      st.selectedShapeIds = shapes.map(s => s.id);
      log(t("topath.done"));
      updateDimensionInputs(null);
      redrawFn();
      checkpoint();
    },
    onClose: () => { clearTimeout(timer); run++; }
  });
  panel.$<HTMLSelectElement>("#tp-anchor").value = anchor;
  panel.$<HTMLSelectElement>("#tp-side").value = data.side;
  picker = createFontPicker(panel.$<HTMLDivElement>("#tp-font"), initial.font, () => panel.el.dispatchEvent(new Event("change")));
  panel.el.dispatchEvent(new Event("change"));
  setTimeout(() => { const a = panel.$<HTMLTextAreaElement>("#tp-text"); a.focus(); a.select(); }, 0);
}
