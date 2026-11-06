/**
 * FAMILIEN-DEKO – Fenster (Generatoren): Familienname, Namen (einer je Zeile), Art, Motiv, Größe, Schrift.
 * Vorschau wie fertig aufgehängt. „Aufs Bett“ legt die Teile so ab (jedes eine Gruppe). Geometrie: familyDeco.ts.
 */
import { icon } from "../ui/icons";
import type { MultiPolygon } from "polygon-clipping";
import { loadSettings, saveSettings, matchDefaults } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, createPolyline, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { createFontPicker } from "./fontPicker";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, union, type ScoreLine, type XY } from "../nameConnect";
import { traceName } from "./ornamentGen";
import type { OrnamentText } from "../ornament";
import { familyDeco, motifKey, FAMILY_BARS, FAMILY_INNERS, FAMILY_LAYOUTS, FAMILY_MOTIFS, MAX_FAMILY_NAMES, type FamilyOptions, type FamilyResult } from "../familyDeco";

const KEY = "cnc_craft_family";
const DEF = { layout: "branch", motif: "ball", bar: "branch", size: 50, holeD: 4, inner: "engrave", family: "", names: "", font: "Pacifico", bold: false };
type Opts = typeof DEF;

function load(): Opts {
  let raw: any = {};
  try { raw = JSON.parse(loadSettings(KEY) || "{}"); } catch { /* egal */ }
  const o: Opts = { ...DEF, family: t("fam.defaultFamily"), names: "Anna\nBen\nClara\nDavid", ...matchDefaults(DEF, raw) };
  if (!(FAMILY_LAYOUTS as string[]).includes(o.layout)) o.layout = DEF.layout;
  if (!(FAMILY_MOTIFS as string[]).includes(o.motif)) o.motif = DEF.motif;
  if (!(FAMILY_BARS as string[]).includes(o.bar)) o.bar = DEF.bar;
  if (!(FAMILY_INNERS as string[]).includes(o.inner)) o.inner = DEF.inner;
  if (!(o.size > 0)) o.size = DEF.size;
  if (!(o.holeD > 0)) o.holeD = DEF.holeD;
  o.family = o.family.slice(0, 40);
  o.names = o.names.slice(0, 600);
  return o;
}

const nameList = (s: string) => s.split("\n").map(x => x.trim().slice(0, 30)).filter(Boolean);

function previewSvg(r: FamilyResult): string {
  const b = bounds(union(r.parts.map(p => p.cut)));
  if (!isFinite(b.x0)) return "";
  const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.04 + 1, sw = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 400;
  const xy = ([x, y]: XY | [number, number]) => `${(x - b.x0 + pad).toFixed(2)},${(b.y1 - y + pad).toFixed(2)}`;
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map((q, i) => `${i ? "L" : "M"}${xy(q as XY)}`).join("") + "Z").join("")).join("");
  const ln = (l: ScoreLine) => l.pts.map((q, i) => `${i ? "L" : "M"}${xy(q)}`).join("") + (l.closed ? "Z" : "");
  return `<svg viewBox="0 0 ${(b.x1 - b.x0 + 2 * pad).toFixed(2)} ${(b.y1 - b.y0 + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">
    ${r.threads.map(([a, c]) => `<path d="M${xy(a)}L${xy(c)}" stroke="#9aa3ad" stroke-width="${sw.toFixed(2)}" stroke-dasharray="${(sw * 4).toFixed(2)}"/>`).join("")}
    ${r.parts.map(p => `<path d="${d(p.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/><path d="${d(p.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/><path d="${p.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${(sw * 1.6).toFixed(2)}" stroke-linecap="round"/>`).join("")}</svg>`;
}

/** Teile aufs Bett, so wie in der Vorschau: Schnitt stärkste Linien-Ebene, Gravur Füll-Ebene, Linien schwächste Linien-Ebene */
function placeParts(r: FamilyResult, source: string) {
  const st = app(), bed = bedSizeMm(), b = bounds(union(r.parts.map(p => p.cut)));
  const dx = bed.w / 2 - (b.x0 + b.x1) / 2, dy = bed.h / 2 - (b.y0 + b.y1) / 2;
  const px = (m: MultiPolygon): MultiPolygon => m.map(p => p.map(rg => rg.map(([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy) * MM_TO_PIXEL] as [number, number])));
  const layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const engL = layers.find(l => l.mode === "fill");
  const mark = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const made: any[] = [];
  for (const p of r.parts) {
    const groupId = "family-" + newId();
    made.push(...toShapes(px(p.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    made.push(...toShapes(px(p.engrave), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, millingMode: "pocket", millingDepth: -0.5, source })));
    for (const l of p.lines) made.push(createPolyline(l.pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL })),
      l.closed, "on-line", { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
  }
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}

export function openFamilyDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("fam-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "fam-overlay";
  ov.className = "dlg-overlay";
  const sel = (id: string, key: string, opts: [string, string][], wrap = "") =>
    `<label class="dlg-row ${wrap}"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  const num = (id: string, key: string, step: string, min: string, wrap = "") =>
    `<label class="dlg-row ${wrap}"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>mm</em></span></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(780px, calc(100vw - 32px));">
      <h3>${icon("family", 20)}${t("fam.title")}</h3>
      <div class="dlg-hint">${t("fam.desc")}</div>
      <div style="display:grid;grid-template-columns:280px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("fam-layout", "fam.layout", FAMILY_LAYOUTS.map(k => [k, t("fam.layout." + k)]))}
          <label class="dlg-row"><span>${t("fam.family")}</span><input id="fam-family" type="text" maxlength="40" style="width:160px;"></label>
          <label class="dlg-row" style="align-items:start;"><span>${t("fam.names")}</span><textarea id="fam-names" rows="5" style="width:160px;resize:vertical;"></textarea></label>
          ${sel("fam-motif", "fam.motif", FAMILY_MOTIFS.map(k => [k, t(motifKey(k))]), "fam-bar-only")}
          ${sel("fam-bar", "fam.bar", FAMILY_BARS.map(k => [k, t("fam.bar." + k)]), "fam-bar-only")}
          ${num("fam-size", "fam.size", "1", "20")}
          ${num("fam-hd", "orn.holeD", "0.5", "1")}
          <label class="dlg-row"><span>${t("text.font")}</span><div id="fam-font" style="width:160px;"></div></label>
          <label class="dlg-row" style="cursor:pointer;"><span>${t("text.bold")}</span><input id="fam-bold" type="checkbox" style="width:auto;"></label>
          ${sel("fam-inner", "orn.inner", FAMILY_INNERS.map(k => [k, t("orn.inner." + k)]))}
        </div>
        <div class="box-prev" style="min-height:280px;"><div id="fam-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="fam-info" class="dlg-hint"></div></div>
      </div>
      <div id="fam-note" class="dlg-hint"></div>
      <div class="dlg-buttons">
        <button id="fam-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="fam-ok" class="btn-primary">✔ ${t("orn.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  // Namen sind fremder Text: nur per value setzen, nie ins innerHTML
  $<HTMLSelectElement>("fam-layout").value = o.layout; $<HTMLSelectElement>("fam-motif").value = o.motif;
  $<HTMLSelectElement>("fam-bar").value = o.bar; $<HTMLSelectElement>("fam-inner").value = o.inner;
  $("fam-family").value = o.family; $<HTMLTextAreaElement>("fam-names").value = o.names;
  $("fam-size").value = String(o.size); $("fam-hd").value = String(o.holeD); $("fam-bold").checked = o.bold;
  let font = o.font;

  const read = (): Opts => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
    const v = (id: string) => $<HTMLSelectElement>(id).value;
    return { layout: v("fam-layout"), motif: v("fam-motif"), bar: v("fam-bar"), inner: v("fam-inner"), size: n("fam-size", o.size), holeD: n("fam-hd", o.holeD),
      family: $("fam-family").value.slice(0, 40), names: $<HTMLTextAreaElement>("fam-names").value.slice(0, 600), font, bold: $("fam-bold").checked };
  };
  // Schrift merken: jeder Name wird nur einmal nachgezeichnet
  const cache = new Map<string, OrnamentText>();
  const trace = async (text: string, b: Opts): Promise<OrnamentText> => {
    if (!text.trim()) return { area: [], lines: [] };
    const k = [text, b.font, b.bold].join("|");
    let r = cache.get(k);
    if (!r) { r = await traceName({ text, line2: "", font: b.font, bold: b.bold, layers: 1 } as any); cache.set(k, r); }
    return r;
  };

  let last: FamilyResult | null = null, lastOpts = o, token = 0;
  async function update() {
    const b = read(), my = ++token;
    ov.querySelectorAll<HTMLElement>(".fam-bar-only").forEach(el => { el.style.display = b.layout === "tree" ? "none" : ""; });
    $<HTMLElement>("fam-note").textContent = t("fam.note." + b.layout) + " " + t("fbx.note.fit");
    const list = nameList(b.names);
    const [family, names] = await Promise.all([trace(b.family, b), Promise.all(list.slice(0, MAX_FAMILY_NAMES).map(x => trace(x, b)))]);
    if (my !== token) return;
    const r = familyDeco({ layout: b.layout, motif: b.motif, bar: b.bar, size: b.size, holeD: b.holeD, inner: b.inner } as FamilyOptions, family, names);
    last = r; lastOpts = b;
    $<HTMLButtonElement>("fam-ok").disabled = !!r.error;
    const info = $<HTMLElement>("fam-info");
    if (r.error) { $<HTMLElement>("fam-svg").innerHTML = ""; info.textContent = t(r.error); return; }
    $<HTMLElement>("fam-svg").innerHTML = previewSvg(r);
    let txt = t("fam.info", { n: r.parts.length, w: r.w.toFixed(0), h: r.h.toFixed(0) });
    if (list.length > MAX_FAMILY_NAMES) txt += " · " + t("fam.warn.many", { n: MAX_FAMILY_NAMES });
    const bed = bedSizeMm();
    if (r.w > bed.w || r.h > bed.h) txt += " · ⚠ " + t("fam.warn.bed");
    info.textContent = txt;
  }
  let tm = 0;
  const schedule = () => { clearTimeout(tm); tm = window.setTimeout(update, 200); };
  createFontPicker($<HTMLElement>("fam-font"), font, f => { font = f; schedule(); });
  ov.querySelectorAll("input, select, textarea").forEach(i => i.addEventListener("input", schedule));
  update();
  const close = () => { clearTimeout(tm); token++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("fam-cancel").onclick = close;
  $<HTMLElement>("fam-ok").onclick = async () => {
    clearTimeout(tm);
    await update();
    const r = last;
    if (!r || r.error) return;
    const b = lastOpts;
    saveSettings(KEY, b);
    close();
    placeParts(r, (b.family.trim() || t("fam.title")).slice(0, 40));
    log(t("fam.done", { n: r.parts.length }));
    done();
  };
}
