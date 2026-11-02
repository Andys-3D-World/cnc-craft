/**
 * SCHATTENBOX / LICHTBOGEN – Fenster (Generatoren): Umriss, Größe, Anzahl Schichten, Landschaft (🎲 neu würfeln),
 * Sterne/Mond, Schleife, Standfuß mit Schlitzen. Vorschau zeigt alle Schichten übereinander wie fertig gebaut.
 * „Aufs Bett“ legt alle Teile nebeneinander (jedes eine Gruppe). Geometrie: shadowBox.ts.
 */
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { t } from "../i18n/i18n";
import { bounds, union } from "../nameConnect";
import { SCENE_KINDS, type SceneKind } from "../landscape";
import { shadowBox, BOX_SHAPES, type BoxShape, type Sky, type ShadowBoxOptions, type ShadowBoxResult } from "../shadowBox";

const KEY = "cnc_craft_shadowbox";
const DEF: ShadowBoxOptions = { shape: "bell", h: 220, layers: 3, frame: 9, scene: "village", seed: 1, sky: "engrave", bow: true, stand: true, t: 3, gap: 6, cable: true };
const SKIES: Sky[] = ["engrave", "cut", "none"];
const SCENES = SCENE_KINDS.filter(k => k !== "none");

function load(): ShadowBoxOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: ShadowBoxOptions = { ...DEF };
    for (const k of ["h", "layers", "frame", "seed", "t", "gap"] as const) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    for (const k of ["bow", "stand", "cable"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    if (BOX_SHAPES.includes(s.shape)) o.shape = s.shape;
    if (SCENES.includes(s.scene)) o.scene = s.scene;
    if (SKIES.includes(s.sky)) o.sky = s.sky;
    return o;
  } catch { return { ...DEF }; }
}

/** Vorschau: Grundplatte hinten, Schichten davor (vorn heller), daneben der Fuß von oben */
function previewSvg(r: ShadowBoxResult): string {
  const all = bounds(union([r.back, ...r.layers]));
  const fb = r.foot.length ? bounds(r.foot) : null;
  const gap = 12, fx = all.x1 + gap - (fb ? fb.x0 : 0);
  const W = all.x1 - all.x0 + (fb ? gap + (fb.x1 - fb.x0) : 0), H = all.y1 - all.y0;
  const tf = (x: number, y: number) => `${(x - all.x0 + 2).toFixed(2)},${(all.y1 - y + 2).toFixed(2)}`;
  const d = (m: MultiPolygon, dx = 0, dy = 0) => m.map(p => p.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${tf(x + dx, y + dy)}`).join("") + "Z").join("")).join("");
  const n = r.layers.length;
  const shade = (i: number) => { const k = n > 1 ? 1 - i / (n - 1) : 1; return `rgb(${Math.round(150 + 80 * k)},${Math.round(105 + 85 * k)},${Math.round(60 + 80 * k)})`; };
  const sw = (Math.max(W, H) / 400).toFixed(2);
  return `<svg viewBox="0 0 ${(W + 4).toFixed(1)} ${(H + 4).toFixed(1)}" style="width:100%;max-height:330px;">
    <path d="${d(r.back)}" fill="#2c3550" fill-rule="evenodd" stroke="#1a1f30" stroke-width="${sw}"/>
    <path d="${d(r.backEngrave)}" fill="#f2d98a" fill-rule="evenodd"/>
    ${r.layers.map((_, i) => i).reverse().map(i => `<path d="${d(r.layers[i])}" fill="${shade(i)}" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${sw}"/>`).join("")}
    ${fb ? `<path d="${d(r.foot, fx, all.y0 - fb.y0)}" fill="#c98a4b" fill-rule="evenodd" stroke="#5a3a1c" stroke-width="${sw}"/>` : ""}</svg>`;
}

export function openShadowBoxDialog(log: (s: string) => void, done: () => void) {
  const o = load();
  document.getElementById("sbox-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "sbox-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, v: number, step = "1", min = "0") =>
    `<label class="prop-row">${t(key)}<input id="${id}" type="number" step="${step}" min="${min}" value="${v}" class="prop-input"></label>`;
  const sel = (id: string, key: string, list: string[], prefix: string) =>
    `<label class="prop-row">${t(key)}<select id="${id}" class="prop-input" style="width:auto;">${list.map(k => `<option value="${k}">${t(prefix + k)}</option>`).join("")}</select></label>`;
  const chk = (id: string, key: string, on: boolean) =>
    `<label class="prop-row" style="cursor:pointer;"><span>${t(key)}</span><input id="${id}" type="checkbox" ${on ? "checked" : ""} style="width:auto;"></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(760px, calc(100vw - 32px));">
      <h3>🏠 ${t("sb.title")}</h3>
      <div class="dlg-hint">${t("sb.desc")}</div>
      <div class="box-grid">
        <div class="box-fields">
          ${sel("sb-shape", "sb.shape", BOX_SHAPES, "sb.shape.")}
          ${num("sb-h", "sb.h", o.h, "5", "60")}
          ${num("sb-layers", "sb.layers", o.layers, "1", "1")}
          ${num("sb-frame", "sb.frame", o.frame, "0.5", "3")}
          ${sel("sb-scene", "sb.scene", SCENES, "orn.scene.")}
          <button id="sb-dice" class="btn-secondary" type="button" style="width:100%;margin:2px 0 6px;">🎲 ${t("orn.dice")}</button>
          ${sel("sb-sky", "sb.sky", SKIES, "sb.sky.")}
          ${chk("sb-bow", "sb.bow", o.bow)}
          ${chk("sb-cable", "sb.cable", o.cable)}
          ${chk("sb-stand", "sb.stand", o.stand)}
          <div class="sb-only-stand">${num("sb-t", "box.t", o.t, "0.1", "1")}${num("sb-gap", "sb.gap", o.gap, "0.5", "0")}</div>
        </div>
        <div class="box-prev"><div id="sb-svg" style="flex:1;display:flex;align-items:center;"></div><div id="sb-info" class="dlg-hint"></div></div>
      </div>
      <div class="dlg-hint">${t("sb.hint")}</div>
      <div class="dlg-buttons">
        <button id="sb-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="sb-ok" class="btn-primary">✔ ${t("sb.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  $<HTMLSelectElement>("sb-shape").value = o.shape; $<HTMLSelectElement>("sb-scene").value = o.scene; $<HTMLSelectElement>("sb-sky").value = o.sky;

  const read = (): ShadowBoxOptions => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return { shape: $<HTMLSelectElement>("sb-shape").value as BoxShape, h: n("sb-h", o.h, 60, 1000), layers: Math.round(n("sb-layers", o.layers, 1, 6)),
      frame: n("sb-frame", o.frame, 3, 50), scene: $<HTMLSelectElement>("sb-scene").value as SceneKind, seed: o.seed,
      sky: $<HTMLSelectElement>("sb-sky").value as Sky, bow: $("sb-bow").checked, stand: $("sb-stand").checked,
      t: n("sb-t", o.t, 1, 20), gap: n("sb-gap", o.gap, 0, 50), cable: $("sb-cable").checked };
  };
  let timer = 0;
  const preview = () => {
    const p = read();
    ov.querySelectorAll<HTMLElement>(".sb-only-stand").forEach(el => { el.style.display = p.stand ? "" : "none"; });
    const r = shadowBox(p);
    $<HTMLElement>("sb-svg").innerHTML = previewSvg(r);
    const bb = bounds(r.back);
    $<HTMLElement>("sb-info").textContent = t("sb.info", { n: r.layers.length + 1 + (r.foot.length ? 1 : 0), w: (bb.x1 - bb.x0).toFixed(0), h: (bb.y1 - Math.max(bb.y0, 0)).toFixed(0) });
  };
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(preview, 150); };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", schedule));
  $<HTMLElement>("sb-dice").onclick = () => { o.seed = 1 + Math.floor(Math.random() * 99999); schedule(); };
  preview();

  const close = () => { clearTimeout(timer); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("sb-cancel").onclick = close;
  $<HTMLElement>("sb-ok").onclick = () => {
    const p = read();
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* egal */ }
    close();
    const r = shadowBox(p);
    const { n, over } = place(r);
    log(t("sb.done", { n }));
    if (over) log(t("sb.bigger"));
    done();
  };
}

/** Teile in einer Reihe (bei Bedarf umbrechen), links unten mit 10 mm Rand; Schnitt stärkste Linien-Ebene, Sterne Füll-Ebene */
function place(r: ShadowBoxResult): { n: number; over: boolean } {
  const st = app(), bed = bedSizeMm(), layers = getLayers();
  const cutL = layers.filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  const engL = layers.find(l => l.mode === "fill");
  const source = t("sb.title");
  const parts: { cut: MultiPolygon; eng: MultiPolygon }[] = [...r.layers.map(l => ({ cut: l, eng: [] as MultiPolygon })), { cut: r.back, eng: r.backEngrave }];
  if (r.foot.length) parts.push({ cut: r.foot, eng: [] });
  const made: any[] = [];
  let x = 10, y = 10, rowH = 0;
  for (const p of parts) {
    const b = bounds(p.cut), w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (x > 10 && x + w > bed.w - 5) { x = 10; y += rowH + 8; rowH = 0; }
    const dx = x - b.x0, dy = y - b.y0, groupId = "sbox-" + newId();
    const px = (m: MultiPolygon): MultiPolygon => m.map(q => q.map(rg => rg.map(([qx, qy]) => [(qx + dx) * MM_TO_PIXEL, (qy + dy) * MM_TO_PIXEL] as [number, number])));
    made.push(...toShapes(px(p.cut), cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
    made.push(...toShapes(px(p.eng), engL ? { laserLayerId: engL.id } : {}).map(s => ({ ...s, groupId, source, millingMode: "pocket", millingDepth: -0.5 })));
    x += w + 8; rowH = Math.max(rowH, h);
  }
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
  return { n: parts.length, over: y + rowH > bed.h };
}
