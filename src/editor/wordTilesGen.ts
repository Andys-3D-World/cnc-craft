/**
 * WORTPLÄTTCHEN-ANHÄNGER – Fenster (Generatoren): Namen eingeben, Familienname und Jahr für den Fuß, Form und Größe,
 * Plättchen einzeln (zum Aufkleben, mit Hilfslinien) oder direkt graviert. „Aufs Bett“ legt Grundplatte, Rahmen und
 * Plättchen nebeneinander. Die Geometrie entsteht in wordTiles.ts.
 */
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId, createPolyline } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { traceTextWithFont } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, union, type ScoreLine, type XY } from "../nameConnect";
import { fitText, motif, type OrnamentText } from "../ornament";
import { parseWords, bestLayout, layoutWords, roomAspect, wordTileOrnament, tileOutline, POINTS, HEART,
  type TileShape, type WordTileOptions, type WordTileResult, type TileLayout } from "../wordTiles";

const KEY = "cnc_craft_wordtiles";
type Pts = "de" | "en" | "none";
interface Opts extends WordTileOptions { words: string; line1: string; line2: string; tileFont: string; footFont: string; points: Pts; separate: boolean }
const DEF: Opts = { shape: "round", d: 90, frame: 4, footer: 30, holeD: 4, words: "<3 Don\n<3 Riley\nElesha", line1: "The Carrs", line2: "2026",
  tileFont: "Open Sans", footFont: "Great Vibes", points: "en", separate: true };

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of ["d", "frame", "footer", "holeD"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) > 0) o[k] = Number(s[k]);
    for (const k of ["words", "line1", "line2", "tileFont", "footFont"] as const) if (typeof s[k] === "string") o[k] = s[k].slice(0, 300);
    if (s.shape === "round" || s.shape === "rect") o.shape = s.shape;
    if (s.points === "de" || s.points === "en" || s.points === "none") o.points = s.points;
    if (typeof s.separate === "boolean") o.separate = s.separate;
    return o;
  } catch { return { ...DEF }; }
}

const cache = new Map<string, OrnamentText>();
/** Text nachzeichnen (zwischengespeichert): Fläche (Gerade/Ungerade) bzw. Linien bei Einzellinien-Schrift */
async function trace(s: string, font: string, bold: boolean): Promise<OrnamentText> {
  const k = JSON.stringify([s, font, bold]);
  const hit = cache.get(k);
  if (hit) return hit;
  const tr = (await traceTextWithFont({ text: s, font, heightMm: 10, bold, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  let res: OrnamentText;
  if (tr.closed?.some(c => !c)) res = { area: [], lines: loops.filter(l => l.length >= 2).map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })) };
  else {
    const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [l]);
    res = { area: !rings.length ? [] : rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)), lines: [] };
  }
  cache.set(k, res);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return res;
}

/** Alles, was graviert/geschnitten wird – je Teil */
interface Built {
  r: WordTileResult; lay: TileLayout;
  tileMarks: OrnamentText[];   // je Plättchen: Buchstabe + Zahl (Fläche/Linien), in Plattenlage
  foot: OrnamentText;          // Familienname + Jahr
}

async function build(o: Opts, seed: number): Promise<Built> {
  const words = parseWords(o.words), aspect = roomAspect(o);
  const lay = seed ? layoutWords(words, seed, aspect) : bestLayout(words, aspect);
  const r = wordTileOrnament(o, lay);
  const table = o.points === "none" ? null : POINTS[o.points];
  const tileMarks: OrnamentText[] = [];
  for (const tl of r.tiles) {
    const s = tl.s;
    const parts: OrnamentText[] = [];
    if (tl.ch === HEART) parts.push({ area: motif("hearts", tl.cx, tl.cy, s * 0.62), lines: [] });
    else {
      // Buchstabe etwas links oben, Zahl klein unten rechts (wie bei den Spielsteinen)
      const big = table ? { x0: tl.cx - s * 0.36, y0: tl.cy - s * 0.27, x1: tl.cx + s * 0.22, y1: tl.cy + s * 0.33 }
        : { x0: tl.cx - s * 0.33, y0: tl.cy - s * 0.3, x1: tl.cx + s * 0.33, y1: tl.cy + s * 0.3 };
      parts.push(fitText(await trace(tl.ch, o.tileFont, true), big));
      const n = table?.[tl.ch];
      if (n) parts.push(fitText(await trace(String(n), o.tileFont, true), { x0: tl.cx + s * 0.2, y0: tl.cy - s * 0.42, x1: tl.cx + s * 0.42, y1: tl.cy - s * 0.2 }));
    }
    tileMarks.push({ area: union(parts.map(p => p.area)), lines: parts.flatMap(p => p.lines) });
  }
  // Fuß: Familienname oben (größer), Jahr darunter
  const b = r.textBox, l1 = o.line1.trim(), l2 = o.line2.trim();
  const foot: OrnamentText = { area: [], lines: [] };
  const add = (tx: OrnamentText) => { foot.area = union([foot.area, tx.area]); foot.lines.push(...tx.lines); };
  const split = b.y0 + (b.y1 - b.y0) * 0.36;
  if (l1) add(fitText(await trace(l1, o.footFont, false), l2 ? { ...b, y0: split + (b.y1 - b.y0) * 0.04 } : b));
  if (l2) add(fitText(await trace(l2, o.tileFont, false), l1 ? { ...b, y1: split - (b.y1 - b.y0) * 0.02 } : b));
  return { r, lay, tileMarks, foot };
}

function previewSvg(bt: Built, o: Opts): string {
  const R = o.d / 2, pad = 3, v = (y: number) => (R + 8 - y).toFixed(2), h = (x: number) => (x + R + pad).toFixed(2);
  const d = (m: MultiPolygon) => m.map(p => p.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${h(x)},${v(y)}`).join("") + "Z").join("")).join("");
  const ln = (l: ScoreLine) => l.pts.map(([x, y], i) => `${i ? "L" : "M"}${h(x)},${v(y)}`).join("") + (l.closed ? "Z" : "");
  const tiles: MultiPolygon = bt.r.tiles.map(tl => [[...tileOutline(tl), tileOutline(tl)[0]]] as Polygon);
  const marks = bt.tileMarks.flatMap(m => m.area), mlines = bt.tileMarks.flatMap(m => m.lines);
  const sw = (o.d / 300).toFixed(2);
  return `<svg viewBox="0 0 ${o.d + 2 * pad} ${o.d + 16}" style="width:100%;max-height:330px;">
    <path d="${d(bt.r.back)}" fill="#6b4423" fill-rule="evenodd"/>
    <path d="${d(tiles)}" fill="#efdcb4" stroke="#b89a6a" stroke-width="${sw}"/>
    <path d="${d(marks)}" fill="#3b2a18" fill-rule="evenodd"/>
    <path d="${mlines.map(ln).join("")}" fill="none" stroke="#3b2a18" stroke-width="${sw}"/>
    <path d="${d(bt.r.front)}" fill="#d7b27f" fill-rule="evenodd" stroke="#8a6a40" stroke-width="${sw}"/>
    <path d="${d(bt.foot.area)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${bt.foot.lines.map(ln).join("")}" fill="none" stroke="#5a3a1c" stroke-width="${sw}"/></svg>`;
}

export function openWordTilesDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  let seed = 0;
  document.getElementById("wt-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "wt-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>🔠 ${t("wt.title")}</h3>
      <div class="dlg-hint">${t("wt.desc")}</div>
      <div style="display:grid;grid-template-columns:310px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          <div class="dlg-row"><span>${t("wt.words")}</span></div>
          <textarea id="wt-words" rows="4" style="width:100%;box-sizing:border-box;font-size:0.95rem;"></textarea>
          <div class="dlg-hint" style="margin:2px 0 6px;">${t("wt.wordsHint")}</div>
          <label class="dlg-row"><span>${t("wt.line1")}</span><input id="wt-l1" type="text" maxlength="40" style="width:170px;"></label>
          <label class="dlg-row"><span>${t("wt.line2")}</span><input id="wt-l2" type="text" maxlength="40" style="width:170px;"></label>
          <label class="dlg-row"><span>${t("wt.tileFont")}</span><div id="wt-tf" style="width:170px;"></div></label>
          <label class="dlg-row"><span>${t("wt.footFont")}</span><div id="wt-ff" style="width:170px;"></div></label>
          ${sel("wt-shape", "wt.shape", [["round", t("wt.shape.round")], ["rect", t("wt.shape.rect")]])}
          ${num("wt-d", "wt.d", "1", "40")}
          ${num("wt-frame", "wt.frame", "0.5", "1.5")}
          ${num("wt-foot", "wt.footer", "1", "15", "%")}
          ${num("wt-hole", "wt.holeD", "0.5", "1.5")}
          ${sel("wt-points", "wt.points", [["en", t("wt.points.en")], ["de", t("wt.points.de")], ["none", t("wt.points.none")]])}
          ${sel("wt-mode", "wt.mode", [["sep", t("wt.mode.sep")], ["eng", t("wt.mode.eng")]])}
          <button id="wt-dice" class="btn-secondary" type="button" style="width:100%;margin-top:6px;">🎲 ${t("wt.dice")}</button>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="wt-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="wt-info" class="dlg-hint"></div><div id="wt-warn" class="dlg-hint" style="color:#ffb454;"></div></div>
      </div>
      <div class="dlg-hint">${t("wt.hint")}</div>
      <div class="dlg-buttons">
        <button id="wt-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="wt-ok" class="btn-primary">✔ ${t("wt.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  let tileFont = init.tileFont, footFont = init.footFont;
  createFontPicker($<HTMLElement>("wt-tf"), tileFont, f => { tileFont = f; schedule(); });
  createFontPicker($<HTMLElement>("wt-ff"), footFont, f => { footFont = f; schedule(); });
  // Werte per value setzen (Namen sind fremder Text – nie ins innerHTML)
  $<HTMLTextAreaElement>("wt-words").value = init.words;
  $("wt-l1").value = init.line1; $("wt-l2").value = init.line2;
  $<HTMLSelectElement>("wt-shape").value = init.shape;
  $("wt-d").value = String(init.d); $("wt-frame").value = String(init.frame); $("wt-foot").value = String(init.footer); $("wt-hole").value = String(init.holeD);
  $<HTMLSelectElement>("wt-points").value = init.points; $<HTMLSelectElement>("wt-mode").value = init.separate ? "sep" : "eng";

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      words: $<HTMLTextAreaElement>("wt-words").value, line1: $("wt-l1").value, line2: $("wt-l2").value, tileFont, footFont,
      shape: $<HTMLSelectElement>("wt-shape").value as TileShape, d: n("wt-d", DEF.d, 40, 1000), frame: n("wt-frame", DEF.frame, 1.5, 50),
      footer: n("wt-foot", DEF.footer, 15, 45), holeD: n("wt-hole", DEF.holeD, 1.5, 20), points: $<HTMLSelectElement>("wt-points").value as Pts,
      separate: $<HTMLSelectElement>("wt-mode").value === "sep"
    };
  };

  let last: { o: Opts; bt: Built } | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    const bt = await build(o, seed);
    if (my !== run) return; // inzwischen neu eingegeben
    last = { o, bt };
    $<HTMLElement>("wt-svg").innerHTML = previewSvg(bt, o);
    const s = bt.r.tiles[0]?.s || 0;
    $<HTMLElement>("wt-info").textContent = bt.r.tiles.length ? t("wt.info", { n: bt.r.tiles.length, s: s.toFixed(1), d: o.d }) : t("wt.empty");
    // nicht untergebrachte Wörter: fremder Text – nur über textContent
    $<HTMLElement>("wt-warn").textContent = bt.lay.unplaced.length ? t("wt.unplaced", { w: bt.lay.unplaced.join(", ") }) : "";
    $<HTMLButtonElement>("wt-ok").disabled = !bt.r.tiles.length;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 200); };
  ov.querySelectorAll("input, select, textarea").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", schedule));
  $<HTMLElement>("wt-dice").onclick = () => { seed = 1 + Math.floor(Math.random() * 99999); schedule(); };
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("wt-cancel").onclick = close;
  $<HTMLElement>("wt-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    if (!last || !last.bt.r.tiles.length) return;
    try { localStorage.setItem(KEY, JSON.stringify(last.o)); } catch { /* egal */ }
    close();
    const n = place(last.bt, last.o);
    log(t(last.o.separate ? "wt.done" : "wt.doneEng", { n }));
    done();
  };
  setTimeout(() => $<HTMLTextAreaElement>("wt-words").focus(), 0);
}

/**
 * Aufs Bett (links unten, 10 mm Rand): Grundplatte, daneben Rahmen, daneben die Plättchen im Raster.
 * Schnitt: stärkste Linien-Ebene; Gravur (Buchstaben, Fuß-Text): Füll-Ebene; Hilfslinien: schwächste Linien-Ebene.
 */
function place(bt: Built, o: Opts): number {
  const st = app(), bed = bedSizeMm(), layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const markL = layers.filter(l => l.mode === "line").sort((a, c) => a.power - c.power)[0];
  const engL = layers.find(l => l.mode === "fill");
  const made: any[] = [], source = t("wt.title");
  const px = (m: MultiPolygon, dx: number, dy: number): MultiPolygon => m.map(p => p.map(rg => rg.map(([x, y]) => [(x + dx) * MM_TO_PIXEL, (y + dy) * MM_TO_PIXEL] as [number, number])));
  const pl = (pts: XY[], dx: number, dy: number) => pts.map(([x, y]) => ({ x: (x + dx) * MM_TO_PIXEL, y: (y + dy) * MM_TO_PIXEL }));
  const cut = (m: MultiPolygon, dx: number, dy: number, groupId: string) =>
    made.push(...toShapes(px(m, dx, dy), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  const eng = (tx: OrnamentText, dx: number, dy: number, groupId: string) => {
    made.push(...toShapes(px(tx.area, dx, dy), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, source, millingMode: "pocket", millingDepth: -0.5 })));
    for (const l of tx.lines) made.push(createPolyline(pl(l.pts, dx, dy), l.closed, "on-line", { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
  };
  const mark = (pts: XY[], dx: number, dy: number, groupId: string) =>
    made.push(createPolyline(pl(pts, dx, dy), true, "on-line", { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.2, isScore: true, groupId, source }));
  const bb = bounds(bt.r.back), W = bb.x1 - bb.x0, H = bb.y1 - bb.y0;
  // Grundplatte
  const bx = 10 - bb.x0, by = 10 - bb.y0, gBack = "wtiles-" + newId();
  cut(bt.r.back, bx, by, gBack);
  bt.r.tiles.forEach((tl, i) => {
    mark(tileOutline(tl), bx, by, gBack); // Hilfslinie bzw. Plättchen-Rand
    if (!o.separate) eng(bt.tileMarks[i], bx, by, gBack);
  });
  // Rahmen daneben (bzw. darüber, wenn das Bett zu schmal ist)
  const side = 10 + 2 * W + 10 <= bed.w;
  const fx = (side ? 20 + W : 10) - bb.x0, fy = (side ? 10 : 20 + H) - bb.y0, gFront = "wtiles-" + newId();
  cut(bt.r.front, fx, fy, gFront);
  eng(bt.foot, fx, fy, gFront);
  // Plättchen einzeln: im Raster neben/über den Platten, jedes eine Gruppe
  if (o.separate && bt.r.tiles.length) {
    const s = bt.r.tiles[0].s, gap = Math.max(2, s * 0.25);
    let x = side ? 30 + 2 * W : 20 + W, y = 10;
    const x0 = x;
    bt.r.tiles.forEach((tl, i) => {
      if (x + s > bed.w - 5 && x > x0) { x = x0; y += s + gap; }
      const dx = x + s / 2 - tl.cx, dy = y + s / 2 - tl.cy, g = "wtile-" + newId();
      made.push(createPolyline(pl(tileOutline(tl), dx, dy), true, "outside", { ...(cutL ? { laserLayerId: cutL.id } : {}), groupId: g, source }));
      eng(bt.tileMarks[i], dx, dy, g);
      x += s + gap;
    });
  }
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
  return bt.r.tiles.length;
}
