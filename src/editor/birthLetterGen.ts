/**
 * GEBURTSBUCHSTABE – Fenster (Generatoren): Buchstabe + Schrift + Höhe, Name, Geburtsdatum, Uhrzeit/Größe/Gewicht,
 * bis zu 3 eigene Bilder (PNG, JPG, SVG …) und kleine Motive. Die Aufteilung macht birthLetter.ts; hier werden die
 * Texte nachgezeichnet, die Vorschau gezeigt und alles als eine Gruppe aufs Bett gelegt:
 *   Umriss → stärkste Linien-Ebene (schneiden)   Name → Füll-Ebene (gravieren, an der Fräse Tasche)
 *   Datum, Daten, Symbole, Motive → schwächste Linien-Ebene (Einzellinien)   Bilder → Füll-Ebene (Bild gravieren)
 * Fremder Text (Name, Daten, Dateinamen) kommt nie ins innerHTML – nur als Geometrie bzw. textContent.
 */
import { editImages, loadSettings, saveSettings } from "./genRun";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont } from "./textTool";
import { traceSingleLine } from "./singleLine";
import { createFontPicker } from "./fontPicker";
import { createImageShape } from "../raster/imageShape";
import { getLayers } from "../laserLayers";
import { t, currentLanguage } from "../i18n/i18n";
import { offsetArea } from "../joints";
import { layoutBirth, iconLines, fitLines, dividerLines, MOTIF_KINDS, type Box, type Line, type XY, type IconKind, type MotifKind, type Layout } from "../birthLetter";

const KEY = "cnc_craft_birth";
interface Opts {
  letter: string; letterFont: string; height: number; margin: number; bold: number;
  name: string; nameFont: string; nameSize: number;
  date: string; time: string; length: string; weight: string; feet: boolean;
  infoSize: number; motifs: MotifKind[]; motifCount: number; motifSize: number;
}
const DEF: Opts = { letter: "", letterFont: "Nunito", height: 200, margin: 5, bold: 7, name: "Milo", nameFont: "Dancing Script", nameSize: 16,
  date: "", time: "", length: "", weight: "", feet: true, infoSize: 4, motifs: ["heart", "star", "leaf"], motifCount: 14, motifSize: 9 };
const STR = ["letter", "letterFont", "name", "nameFont", "date", "time", "length", "weight"] as const;
const NUMS = ["height", "margin", "bold", "nameSize", "infoSize", "motifCount", "motifSize"] as const;

function load(): Opts {
  try {
    const s = JSON.parse(loadSettings(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of STR) if (typeof s[k] === "string") o[k] = s[k].slice(0, 60);
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (typeof s.feet === "boolean") o.feet = s.feet;
    if (Array.isArray(s.motifs)) o.motifs = s.motifs.filter((m: any) => MOTIF_KINDS.includes(m));
    return o;
  } catch { return { ...DEF }; }
}

/** eigenes Bild (nur im Speicher, nicht in den Einstellungen) */
interface Pic { name: string; bytes: Uint8Array; ratio: number; src: string }

interface Built {
  letter: MultiPolygon; nameArea: MultiPolygon; lines: Line[]; images: { pic: Pic; box: Box }[];
  layout: Layout; w: number; h: number;
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));

function mpBounds(m: MultiPolygon) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}
const mapMp = (m: MultiPolygon, fn: (p: XY) => XY): MultiPolygon => m.map(poly => poly.map(r => r.map(p => fn(p as XY))));

/** nachgezeichnete Schrift auf ihre echten Außenmaße bringen: links unten bei (0, 0), w/h = Breite/Höhe */
function normalize(area: MultiPolygon, lines: Line[]): { area: MultiPolygon; lines: Line[]; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = ([x, y]: XY | [number, number]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const poly of area) for (const p of poly[0]) take(p as XY);
  for (const l of lines) for (const p of l.pts) take(p);
  if (!isFinite(x0)) return { area: [], lines: [], w: 0, h: 0 };
  const mv = ([x, y]: XY): XY => [x - x0, y - y0];
  return { area: mapMp(area, mv), lines: lines.map(l => ({ closed: l.closed, pts: l.pts.map(mv) })), w: x1 - x0, h: y1 - y0 };
}

/** Text als Fläche (Gerade/Ungerade) oder – bei Einzellinien-Schrift – als Linien */
async function traceArea(text: string, font: string, bold: boolean): Promise<{ area: MultiPolygon; lines: Line[]; w: number; h: number }> {
  const tr = (await traceTextWithFont({ text, font, heightMm: 10, bold, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  if (tr.closed?.some(c => !c)) return normalize([], loops.map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })));
  const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [[...l, l[0]]]);
  const area = rings.length ? (rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1))) : [];
  return normalize(area, []);
}

async function traceLine(text: string): Promise<{ lines: Line[]; w: number; h: number }> {
  const tr = await traceSingleLine({ text, font: "", heightMm: 10, bold: false, italic: false, align: "left", lineSpacing: 170, letterSpacing: 0 });
  return normalize([], tr.loops.map((l, i) => ({ pts: l.map(p => [p.x, p.y] as XY), closed: tr.closed?.[i] ?? false })));
}

/** Geometrie aus (0 … w, 0 … h) ins Kästchen b, Seitenverhältnis bleibt */
const into = (w: number, h: number, b: Box) => {
  const k = Math.min(b.w / w, b.h / h), ox = b.x + (b.w - w * k) / 2, oy = b.y + (b.h - h * k) / 2;
  return ([x, y]: XY): XY => [ox + x * k, oy + y * k];
};

function formatDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number);
  try { return new Intl.DateTimeFormat(currentLanguage(), { day: "numeric", month: "long", year: "numeric" }).format(new Date(y, m - 1, d)); }
  catch { return `${d}.${m}.${y}`; }
}

async function build(o: Opts, pics: Pic[]): Promise<Built | null> {
  const letterText = (o.letter.trim() || o.name.trim() || "A").slice(0, 1).toUpperCase();
  const L = await traceArea(letterText, o.letterFont, true);
  if (!L.area.length) return null;
  // dicker machen: Umriss rundum um bold % der Höhe nach außen (Ecken werden rund), dann wieder auf die Höhe bringen
  let k = o.height / Math.max(1e-6, L.h);
  let letter = mapMp(L.area, ([x, y]) => [x * k, y * k]);
  if (o.bold > 0) {
    const grown = normalize(offsetArea(letter, o.height * o.bold / 100), []);
    k = o.height / Math.max(1e-6, grown.h);
    letter = mapMp(grown.area, ([x, y]) => [x * k, y * k]);
  }
  const H = o.height;
  const name = o.name.trim() ? await traceArea(o.name.trim(), o.nameFont, false) : null;
  const dateText = formatDate(o.date);
  const date = dateText ? await traceLine(dateText) : null;
  // Geburtsdaten: Symbol oben, Text darunter
  const iconH = H * 0.07, textH = H * o.infoSize / 100;
  const infoDefs: { icon: IconKind; text: string }[] = [];
  if (o.time.trim()) infoDefs.push({ icon: "clock", text: o.time.trim() });
  if (o.length.trim()) infoDefs.push({ icon: "ruler", text: o.length.trim() });
  if (o.weight.trim()) infoDefs.push({ icon: "scale", text: o.weight.trim() });
  if (o.feet) infoDefs.push({ icon: "feet", text: "" });
  const infoTexts = await Promise.all(infoDefs.map(d => d.text ? traceLine(d.text) : Promise.resolve(null)));
  const infoSizes = infoDefs.map((_, i) => {
    const tx = infoTexts[i];
    const tw = tx ? textH * tx.w / Math.max(1e-6, tx.h) : 0;
    return { w: Math.max(iconH, tw), h: iconH + (tx ? textH * 1.4 : 0) };
  });
  const layout = layoutBirth({
    letter, height: H, margin: o.margin,
    nameRatio: name ? name.w / Math.max(1e-6, name.h) : 0, nameSize: o.nameSize,
    dateRatio: date ? date.w / Math.max(1e-6, date.h) : 0, dateSize: o.infoSize * 1.1,
    infos: infoSizes, images: pics.map(p => p.ratio), imageMax: 42,
    motifs: o.motifs.length ? o.motifCount : 0, motifSize: o.motifSize
  });
  const lines: Line[] = [];
  let nameArea: MultiPolygon = [];
  if (name && layout.name) {
    const fn = into(name.w, name.h, layout.name);
    nameArea = mapMp(name.area, fn);
    lines.push(...name.lines.map(l => ({ closed: l.closed, pts: l.pts.map(fn) })));
  }
  if (date && layout.date) { const fn = into(date.w, date.h, layout.date); lines.push(...date.lines.map(l => ({ closed: l.closed, pts: l.pts.map(fn) }))); }
  if (layout.divider) { const d = layout.divider; lines.push(...dividerLines(d.w, d.h).map(l => ({ closed: l.closed, pts: l.pts.map(([x, y]) => [x + d.x, y + d.y] as XY) }))); }
  layout.infos.forEach((b, i) => {
    if (!b) return;
    const s = b.w / infoSizes[i].w; // kann verkleinert sein
    const ih = iconH * s;
    lines.push(...fitLines(iconLines(infoDefs[i].icon), { x: b.x, y: b.y + b.h - ih, w: b.w, h: ih }));
    const tx = infoTexts[i];
    if (tx) { const fn = into(tx.w, tx.h, { x: b.x, y: b.y, w: b.w, h: textH * s }); lines.push(...tx.lines.map(l => ({ closed: l.closed, pts: l.pts.map(fn) }))); }
  });
  layout.motifs.forEach((b, i) => lines.push(...fitLines(iconLines(o.motifs[i % o.motifs.length]), b)));
  const images = layout.images.map((box, i) => box ? { pic: pics[i], box } : null).filter(Boolean) as { pic: Pic; box: Box }[];
  const lb = mpBounds(letter);
  return { letter, nameArea, lines, images, layout, w: lb.x1, h: lb.y1 };
}

function previewSvg(b: Built): string {
  const pad = Math.max(b.w, b.h) * 0.03 + 1;
  const X = (x: number) => (x + pad).toFixed(2), Y = (y: number) => (b.h - y + pad).toFixed(2);
  const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${X(x)},${Y(y)}`).join("") + "Z").join("")).join("");
  const ln = (l: Line) => l.pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x)},${Y(y)}`).join("") + (l.closed ? "Z" : "");
  const sw = Math.max(b.w, b.h) / 500;
  // Bilder: eigene Daten-URL (von uns erzeugt), Name/Pfad des Bilds kommt nicht ins SVG
  const imgs = b.images.map(({ pic, box }) =>
    `<image href="${pic.src}" x="${X(box.x)}" y="${Y(box.y + box.h)}" width="${box.w.toFixed(2)}" height="${box.h.toFixed(2)}" preserveAspectRatio="xMidYMid meet" style="mix-blend-mode:multiply;opacity:.85"/>`).join("");
  return `<svg viewBox="0 0 ${(b.w + 2 * pad).toFixed(2)} ${(b.h + 2 * pad).toFixed(2)}" style="width:100%;height:340px;">
    <path d="${d(b.letter)}" fill="#e6c9a0" fill-rule="evenodd" stroke="#ffd28a" stroke-width="${sw.toFixed(2)}"/>${imgs}
    <path d="${d(b.nameArea)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${b.lines.map(ln).join("")}" fill="none" stroke="#5a3a1c" stroke-width="${(sw * 1.2).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function openBirthLetterDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  if (!init.date) { const n = new Date(); init.date = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; }
  const pics: Pic[] = editImages().slice(0, 3); // beim Bearbeiten: die Bilder des alten Laufs
  document.getElementById("birth-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "birth-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const txt = (id: string, key: string, phKey = "") =>
    `<label class="dlg-row"><span>${t(key)}</span><input id="${id}" type="text" maxlength="40" style="width:160px;" ${phKey ? `placeholder="${t(phKey)}"` : ""}></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>👶 ${t("birth.title")}</h3>
      <div class="dlg-hint">${t("birth.desc")}</div>
      <div style="display:grid;grid-template-columns:320px 1fr;gap:12px;align-items:start;">
        <div class="box-fields" style="max-height:62vh;overflow:auto;padding-right:4px;">
          ${txt("bl-name", "birth.name")}
          <label class="dlg-row"><span>${t("birth.nameFont")}</span><div id="bl-nfont" style="width:160px;"></div></label>
          ${num("bl-ns", "birth.nameSize", "1", "5", "%")}
          <label class="dlg-row"><span>${t("birth.letter")}</span><input id="bl-letter" type="text" maxlength="1" style="width:50px;" placeholder="${t("birth.letterAuto")}"></label>
          <label class="dlg-row"><span>${t("birth.letterFont")}</span><div id="bl-lfont" style="width:160px;"></div></label>
          ${num("bl-h", "birth.height", "1", "60")}
          ${num("bl-bold", "birth.bold", "0.5", "0", "%")}
          ${num("bl-m", "birth.margin", "0.5", "1")}
          <label class="dlg-row"><span>${t("birth.date")}</span><input id="bl-date" type="date" style="width:160px;"></label>
          ${txt("bl-time", "birth.time", "birth.timePh")}
          ${txt("bl-len", "birth.length", "birth.lengthPh")}
          ${txt("bl-wt", "birth.weight", "birth.weightPh")}
          <label class="dlg-row" style="cursor:pointer;"><span>${t("birth.feet")}</span><input id="bl-feet" type="checkbox" style="width:auto;"></label>
          ${num("bl-is", "birth.infoSize", "0.5", "1", "%")}
          <div class="dlg-row"><span>${t("birth.images")}</span><span></span></div>
          ${[0, 1, 2].map(i => `<div class="dlg-row"><button id="bl-img${i}" class="btn-secondary" style="width:auto;">📷 ${t("birth.imageLoad", { n: i + 1 })}</button>
            <span id="bl-imgname${i}" class="dlg-hint" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:6px;"></span>
            <button id="bl-imgdel${i}" class="btn-secondary" style="width:auto;display:none;">✕</button></div>`).join("")}
          <input id="bl-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,.svg" style="display:none;">
          <div class="dlg-hint">${t("birth.imagesHint")}</div>
          <div class="dlg-row"><span>${t("birth.motifs")}</span><span></span></div>
          <div style="display:flex;flex-wrap:wrap;gap:6px 12px;">${MOTIF_KINDS.map(m =>
            `<label style="cursor:pointer;display:flex;gap:4px;align-items:center;"><input type="checkbox" class="bl-motif" value="${m}" style="width:auto;">${t("birth.motif." + m)}</label>`).join("")}</div>
          ${num("bl-mc", "birth.motifCount", "1", "0", "")}
          ${num("bl-msz", "birth.motifSize", "0.5", "3")}
        </div>
        <div class="box-prev" style="min-height:360px;"><div id="bl-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="bl-info" class="dlg-hint"></div><div id="bl-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="bl-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="bl-ok" class="btn-primary">✔ ${t("birth.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  let nameFont = init.nameFont, letterFont = init.letterFont;
  createFontPicker($<HTMLElement>("bl-nfont"), nameFont, fnt => { nameFont = fnt; schedule(); });
  createFontPicker($<HTMLElement>("bl-lfont"), letterFont, fnt => { letterFont = fnt; schedule(); });
  // fremde Texte nur über .value
  $("bl-name").value = init.name; $("bl-letter").value = init.letter; $("bl-date").value = init.date;
  $("bl-time").value = init.time; $("bl-len").value = init.length; $("bl-wt").value = init.weight;
  $("bl-feet").checked = init.feet;
  const nums: [string, (typeof NUMS)[number]][] = [["bl-ns", "nameSize"], ["bl-h", "height"], ["bl-bold", "bold"], ["bl-m", "margin"], ["bl-is", "infoSize"], ["bl-mc", "motifCount"], ["bl-msz", "motifSize"]];
  for (const [id, k] of nums) $(id).value = String(init[k]);
  ov.querySelectorAll<HTMLInputElement>(".bl-motif").forEach(c => { c.checked = init.motifs.includes(c.value as MotifKind); });

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      letter: $("bl-letter").value.trim().slice(0, 1), letterFont, height: n("bl-h", DEF.height, 60, 1500), margin: n("bl-m", DEF.margin, 1, 50), bold: n("bl-bold", DEF.bold, 0, 25),
      name: $("bl-name").value.slice(0, 40), nameFont, nameSize: n("bl-ns", DEF.nameSize, 5, 40),
      date: $("bl-date").value, time: $("bl-time").value.slice(0, 20), length: $("bl-len").value.slice(0, 20), weight: $("bl-wt").value.slice(0, 20),
      feet: $("bl-feet").checked, infoSize: n("bl-is", DEF.infoSize, 1, 15),
      motifs: [...ov.querySelectorAll<HTMLInputElement>(".bl-motif")].filter(c => c.checked).map(c => c.value as MotifKind),
      motifCount: Math.round(n("bl-mc", DEF.motifCount, 0, 60)), motifSize: n("bl-msz", DEF.motifSize, 3, 60)
    };
  };

  // Bilder laden: Platz 0 … 2
  let slot = 0;
  const showPics = () => [0, 1, 2].forEach(i => {
    $<HTMLElement>("bl-imgname" + i).textContent = pics[i] ? pics[i].name : ""; // fremder Dateiname – nur als Text
    $<HTMLElement>("bl-imgdel" + i).style.display = pics[i] ? "" : "none";
    $<HTMLElement>("bl-img" + i).style.display = i <= pics.length ? "" : "none";
  });
  [0, 1, 2].forEach(i => {
    $<HTMLElement>("bl-img" + i).onclick = () => { slot = i; $("bl-file").click(); };
    $<HTMLElement>("bl-imgdel" + i).onclick = () => { pics.splice(i, 1); showPics(); schedule(); };
  });
  $("bl-file").onchange = async () => {
    const file = $("bl-file").files?.[0];
    $("bl-file").value = "";
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const probe = await createImageShape(file.name, bytes, 100, 0, 0);
      pics[Math.min(slot, pics.length)] = { name: file.name.slice(0, 80), bytes, ratio: probe.img.ph / probe.img.pw, src: probe.img.src };
      showPics(); schedule();
    } catch { log(t("birth.imageFail")); }
  };
  showPics();

  let last: Built | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    let b: Built | null = null;
    try { b = await build(o, pics.filter(Boolean)); } catch { b = null; }
    if (my !== run) return;
    last = b;
    $<HTMLElement>("bl-svg").innerHTML = b ? previewSvg(b) : "";
    $<HTMLElement>("bl-info").textContent = b ? t("birth.info", { w: f(b.w), h: f(b.h) }) : "";
    $<HTMLElement>("bl-warn").innerHTML = b ? b.layout.warnings.map(w => `<div>${t(w)}</div>`).join("") : `<div>${t("birth.warnLetter")}</div>`;
    $<HTMLButtonElement>("bl-ok").disabled = !b;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 220); };
  ov.querySelectorAll("input:not([type=file]), select").forEach(i =>
    i.addEventListener((i as HTMLInputElement).type === "checkbox" || (i as HTMLInputElement).type === "date" ? "change" : "input", schedule));
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("bl-cancel").onclick = close;
  $<HTMLElement>("bl-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    const b = last;
    if (!b) return;
    const o = read();
    saveSettings(KEY, o);
    close();
    await placeBirth(b, o.name.trim() || t("birth.title"));
    log(t("birth.done", { w: f(b.w), h: f(b.h) }));
    done();
  };
  setTimeout(() => { const i = $("bl-name"); i.focus(); i.select(); }, 0);
}

async function placeBirth(b: Built, name: string) {
  const st = app();
  const bed = bedSizeMm();
  const dx = bed.w / 2 - b.w / 2, dy = bed.h / 2 - b.h / 2;
  const px = (m: MultiPolygon): MultiPolygon => mapMp(m, ([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy) * MM_TO_PIXEL]);
  const layers = getLayers();
  const lineLayers = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power);
  const cutL = lineLayers[0], markL = lineLayers[lineLayers.length - 1], fillL = layers.find(l => l.mode === "fill");
  const groupId = "birth-" + newId(), source = name.slice(0, 40);
  const made: any[] = [];
  for (const { pic, box } of b.images) {
    // Bild genau ins Kästchen (Seitenverhältnis bleibt): Breite = kleinere Seite passend
    const w = Math.min(box.w, box.h / pic.ratio), h = w * pic.ratio;
    const im = await createImageShape(pic.name, pic.bytes, w, box.x + (box.w - w) / 2 + dx, box.y + (box.h - h) / 2 + dy);
    if (fillL) im.laserLayerId = fillL.id;
    made.push({ ...im, groupId, source });
  }
  made.push(...toShapes(px(b.nameArea), fillL ? { laserLayerId: fillL.id } : {}).map(s => ({ ...s, groupId, millingMode: "pocket", millingDepth: -0.5, source })));
  for (const l of b.lines) if (l.pts.length >= 2)
    made.push(createPolyline(l.pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL })), l.closed, "on-line",
      { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
  made.push(...toShapes(px(b.letter), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
