/**
 * PRALINEN-HALTER – Fenster (Generatoren): Thema und Form wie beim Deko-Anhänger, Größe, Materialstärke, Füllung (rund oder Riegel),
 * Tiefe, Spiel, Anzahl Öffnungen, Haltesteg, Aufhänger, Text. Vorschau: alle Schichten nebeneinander.
 * „Aufs Bett“ legt die Teile in einer Reihe ab (jedes eine Gruppe). Geometrie und Prüfungen: candyHolder.ts.
 */
import { icon } from "../ui/icons";
import type { MultiPolygon, Polygon } from "polygon-clipping";
import polygonClipping from "polygon-clipping";
import { loadSettings, saveSettings } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, createPolyline, newId } from "../shapeTransform";
import { traceTextWithFont } from "./textTool";
import { createFontPicker } from "./fontPicker";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { t } from "../i18n/i18n";
import { esc } from "../setupSheet";
import { bounds, type ScoreLine, type XY } from "../nameConnect";
import { themeList, type Theme } from "../themes";
import { themeSelectHtml, fillSelect } from "./themePicker";
import type { OrnamentText } from "../ornament";
import { candyHolder, candySettings, suggestSize, CANDY_BUILDS, CANDY_HANGERS, CANDY_INNERS, CANDY_MAX_COUNT, type CandyPart, type CandyResult, type CandySettings } from "../candyHolder";

const KEY = "cnc_craft_candy_holder";

function load(): CandySettings {
  try {
    const raw = loadSettings(KEY);
    const o = candySettings(raw ? JSON.parse(raw) : {});
    if (!raw) o.text = t("ch.textDefault");
    return o;
  } catch { return candySettings({}); }
}

/** Schrift nachzeichnen: geschlossene Konturen als Fläche, Einzellinien-Schrift als Linien */
async function traceText(o: CandySettings): Promise<OrnamentText> {
  const text = [o.text, o.line2].map(s => s.trim()).filter(Boolean).join("\n");
  if (!text) return { area: [], lines: [] };
  const tr = (await traceTextWithFont({ text, font: o.font, heightMm: 10, bold: o.bold, italic: false, align: "center", lineSpacing: 140, letterSpacing: 0 })).traced;
  const loops = tr.loops.map(l => l.map(p => [p.x, p.y] as XY));
  if (tr.closed?.some(c => !c)) return { area: [], lines: loops.filter(l => l.length >= 2).map((pts, i) => ({ pts, closed: tr.closed?.[i] !== false })) };
  const rings: Polygon[] = loops.filter(l => l.length >= 3).map(l => [l]);
  return { area: !rings.length ? [] : rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1)), lines: [] };
}

/** Vorschau: Front, eine Mittelschicht (× Anzahl), Rückwand; gestrichelt die Füllung */
function previewSvg(r: CandyResult): string {
  const b = bounds(r.outline);
  if (!isFinite(b.x0)) return "";
  const W = b.x1 - b.x0, H = b.y1 - b.y0, gap = Math.max(4, W * 0.08), head = Math.max(6, H * 0.09);
  const front = r.parts[0], mid = r.parts.find(p => p.kind === "middle"), back = r.parts[r.parts.length - 1];
  const tiles: { p: CandyPart; label: string; ghost: boolean }[] = [{ p: front, label: t("ch.prev.front"), ghost: true }];
  if (mid) tiles.push({ p: mid, label: `${t("ch.prev.middle")} × ${r.middle}`, ghost: true });
  tiles.push({ p: back, label: t("ch.prev.back"), ghost: false });
  const sw = (Math.max(W, H) / 300).toFixed(2), size = Math.max(3, H * 0.055).toFixed(1);
  const body = tiles.map(({ p, label, ghost }, i) => {
    const ox = i * (W + gap);
    const xy = (q: number[]) => `${(q[0] - b.x0 + ox).toFixed(2)},${(b.y1 - q[1] + head).toFixed(2)}`;
    const d = (m: MultiPolygon) => m.map(poly => poly.map(rg => rg.map((q, k) => `${k ? "L" : "M"}${xy(q)}`).join("") + "Z").join("")).join("");
    const ln = (l: ScoreLine) => l.pts.map((q, k) => `${k ? "L" : "M"}${xy(q)}`).join("") + (l.closed ? "Z" : "");
    return `<text x="${(ox + W / 2).toFixed(1)}" y="${(head * 0.6).toFixed(1)}" text-anchor="middle" font-size="${size}" fill="currentColor">${esc(label)}</text>
      <path d="${d(p.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${sw}"/>
      <path d="${d(p.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/>
      <path d="${p.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${sw}"/>
      ${ghost ? `<path d="${d(r.sweets)}" fill="none" stroke="#7fb4ff" stroke-width="${sw}" stroke-dasharray="${(Number(sw) * 4).toFixed(2)}"/>` : ""}`;
  }).join("");
  return `<svg viewBox="0 0 ${(tiles.length * W + (tiles.length - 1) * gap).toFixed(1)} ${(H + head + 1).toFixed(1)}" style="width:100%;max-height:300px;">${body}</svg>`;
}

/** Vorschau Faltstreifen: der flache Streifen, die Seitenstege und daneben das gefaltete Zelt von der Seite */
function previewFlexSvg(r: CandyResult): string {
  const fx = r.flex, strip = r.parts[0];
  if (!fx || !strip) return "";
  const sb = bounds(strip.cut), W = sb.x1 - sb.x0, H = sb.y1 - sb.y0;
  const tentW = Math.max(...fx.profile.map(p => p[0]), fx.floor / 2) * 2 + 6, gap = Math.max(10, W * 0.25), head = Math.max(8, H * 0.07);
  const bars = r.parts.filter(p => p.kind === "sideBar");
  const barW = bars.length ? fx.floor : 0;
  const totalW = W + gap + Math.max(tentW, barW), size = Math.max(4, H * 0.042).toFixed(1), sw = (Math.max(totalW, H) / 400).toFixed(2);
  const sxy = (q: number[], ox = 0, oy = 0) => `${(q[0] - sb.x0 + ox).toFixed(2)},${(sb.y1 - q[1] + head + oy).toFixed(2)}`;
  const d = (m: MultiPolygon, ox = 0, oy = 0) => m.map(poly => poly.map(rg => rg.map((q, k) => `${k ? "L" : "M"}${sxy(q, ox, oy)}`).join("") + "Z").join("")).join("");
  const ln = (l: ScoreLine) => l.pts.map((q, k) => `${k ? "L" : "M"}${sxy(q)}`).join("") + (l.closed ? "Z" : "");
  // Zelt: Boden unten, gleicher Maßstab
  const tx = W + gap + Math.max(tentW, barW) / 2, ty = head + Math.min(H - 2, fx.height + 4);
  const tp = (q: number[]) => `${(tx + q[0]).toFixed(2)},${(ty - q[1]).toFixed(2)}`;
  const half = fx.profile, full = [...half.slice().reverse().map(([x, y]) => [-x, y]), ...half.slice(1)];
  const tent = full.map((q, i) => `${i ? "L" : "M"}${tp(q)}`).join("");
  const sweet = fx.sweet.map((q, i) => `${i ? "L" : "M"}${tp(q)}`).join("") + "Z";
  // Seitensteg im Zelt von der Seite: steht auf dem Boden
  const barsSvg = bars.length ? `<path d="${bars[0].cut.map(poly => poly.map(rg => rg.map((q, k) => `${k ? "L" : "M"}${tp([q[0] - fx.floor / 2, q[1] + r.total / 2])}`).join("") + "Z").join("")).join("")}" fill="#c98a4b" fill-opacity="0.55" stroke="#5a3a1c" stroke-width="${sw}"/>` : "";
  return `<svg viewBox="0 0 ${totalW.toFixed(1)} ${(H + head + 1).toFixed(1)}" style="width:100%;max-height:330px;">
    <text x="${(W / 2).toFixed(1)}" y="${(head * 0.65).toFixed(1)}" text-anchor="middle" font-size="${size}" fill="currentColor">${esc(t("ch.prev.strip"))}</text>
    <text x="${tx.toFixed(1)}" y="${(head * 0.65).toFixed(1)}" text-anchor="middle" font-size="${size}" fill="currentColor">${esc(t("ch.prev.tent"))}</text>
    <path d="${d(strip.cut)}" fill="#c98a4b" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${sw}"/>
    <path d="${d(strip.engrave)}" fill="#5a3a1c" fill-rule="evenodd"/>
    <path d="${strip.lines.map(ln).join("")}" fill="none" stroke="#3ccf4e" stroke-width="${sw}"/>
    <path d="${(strip.slits || []).map(ln).join("")}" fill="none" stroke="#5a3a1c" stroke-width="${sw}"/>
    ${tent ? `<path d="${tent}" fill="none" stroke="#c98a4b" stroke-width="${r.total.toFixed(2)}" stroke-linejoin="round"/>` : ""}
    ${tent ? `<path d="${sweet}" fill="none" stroke="#7fb4ff" stroke-width="${sw}" stroke-dasharray="${(Number(sw) * 4).toFixed(2)}"/>` : ""}
    ${barsSvg}</svg>`;
}

export function openCandyHolderDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("ch-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "ch-dialog-overlay";
  ov.className = "dlg-overlay";
  const sel = (id: string, key: string, list: readonly string[], prefix: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${list.map(v => `<option value="${v}">${t(prefix + v)}</option>`).join("")}</select></label>`;
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const chk = (id: string, key: string) => `<label class="dlg-row" style="cursor:pointer;"><span>${t(key)}</span><input id="${id}" type="checkbox" style="width:auto;"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(860px, calc(100vw - 32px));">
      <h3>${icon("candyHolder", 20)}${t("ch.title")}</h3>
      <div class="dlg-hint">${t("ch.desc")}</div>
      <div style="display:grid;grid-template-columns:290px 1fr;gap:12px;align-items:start;">
        <div class="box-fields" style="max-height:62vh;overflow-y:auto;">
          ${sel("ch-build", "ch.build", CANDY_BUILDS, "ch.build.")}
          ${themeSelectHtml("ch-theme", "dlg-row")}
          ${sel("ch-shape", "orn.shape", [], "orn.shape.")}
          <div class="ch-only-star">${num("ch-pts", "orn.points", "1", "5", "")}</div>
          ${sel("ch-topper", "orn.topper", [], "orn.topper.")}
          ${sel("ch-deco", "orn.deco", [], "orn.deco.")}
          ${num("ch-size", "orn.size", "1", "20")}
          ${num("ch-t", "box.t", "0.1", "0.5", "")}
          ${sel("ch-fill", "ch.fill", ["round", "rect"], "ch.fill.")}
          <div class="ch-only-round">${num("ch-d", "ch.diameter", "0.5", "3")}</div>
          <div class="ch-only-rect">${num("ch-w", "ch.fillW", "0.5", "3")}${num("ch-h", "ch.fillH", "0.5", "3")}</div>
          <div class="ch-only-depth">${num("ch-depth", "ch.depth", "0.5", "0.5")}</div>
          ${num("ch-clear", "ch.clearance", "0.05", "0")}
          ${num("ch-count", "ch.count", "1", "1", "")}
          <div class="ch-only-flex">${num("ch-band", "ch.bandLen", "0.5", "4")}</div>
          <label class="dlg-row" style="cursor:pointer;"><span id="ch-bar-label"></span><input id="ch-bar" type="checkbox" style="width:auto;"></label>
          <div class="ch-only-bar">${num("ch-barh", "ch.barH", "0.5", "1")}</div>
          ${sel("ch-hang", "orn.hanger", CANDY_HANGERS, "orn.hang.")}
          <div class="ch-only-hole">${num("ch-hd", "orn.holeD", "0.5", "1")}</div>
          <label class="dlg-row"><span>${t("ch.text")}</span><input id="ch-text" type="text" maxlength="40" style="width:170px;"></label>
          <label class="dlg-row"><span>${t("orn.line2")}</span><input id="ch-line2" type="text" maxlength="40" style="width:170px;" placeholder="${t("orn.line2Ph")}"></label>
          <div class="ch-only-text">
            <label class="dlg-row"><span>${t("text.font")}</span><div id="ch-font" style="width:170px;"></div></label>
            ${chk("ch-bold", "text.bold")}
            ${num("ch-ts", "orn.textSize", "5", "20", "%")}
            ${sel("ch-inner", "ch.inner", CANDY_INNERS, "orn.inner.")}
          </div>
        </div>
        <div class="box-prev" style="min-height:280px;"><div id="ch-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="ch-info" class="dlg-hint"></div>
          <div id="ch-err" class="dlg-hint" style="color:var(--lt-red, #ff6b6b);"></div>
          <div id="ch-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div>
          <div class="dlg-hint ch-only-layers" style="margin-top:6px;">${t("ch.how")}</div>
          <div class="dlg-hint ch-only-flex" style="margin-top:6px;">${t("ch.flex.how")}</div>
          <div class="dlg-hint" style="margin-top:6px;">⚠️ ${t("ch.food")}</div>
          <div class="dlg-hint" style="margin-top:6px;">${t("ch.testPiece")}</div></div>
      </div>
      <div class="dlg-buttons">
        <button id="ch-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="ch-ok" class="btn-primary">✔ ${t("ch.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const selEl = (id: string) => $<HTMLSelectElement>(id);
  let font = init.font;
  createFontPicker($<HTMLElement>("ch-font"), font, f => { font = f; schedule(); });

  // Thema filtert Formen, Aufsätze und Verzierungen; eine gespeicherte Form außerhalb des Themas bleibt wählbar
  const applyTheme = (th: Theme, keep: Partial<CandySettings> = {}) => {
    const shapes: string[] = themeList(th, "shapes");
    if (keep.shape && !shapes.includes(keep.shape)) shapes.push(keep.shape);
    fillSelect(selEl("ch-shape"), shapes, "orn.shape.", keep.shape);
    fillSelect(selEl("ch-topper"), ["none", ...themeList(th, "toppers")], "orn.topper.", keep.topper);
    fillSelect(selEl("ch-deco"), ["none", ...themeList(th, "decos")], "orn.deco.", keep.deco);
  };
  selEl("ch-theme").value = init.theme;
  applyTheme(init.theme, init);
  selEl("ch-theme").addEventListener("change", () => applyTheme(selEl("ch-theme").value as Theme));
  // Werte per value setzen (der Text ist fremder Text – nie ins innerHTML)
  selEl("ch-build").value = init.build; $("ch-band").value = String(init.bandLen);
  $("ch-pts").value = String(init.points); $("ch-size").value = String(init.size); $("ch-t").value = String(init.thickness);
  selEl("ch-fill").value = init.fill; $("ch-d").value = String(init.diameter); $("ch-w").value = String(init.fillW); $("ch-h").value = String(init.fillH);
  $("ch-depth").value = String(init.depth); $("ch-clear").value = String(init.clearance); $("ch-count").value = String(init.count); $("ch-count").max = String(CANDY_MAX_COUNT);
  $("ch-bar").checked = init.bar; $("ch-barh").value = String(init.barH); selEl("ch-hang").value = init.hanger; $("ch-hd").value = String(init.holeD);
  $("ch-text").value = init.text; $("ch-line2").value = init.line2; $("ch-bold").checked = init.bold; $("ch-ts").value = String(init.textSize); selEl("ch-inner").value = init.inner;

  const read = (): CandySettings => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    return candySettings({ build: selEl("ch-build").value, bandLen: n("ch-band", init.bandLen), theme: selEl("ch-theme").value, shape: selEl("ch-shape").value, points: n("ch-pts", init.points), topper: selEl("ch-topper").value, deco: selEl("ch-deco").value,
      size: n("ch-size", init.size), thickness: n("ch-t", init.thickness), fill: selEl("ch-fill").value, diameter: n("ch-d", init.diameter), fillW: n("ch-w", init.fillW), fillH: n("ch-h", init.fillH),
      depth: n("ch-depth", init.depth), clearance: n("ch-clear", init.clearance), count: n("ch-count", init.count), bar: $("ch-bar").checked, barH: n("ch-barh", init.barH),
      hanger: selEl("ch-hang").value, holeD: n("ch-hd", init.holeD), inner: selEl("ch-inner").value, textSize: n("ch-ts", init.textSize), router: getMachineMode() === "mill",
      text: $("ch-text").value, line2: $("ch-line2").value, font, bold: $("ch-bold").checked });
  };
  const show = (cls: string, on: boolean) => ov.querySelectorAll<HTMLElement>(cls).forEach(el => { el.style.display = on ? "" : "none"; });

  let last: CandyResult | null = null, run = 0, timer = 0;
  const update = async () => {
    const o = read(), my = ++run;
    const flex = o.build === "flex";
    show(".ch-only-flex", flex);
    show(".ch-only-layers", !flex);
    show(".ch-only-depth", !flex || o.fill === "rect");
    $<HTMLElement>("ch-bar-label").textContent = t(flex ? "ch.barSide" : "ch.bar");
    show(".ch-only-star", o.shape === "star");
    show(".ch-only-round", o.fill === "round");
    show(".ch-only-rect", o.fill === "rect");
    show(".ch-only-bar", o.bar);
    show(".ch-only-hole", o.hanger !== "none");
    show(".ch-only-text", !!(o.text + o.line2).trim());
    const text = await traceText(o);
    if (my !== run) return; // inzwischen neu eingegeben
    const r = candyHolder(o, text);
    last = r;
    $<HTMLElement>("ch-svg").innerHTML = flex ? previewFlexSvg(r) : previewSvg(r);
    $<HTMLElement>("ch-info").textContent = flex
      ? (r.flex ? t("ch.flex.info", { n: r.parts.length, w: r.flex.width.toFixed(0), l: r.flex.length.toFixed(0), f: r.flex.floor.toFixed(1), h: r.flex.height.toFixed(0) }) : "")
      : t("ch.info", { m: r.middle, n: r.parts.length, mm: r.total.toFixed(1).replace(/\.0$/, ""), w: r.w.toFixed(0), h: r.h.toFixed(0) });
    const errs = r.msgs.filter(m => m.level === "error");
    const lines = errs.map(m => t(m.key, m.vars));
    // nur wenn Größe hilft: passende Höhe vorschlagen
    if (errs.some(m => m.key !== "ch.msg.tooMany")) {
      const s = suggestSize(o);
      if (my !== run) return;
      if (s) lines.push(t("ch.msg.trySize", { s }));
    }
    $<HTMLElement>("ch-err").innerHTML = lines.map(s => `<div>${esc(s)}</div>`).join("");
    $<HTMLElement>("ch-warn").innerHTML = r.msgs.filter(m => m.level === "warn").map(m => `<div>${esc(t(m.key, m.vars))}</div>`).join("");
    $<HTMLButtonElement>("ch-ok").disabled = !r.ok;
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(update, 160); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  update();

  const close = () => { clearTimeout(timer); run++; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("ch-cancel").onclick = close;
  $<HTMLElement>("ch-ok").onclick = async () => {
    clearTimeout(timer);
    await update();
    const r = last;
    if (!r || !r.ok) return;
    const o = read();
    saveSettings(KEY, o);
    close();
    const over = place(r);
    log(r.flex ? t("ch.flex.done", { n: r.parts.length, l: r.flex.length.toFixed(0) }) : t("ch.done", { n: r.parts.length, mm: r.total.toFixed(1).replace(/\.0$/, "") }));
    if (over) log(t("sb.bigger"));
    done();
  };
}

/** Teile in einer Reihe (bei Bedarf umbrechen), je eine Gruppe mit Namen; Schnitt stärkste Linien-Ebene, Gravur Füll-Ebene, Linien schwächste Ebene */
function place(r: CandyResult): boolean {
  const st = app(), bed = bedSizeMm(), layers = getLayers();
  const lineL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power);
  const cutL = lineL[0], markL = lineL[lineL.length - 1], engL = layers.find(l => l.mode === "fill");
  const made: any[] = [];
  let x = 10, y = 10, rowH = 0;
  for (const p of r.parts) {
    const b = bounds(p.cut), w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (x > 10 && x + w > bed.w - 5) { x = 10; y += rowH + 8; rowH = 0; }
    const dx = x - b.x0, dy = y - b.y0, groupId = "candy-" + newId();
    const source = (p.kind === "middle" ? t("ch.part.middle", { i: p.index + 1, n: r.middle }) : p.kind === "sideBar" ? t("ch.part.sideBar", { i: p.index + 1 }) : t("ch.part." + p.kind)).slice(0, 40);
    const px = (m: MultiPolygon): MultiPolygon => m.map(q => q.map(rg => rg.map(([qx, qy]) => [(qx + dx) * MM_TO_PIXEL, (qy + dy) * MM_TO_PIXEL] as [number, number])));
    made.push(...toShapes(px(p.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    made.push(...toShapes(px(p.engrave), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, source, millingMode: "pocket", millingDepth: -0.5 })));
    for (const l of p.lines) made.push(createPolyline(l.pts.map(([qx, qy]) => ({ x: (qx + dx) * MM_TO_PIXEL, y: (qy + dy) * MM_TO_PIXEL })), l.closed, "on-line",
      { ...(markL ? { laserLayerId: markL.id } : {}), millingDepth: -0.3, isScore: true, groupId, source }));
    // Schnitte der Biegezonen: offene Linien auf der Schnitt-Ebene
    for (const l of p.slits || []) made.push(createPolyline(l.pts.map(([qx, qy]) => ({ x: (qx + dx) * MM_TO_PIXEL, y: (qy + dy) * MM_TO_PIXEL })), false, "on-line",
      { ...(cutL ? { laserLayerId: cutL.id } : {}), groupId, source }));
    x += w + 8; rowH = Math.max(rowH, h);
  }
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
  return y + rowH > bed.h;
}
