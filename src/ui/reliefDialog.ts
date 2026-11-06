/**
 * RELIEF-DIALOG (Fräse): aus einem Bild oder aus geschlossenen Konturen eine Reliefoberfläche machen.
 * Links die Werte, rechts die 3D-Ansicht (rechnet bei jeder Änderung auf einem kleinen Raster neu).
 * „Weiter“ rechnet das volle Raster im Hintergrund und öffnet den normalen 3D-Fräsen-Dialog (cam3dDialog.ts):
 * Schruppen, Schlichten, Simulation, Einrichteblatt und Warnungen sind dieselben wie bei einem STL-Modell.
 */
import { t } from "../i18n/i18n";
import { state } from "../main";
import { isLaser, isPlasma } from "../machineMode";
import { isClosedShape, shapeToPaths, MM_TO_PIXEL } from "../shapeTransform";
import { loadImage, toGray } from "../importers/imageTrace";
import { Viewer3D, Mesh } from "../view3d/viewer3d";
import { openCam3D } from "./cam3dDialog";
import { HeightField, fieldPreviewTris, fieldRange, gridFor } from "../relief/heightField.ts";
import { grayToField, resampleGray, DEFAULT_IMAGE_RELIEF } from "../relief/imageRelief.ts";
import { VPt, loopBounds, loopsToField, ReliefProfile } from "../relief/vectorRelief.ts";
import { ReliefBuilt, ReliefJob, buildRelief } from "../relief/reliefBuild.ts";

const KEY = "cnc_craft_relief";
const PREVIEW_CELLS = 240;
const DETAIL: Record<string, number> = { low: 300, mid: 600, high: 1000 };

interface Vals {
  w: number; h: number; keep: boolean; depth: number; base: number; invert: boolean; smooth: number; contrast: number; gamma: number;
  border: number; fade: number; fadeTo: "top" | "bottom"; detail: string;
  vHeight: number; vProfile: ReliefProfile; vWidth: number; vPad: number; vSmooth: number;
}

const defaults = (): Vals => ({
  w: 100, h: 100, keep: true, ...DEFAULT_IMAGE_RELIEF, base: 3, detail: "mid",
  vHeight: 4, vProfile: "round", vWidth: 1.5, vPad: 4, vSmooth: 0
});

function loadVals(): Vals {
  const o = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of Object.keys(o) as (keyof Vals)[]) if (typeof s[k] === typeof o[k]) (o as any)[k] = s[k];
  } catch { /* Standard */ }
  if (!(o.detail in DETAIL)) o.detail = "mid";
  if (!["round", "slope", "dome"].includes(o.vProfile)) o.vProfile = "round";
  if (o.fadeTo !== "bottom") o.fadeTo = "top";
  return o;
}

/** Volles Raster im Hintergrund; startet kein Worker, wird im Hauptfenster gerechnet */
function runFull(job: ReliefJob, onWorker: (w: Worker) => void): Promise<ReliefBuilt | null> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL("../relief/reliefWorker.ts", import.meta.url), { type: "module" });
    } catch {
      try { resolve(buildRelief(job)); } catch (e) { reject(e); }
      return;
    }
    onWorker(w);
    w.onmessage = ev => { w.terminate(); if (ev.data.ok) resolve(ev.data.r); else reject(new Error(ev.data.error)); };
    w.onerror = e => { w.terminate(); reject(new Error(e.message || "worker")); };
    w.postMessage(job);
  });
}

/** Dreiecke → Anzeige; die Oberfläche (die ersten top Werte) bekommt weiche Normalen aus dem Feld */
function viewMesh(tris: Float32Array, f: HeightField, topLen: number, lift: number): Mesh {
  const dx = f.w / (f.nx - 1), dy = f.h / (f.ny - 1);
  const pos = new Array<number>(tris.length), nrm = new Array<number>(tris.length);
  const Z = (i: number, j: number) => f.z[Math.max(0, Math.min(f.ny - 1, j)) * f.nx + Math.max(0, Math.min(f.nx - 1, i))];
  for (let k = 0; k < tris.length; k += 9) {
    let flat: number[] | null = null;
    for (let c = 0; c < 9; c += 3) {
      const x = tris[k + c], y = tris[k + c + 1], z = tris[k + c + 2];
      pos[k + c] = x; pos[k + c + 1] = y; pos[k + c + 2] = z + lift;
      let n: number[];
      if (k < topLen) {
        const i = Math.round(x / dx), j = Math.round(y / dy);
        n = [-(Z(i + 1, j) - Z(i - 1, j)) / (2 * dx), -(Z(i, j + 1) - Z(i, j - 1)) / (2 * dy), 1];
      } else {
        if (!flat) {
          const u = [tris[k + 3] - tris[k], tris[k + 4] - tris[k + 1], tris[k + 5] - tris[k + 2]], v = [tris[k + 6] - tris[k], tris[k + 7] - tris[k + 1], tris[k + 8] - tris[k + 2]];
          flat = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        }
        n = flat;
      }
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      nrm[k + c] = n[0] / l; nrm[k + c + 1] = n[1] / l; nrm[k + c + 2] = n[2] / l;
    }
  }
  return { pos, nrm, color: [0.78, 0.62, 0.42] };
}

interface Source {
  title: string;
  name: string;
  hint: string;
  form: (num: (id: string, label: string, unit?: string, step?: string, tip?: string) => string) => string;
  /** kleines Raster für die Ansicht */
  preview: (o: Vals) => { field: HeightField; flat: boolean } | null;
  full: (o: Vals) => ReliefJob;
  /** Felder: id → Wert */
  fields: [string, keyof Vals, number, number][];
  info: (o: Vals) => { w: number; h: number };
  aspect?: number;
}

function openDialog(src: Source, log: (s: string) => void) {
  document.getElementById("rlf-overlay")?.remove();
  const o = loadVals();
  if (src.aspect) { o.h = +(o.w / src.aspect).toFixed(2); }
  const num = (id: string, label: string, unit = "mm", step = "0.1", tip = "") =>
    `<div class="dlg-row"${tip ? ` data-tip="${tip.replace(/"/g, "&quot;")}"` : ""}><span>${label}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
  const ov = document.createElement("div");
  ov.id = "rlf-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1000px, calc(100vw - 32px));">
      <h3>🏔 ${t(src.title)} <span class="dlg-hint" id="rlf-name" style="font-weight:400;"></span></h3>
      <div class="c3d-grid">
        <div class="c3d-form">
          ${src.hint ? `<div class="mat-beta">${t(src.hint)}</div>` : ""}
          ${src.form(num)}
          <div class="dlg-row"><span>${t("rlf.detail")}</span><select id="rlf-detail" class="prop-input" style="width:auto;">
            <option value="low">${t("rlf.detail.low")}</option><option value="mid">${t("rlf.detail.mid")}</option><option value="high">${t("rlf.detail.high")}</option></select></div>
          <div class="dlg-hint" id="rlf-size"></div>
        </div>
        <div class="c3d-view">
          <canvas id="rlf-cv"></canvas>
          <div id="rlf-warn" class="mat-beta" style="display:none;"></div>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="rlf-next" class="btn-primary">▶ ${t("rlf.next")}</button>
        <button id="rlf-close" class="btn-secondary" style="margin-left:auto;">${t("dlg.close")}</button>
      </div>
    </div>`;
  (ov.querySelector("#rlf-name") as HTMLElement).textContent = src.name;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const viewer = new Viewer3D($<HTMLCanvasElement>("rlf-cv"));
  const warn = $<HTMLElement>("rlf-warn");
  let worker: Worker | null = null, closed = false, first = true, timer = 0, flatNow = false;

  const fill = () => {
    for (const [id, k] of src.fields) { const e = $(id); if (e) e.value = String(o[k]); }
    for (const [id, k] of [["rlf-keep", "keep"], ["rlf-invert", "invert"]] as [string, keyof Vals][]) { const e = $(id); if (e) e.checked = !!o[k]; }
    for (const [id, k] of [["rlf-fadeto", "fadeTo"], ["rlf-profile", "vProfile"], ["rlf-detail", "detail"]] as [string, keyof Vals][]) {
      const e = $<HTMLSelectElement>(id); if (e) e.value = String(o[k]);
    }
  };
  const draw = () => {
    if (closed) return;
    const p = src.preview(o);
    if (!p) return;
    flatNow = p.flat;
    const range = fieldRange(p.field), thick = range + o.base;
    const tris = fieldPreviewTris(p.field, -thick);
    viewer.setMeshes([viewMesh(tris, p.field, (p.field.nx - 1) * (p.field.ny - 1) * 18, thick)], !first);
    first = false;
    const s = src.info(o), g = gridFor(s.w, s.h, DETAIL[o.detail]);
    $<HTMLElement>("rlf-size").textContent = t("rlf.sizeInfo", { w: s.w.toFixed(1), h: s.h.toFixed(1), d: range.toFixed(2), t: thick.toFixed(2), nx: g.nx, ny: g.ny });
    warn.style.display = flatNow ? "" : "none";
    warn.textContent = flatNow ? t("rlf.flat") : "";
  };
  const later = () => {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    clearTimeout(timer);
    timer = window.setTimeout(draw, 60);
  };
  for (const [id, k, lo, hi] of src.fields) $(id)?.addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v) || v < lo || v > hi) return;     // beim Tippen nichts verwerfen; beim Verlassen zurücksetzen
    const old = o[k] as number;
    (o as any)[k] = v;
    if (o.keep && src.aspect && (k === "w" || k === "h")) {
      if (k === "w") { o.h = +(v / src.aspect).toFixed(2); $("rlf-h").value = String(o.h); }
      else { o.w = +(v * src.aspect).toFixed(2); $("rlf-w").value = String(o.w); }
    }
    if (old !== v) later();
  });
  for (const [id] of src.fields) $(id)?.addEventListener("change", fill);
  for (const [id, k] of [["rlf-keep", "keep"], ["rlf-invert", "invert"]] as [string, keyof Vals][]) $(id)?.addEventListener("change", () => {
    (o as any)[k] = $(id).checked;
    if (k === "keep" && o.keep && src.aspect) { o.h = +(o.w / src.aspect).toFixed(2); fill(); }
    later();
  });
  for (const [id, k] of [["rlf-fadeto", "fadeTo"], ["rlf-profile", "vProfile"], ["rlf-detail", "detail"]] as [string, keyof Vals][]) $(id)?.addEventListener("change", () => {
    (o as any)[k] = $<HTMLSelectElement>(id).value;
    later();
  });

  const close = () => {
    closed = true;
    clearTimeout(timer);
    worker?.terminate();
    viewer.destroy();
    ov.remove();
  };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("rlf-close").onclick = close;
  $("rlf-next").onclick = async () => {
    if (flatNow) { warn.style.display = ""; warn.textContent = t("rlf.flat"); return; }
    const btn = $<HTMLButtonElement>("rlf-next");
    btn.disabled = true;
    btn.textContent = t("rlf.building");
    try {
      const r = await runFull(src.full(o), w => { worker = w; });
      if (closed || !r) return;
      const p = src.preview(o);
      const thick = fieldRange(r.field) + o.base;
      const preview = fieldPreviewTris(p ? p.field : r.field, -thick);
      const place = src.full(o).kind === "vector" ? { x0: +r.x0.toFixed(2), y0: +r.y0.toFixed(2) } : {};
      close();
      openCam3D(src.name, r.pos, log, { ...place, thick: +thick.toFixed(2), preview, field: r.field });
    } catch (e) {
      if (closed) return;
      btn.disabled = false;
      btn.textContent = "▶ " + t("rlf.next");
      warn.style.display = "";
      warn.textContent = t("rlf.error", { e: String((e as any)?.message ?? e) });
    }
  };
  fill();
  draw();
}

/** Bild als Relief (aus dem Import) */
export async function openReliefFromImage(name: string, bytes: Uint8Array, log: (s: string) => void) {
  const img = await loadImage(name, bytes);
  const { gray: raw, W, H } = toGray(img);
  const gray = new Float32Array(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = raw[i] / 255;
  // kleine Kopie für die Ansicht: bleibt flüssig, auch bei großen Fotos
  const k = Math.min(1, 480 / Math.max(W, H));
  const pw = Math.max(2, Math.round(W * k)), ph = Math.max(2, Math.round(H * k));
  const small = resampleGray(gray, W, H, pw, ph);
  const jobOpts = (o: Vals, long: number) => {
    const { nx, ny } = gridFor(o.w, o.h, long);
    return { w: o.w, h: o.h, nx, ny, depth: o.depth, invert: o.invert, smooth: o.smooth, contrast: o.contrast, gamma: o.gamma, border: o.border, fade: o.fade, fadeTo: o.fadeTo };
  };
  openDialog({
    title: "rlf.titleImage", name, hint: "rlf.honest", aspect: W / H,
    form: num => `
      <div class="c3d-sec">${t("rlf.secSize")}</div>
      ${num("rlf-w", t("rlf.width"))}${num("rlf-h", t("rlf.height"))}
      <label class="eng-ck"><input type="checkbox" id="rlf-keep"> ${t("rlf.keep")}</label>
      <div class="c3d-sec">${t("rlf.secHeight")}</div>
      ${num("rlf-depth", t("rlf.depth"))}${num("rlf-base", t("rlf.base"), "mm", "0.5", t("rlf.baseTip"))}
      <label class="eng-ck"><input type="checkbox" id="rlf-invert"> ${t("rlf.invert")}</label>
      ${num("rlf-smooth", t("rlf.smooth"), "mm", "0.1", t("rlf.smoothTip"))}
      ${num("rlf-contrast", t("rlf.contrast"), "", "0.1")}${num("rlf-gamma", t("rlf.gamma"), "", "0.1", t("rlf.gammaTip"))}
      <div class="c3d-sec">${t("rlf.secEdge")}</div>
      ${num("rlf-border", t("rlf.border"), "mm", "0.5", t("rlf.borderTip"))}${num("rlf-fade", t("rlf.fade"), "mm", "0.5", t("rlf.fadeTip"))}
      <div class="dlg-row"><span>${t("rlf.fadeTo")}</span><select id="rlf-fadeto" class="prop-input" style="width:auto;">
        <option value="top">${t("rlf.fadeTo.top")}</option><option value="bottom">${t("rlf.fadeTo.bottom")}</option></select></div>`,
    fields: [["rlf-w", "w", 1, 5000], ["rlf-h", "h", 1, 5000], ["rlf-depth", "depth", 0.01, 200], ["rlf-base", "base", 0, 500], ["rlf-smooth", "smooth", 0, 50],
      ["rlf-contrast", "contrast", 0.2, 5], ["rlf-gamma", "gamma", 0.2, 5], ["rlf-border", "border", 0, 500], ["rlf-fade", "fade", 0, 500]],
    preview: o => grayToField(small, pw, ph, jobOpts(o, PREVIEW_CELLS)),
    full: o => ({ kind: "image", gray, sw: W, sh: H, opts: jobOpts(o, DETAIL[o.detail]) }),
    info: o => ({ w: o.w, h: o.h })
  }, log);
}

/** Ausgewählte geschlossene Formen als erhabenes Relief */
export function openReliefFromSelection(log: (s: string) => void) {
  if (isLaser() || isPlasma()) { log(t("rlf.onlyMill")); return; }
  const ids = new Set(state.selectedShapeIds);
  const loops: VPt[][] = [];
  let open = 0;
  for (const s of state.shapes as any[]) {
    if (!ids.has(s.id)) continue;
    if (!isClosedShape(s)) { if (s.type !== "image") open++; continue; }
    for (const p of shapeToPaths(s)) loops.push(p.pts.map(q => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL })));
  }
  if (!loops.length) { log(t("rlf.noClosed")); return; }
  if (open) log(t("rlf.openSkipped", { n: open }));
  const b = loopBounds(loops);
  const opts = (o: Vals, long: number) => ({ height: o.vHeight, profile: o.vProfile, width: o.vWidth, pad: o.vPad, smooth: o.vSmooth, long });
  openDialog({
    title: "rlf.titleVector", name: t("rlf.vectorName"), hint: "",
    form: num => `
      <div class="dlg-hint">${t("rlf.vectorHint")}</div>
      ${num("rlf-vheight", t("rlf.vHeight"))}${num("rlf-base", t("rlf.base"), "mm", "0.5", t("rlf.baseTip"))}
      <div class="dlg-row"><span>${t("rlf.profile")}</span><select id="rlf-profile" class="prop-input" style="width:auto;">
        <option value="round">${t("rlf.profile.round")}</option><option value="slope">${t("rlf.profile.slope")}</option><option value="dome">${t("rlf.profile.dome")}</option></select></div>
      ${num("rlf-vwidth", t("rlf.vWidth"), "mm", "0.1", t("rlf.vWidthTip"))}
      ${num("rlf-vsmooth", t("rlf.smooth"), "mm", "0.1", t("rlf.vSmoothTip"))}
      ${num("rlf-vpad", t("rlf.vPad"), "mm", "0.5", t("rlf.vPadTip"))}`,
    fields: [["rlf-vheight", "vHeight", 0.01, 200], ["rlf-base", "base", 0, 500], ["rlf-vwidth", "vWidth", 0, 500], ["rlf-vsmooth", "vSmooth", 0, 50], ["rlf-vpad", "vPad", 0, 500]],
    preview: o => loopsToField(loops, opts(o, PREVIEW_CELLS)),
    full: o => ({ kind: "vector", loops, opts: opts(o, DETAIL[o.detail]) }),
    info: o => ({ w: b.x1 - b.x0 + 2 * o.vPad, h: b.y1 - b.y0 + 2 * o.vPad })
  }, log);
}
