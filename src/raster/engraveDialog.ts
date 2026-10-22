/**
 * FENSTER „BILDGRAVUR“: Gravurtyp wählen, automatisch verbessern, Regler, Rasterverfahren, Linienabstand.
 *
 * Links die Vorschau mit Trennlinie (links Original, rechts das gerasterte Ergebnis – Linie ziehen zum Vergleichen),
 * Ansicht „Ganzes Bild“ oder 100/200/400 % (dann mit der Maus verschieben).
 * Gerechnet wird mit denselben Funktionen wie für den G-Code – die Vorschau zeigt genau, was gelasert wird.
 */
import { t } from "../i18n/i18n";
import { layerForShape } from "../laserLayers";
import { Adjust, NO_ADJUST, ENGRAVE_PRESETS, EngravePreset, RASTER_METHODS, CELL_METHODS, RasterMethod, presetSettings, autoAdjust, applyAdjust, resample, stats, curveLut, curveIsIdentity } from "./dither";
import { ImageSettings, imageSizeMm, gridSize, processed, sourceGray } from "./imageShape";

const ICON: Record<EngravePreset, string> = { photo: "📷", graphic: "🎨", bw: "◐", lines: "〰️", dots: "⠿", newspaper: "📰" };
/** Bildeffekte als eigene Knöpfe (Verfahren + Zellgröße) */
const FX: [RasterMethod, string, number][] = [["stipple", "∴", 5], ["spiral", "🌀", 5], ["waves", "≈", 6], ["crosshatch", "▦", 6]];

/** Meldungen in die Konsole (wird beim Start gesetzt, main.ts) */
let defaultLog: (s: string) => void = () => {};
export function setEngraveLog(fn: (s: string) => void) { defaultLog = fn; }

export function openEngraveDialog(shape: any, log: (s: string) => void = defaultLog, onDone: () => void = () => {}) {
  if (shape?.type !== "image" || !shape.img) return;
  const src = sourceGray(shape.img);
  if (!src) { log(t("eng.loading")); return; }
  const img: ImageSettings = JSON.parse(JSON.stringify(shape.img));
  // Vorschau-Form: gleiche Ecken, eigener Zwischenspeicher
  const preview = { id: "__engrave_preview", type: "image", points: shape.points, img };
  const size = imageSizeMm(shape);
  // kleine Fassung des Quellbilds für Bewertung und „automatisch“
  const sk = Math.min(1, 320 / Math.max(src.w, src.h));
  const sw = Math.max(1, Math.round(src.w * sk)), sh = Math.max(1, Math.round(src.h * sk));
  const small = resample(src.gray, src.w, src.h, sw, sh);
  const original = new Image();
  original.src = img.src;

  document.getElementById("eng-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "eng-dialog-overlay";
  ov.className = "dlg-overlay";
  const slider = (id: string, key: string, min: number, max: number, step: number) =>
    `<label class="eng-sl"><span>${t(key)} <b id="${id}-v"></b></span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}"></label>`;
  ov.innerHTML = `
    <div class="dlg-box eng-box" role="dialog">
      <h3>🖼️ ${t("eng.title")} <span class="eng-file"></span></h3>
      <div class="eng-grid">
        <div class="eng-left">
          <canvas id="eng-cv" class="eng-cv"></canvas>
          <div class="eng-row">
            <span>${t("eng.zoom")}</span>
            <select id="eng-zoom" class="prop-input" style="width:auto;">
              <option value="0">${t("eng.zFit")}</option><option value="1">100 %</option><option value="2">200 %</option><option value="4">400 %</option>
            </select>
            <span class="eng-info" id="eng-info"></span>
          </div>
          <div class="dlg-hint">${t("eng.hint")}</div>
        </div>
        <div class="eng-right">
          <div class="eng-h">${t("eng.type")}</div>
          <div class="eng-presets">${ENGRAVE_PRESETS.map(p => `<button type="button" class="eng-pre" data-p="${p}"><span>${ICON[p]}</span>${t("eng.p." + p)}</button>`).join("")}</div>
          <div class="dlg-hint" id="eng-pdesc"></div>
          <div class="eng-h">${t("eng.effects")}</div>
          <div class="eng-presets eng-fx">${FX.map(([m, ic]) => `<button type="button" class="eng-pre" data-m="${m}"><span>${ic}</span>${t("eng.m." + m)}</button>`).join("")}</div>
          <div class="eng-row">
            <button type="button" id="eng-auto" class="btn-primary" style="flex:2;">${t("eng.auto")}</button>
            <button type="button" id="eng-reset" class="btn-secondary" style="flex:1;">${t("eng.reset")}</button>
          </div>
          <div class="eng-rating" id="eng-rating"></div>
          <div class="eng-sec">
            <label class="eng-ck"><input id="eng-bg" type="checkbox"> ${t("eng.bg")}</label>
            <div id="eng-bg-tol">${slider("eng-bgt", "eng.bgTol", 1, 100, 1)}</div>
            <div class="eng-row" id="eng-mask-row"><span>✂️ ${t("eng.maskOn")}</span><button type="button" id="eng-mask-off" class="btn-secondary" style="margin-left:auto;">${t("eng.maskOff")}</button></div>
          </div>
          <details class="eng-sec" open><summary>${t("eng.adjust")}</summary>
            ${slider("eng-br", "eng.brightness", -100, 100, 1)}
            ${slider("eng-ct", "eng.contrast", -100, 100, 1)}
            ${slider("eng-ga", "eng.gamma", 0.3, 3, 0.05)}
            ${slider("eng-sh", "eng.sharpen", 0, 100, 1)}
            ${slider("eng-dn", "eng.denoise", 0, 3, 1)}
            ${slider("eng-bk", "eng.black", 0, 100, 1)}
            ${slider("eng-wh", "eng.white", 0, 100, 1)}
            <label class="eng-ck"><input id="eng-inv" type="checkbox"> ${t("eng.invert")}</label>
          </details>
          <details class="eng-sec" id="eng-curve-sec"><summary>${t("eng.curve")}</summary>
            <canvas id="eng-curve" class="eng-curve" width="300" height="220"></canvas>
            <div class="eng-row">
              <button type="button" class="btn-secondary btn-compact" data-curve="s">${t("eng.curveS")}</button>
              <button type="button" class="btn-secondary btn-compact" data-curve="light">${t("eng.curveLight")}</button>
              <button type="button" class="btn-secondary btn-compact" data-curve="reset">${t("eng.curveReset")}</button>
            </div>
            <div class="dlg-hint">${t("eng.curveHint")}</div>
          </details>
          <details class="eng-sec"><summary>${t("eng.expert")}</summary>
            <label class="prop-row">${t("eng.method")}
              <select id="eng-m" class="prop-input" style="width:auto;">${RASTER_METHODS.map(m => `<option value="${m}">${t("eng.m." + m)}</option>`).join("")}</select></label>
            <div data-for="${CELL_METHODS.join(" ")}">${slider("eng-cell", "eng.cell", 2, 20, 1)}${slider("eng-ang", "eng.angle", 0, 90, 1)}</div>
            <div data-for="threshold">${slider("eng-thr", "eng.threshold", 1, 99, 1)}</div>
          </details>
          <details class="eng-sec" open><summary>${t("eng.output")}</summary>
            <label class="prop-row">${t("eng.interval")} <span class="eng-dpi" id="eng-dpi"></span>
              <input id="eng-int" type="number" min="0.03" max="1" step="0.01" class="prop-input" style="width:80px;"></label>
            <label class="prop-row" data-for="gray">${t("eng.minPower")}
              <input id="eng-min" type="number" min="0" max="100" step="1" class="prop-input" style="width:80px;"></label>
            <label class="prop-row">${t("eng.overscan")}
              <input id="eng-over" type="number" min="0" max="20" step="0.5" class="prop-input" style="width:80px;"></label>
          </details>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="eng-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="eng-ok" class="btn-primary">✔ ${t("eng.apply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  (ov.querySelector(".eng-file") as HTMLElement).textContent = shape.source || "";
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;

  // ---- Werte ins Fenster / aus dem Fenster ----
  const A = (): Adjust => ({ ...NO_ADJUST, ...img.adjust });
  const fill = () => {
    const a = A();
    const set = (id: string, v: number, txt: string) => { $(id).value = String(v); $(id + "-v").textContent = txt; };
    set("eng-br", a.brightness, String(a.brightness));
    set("eng-ct", a.contrast, String(a.contrast));
    set("eng-ga", a.gamma, a.gamma.toFixed(2));
    set("eng-sh", a.sharpen, String(a.sharpen));
    set("eng-dn", a.denoise, String(a.denoise));
    set("eng-bk", Math.round(a.black * 100), String(Math.round(a.black * 100)));
    set("eng-wh", Math.round(a.white * 100), String(Math.round(a.white * 100)));
    $("eng-inv").checked = a.invert;
    $<HTMLSelectElement>("eng-m").value = img.raster.method;
    set("eng-cell", img.raster.cell, String(img.raster.cell));
    set("eng-ang", img.raster.angle, img.raster.angle + "°");
    set("eng-thr", Math.round(img.raster.threshold * 100), Math.round(img.raster.threshold * 100) + " %");
    $("eng-bg").checked = !!img.bg?.on;
    set("eng-bgt", img.bg?.tol ?? 20, String(img.bg?.tol ?? 20));
    $<HTMLElement>("eng-bg-tol").style.display = img.bg?.on ? "" : "none";
    $<HTMLElement>("eng-mask-row").style.display = img.mask?.length ? "" : "none";
    $("eng-int").value = String(img.interval);
    $("eng-min").value = String(img.minPower);
    $("eng-over").value = String(img.overscan);
    ov.querySelectorAll<HTMLElement>(".eng-pre").forEach(b => b.classList.toggle("active", b.dataset.p ? b.dataset.p === img.preset : img.preset === "custom" && b.dataset.m === img.raster.method));
    $<HTMLElement>("eng-pdesc").textContent = img.preset === "custom" ? t("eng.p.custom") : t("eng.pd." + img.preset);
    ov.querySelectorAll<HTMLElement>("[data-for]").forEach(el => { el.style.display = el.dataset.for!.split(" ").includes(img.raster.method) ? "" : "none"; });
  };
  const num = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const read = () => {
    const curve = img.adjust?.curve;
    img.adjust = {
      brightness: num("eng-br", 0), contrast: num("eng-ct", 0), gamma: num("eng-ga", 1), sharpen: num("eng-sh", 0), denoise: num("eng-dn", 0),
      black: num("eng-bk", 0) / 100, white: Math.max(num("eng-bk", 0) + 2, num("eng-wh", 100)) / 100, invert: $("eng-inv").checked
    };
    if (curve) img.adjust.curve = curve;
    const m = $<HTMLSelectElement>("eng-m").value as RasterMethod;
    if (m !== img.raster.method) img.preset = "custom";
    img.raster = { method: m, cell: num("eng-cell", 6), angle: num("eng-ang", 0), threshold: num("eng-thr", 50) / 100 };
    img.bg = { on: $("eng-bg").checked, tol: num("eng-bgt", 20) };
    img.interval = Math.min(1, Math.max(0.03, num("eng-int", 0.1)));
    img.minPower = Math.min(100, Math.max(0, num("eng-min", 0)));
    img.overscan = Math.min(20, Math.max(0, num("eng-over", 2)));
  };

  // ---- Vorschau ----
  const cv = $<HTMLCanvasElement>("eng-cv");
  let split = 0.5, panX = 0, panY = 0;
  let res = processed(preview, img);
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth * dpr, ch = cv.clientHeight * dpr;
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#0d0d12"; ctx.fillRect(0, 0, cw, ch);
    if (!res?.canvas) return;
    const zoom = Number($<HTMLSelectElement>("eng-zoom").value);
    const k = zoom ? zoom : Math.min((cw - 16) / res.gw, (ch - 16) / res.gh);
    const w = res.gw * k, h = res.gh * k;
    if (!zoom) { panX = 0; panY = 0; }
    panX = Math.max(-Math.max(0, (w - cw) / 2), Math.min(Math.max(0, (w - cw) / 2), panX));
    panY = Math.max(-Math.max(0, (h - ch) / 2), Math.min(Math.max(0, (h - ch) / 2), panY));
    const x = (cw - w) / 2 + panX, y = (ch - h) / 2 + panY;
    ctx.imageSmoothingEnabled = k < 1;
    ctx.drawImage(res.canvas, x, y, w, h);
    const sx = split * cw;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, sx, ch); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    if (original.complete) {
      ctx.save();
      if (img.adjust?.invert) ctx.filter = "invert(1)";
      ctx.drawImage(original, x, y, w, h);
      ctx.restore();
    }
    ctx.restore();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, ch); ctx.stroke();
    ctx.fillStyle = "#6d4aff";
    ctx.beginPath(); ctx.arc(sx, ch / 2, 9 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `${11 * dpr}px system-ui`; ctx.textAlign = "center"; ctx.fillText("↔", sx, ch / 2 + 4 * dpr);
    ctx.font = `600 ${11 * dpr}px system-ui`;
    const tag = (s: string, tx: number, align: CanvasTextAlign) => {
      ctx.textAlign = align;
      const tw = ctx.measureText(s).width + 12 * dpr, bx = align === "left" ? tx : tx - tw;
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(bx, 8 * dpr, tw, 20 * dpr);
      ctx.fillStyle = "#fff"; ctx.fillText(s, align === "left" ? tx + 6 * dpr : tx - 6 * dpr, 22 * dpr);
    };
    tag(t("eng.orig"), 8 * dpr, "left");
    tag(t("eng.result"), cw - 8 * dpr, "right");
  };
  original.onload = draw;

  const rating = () => {
    const before = stats(small, sw, sh), after = stats(applyAdjust(small, sw, sh, A()), sw, sh);
    const pct = (v: number) => Math.round(v * 100) + " %";
    const row = (key: string, a: string, b: string, better: boolean | null) =>
      `<div><span>${t(key)}</span><span>${a} → <b class="${better === null ? "" : better ? "up" : "down"}">${b}</b></span></div>`;
    $<HTMLElement>("eng-rating").innerHTML = `<div class="eng-h">${t("eng.rating")}</div>`
      + row("eng.r.contrast", pct(before.contrast * 2), pct(after.contrast * 2), after.contrast >= before.contrast - 0.005)
      + row("eng.r.detail", (before.detail * 100).toFixed(1), (after.detail * 100).toFixed(1), after.detail >= before.detail - 0.001)
      + row("eng.r.mean", pct(before.mean), pct(after.mean), null)
      + row("eng.r.clipped", pct(before.clipped), pct(after.clipped), after.clipped <= Math.max(0.05, before.clipped + 0.01));
  };

  const info = () => {
    const g = gridSize(preview, img);
    const layer = layerForShape(shape);
    const speed = Math.max(1, layer?.speed || 3000);
    const rows = res ? countRows(res.burn, res.gw, res.gh) : g.gh;
    const mins = (rows * (size.w + 2 * img.overscan)) / speed * (layer?.passes || 1);
    const time = mins < 1 ? "< 1 min" : mins < 60 ? `${Math.round(mins)} min` : `${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min`;
    $<HTMLElement>("eng-info").textContent = t("eng.info", { gw: g.gw, gh: g.gh, w: size.w.toFixed(1), h: size.h.toFixed(1), time })
      + (g.step > img.interval + 1e-9 ? " · " + t("eng.coarser", { step: g.step.toFixed(3) }) : "");
    $<HTMLElement>("eng-dpi").textContent = `(${Math.round(25.4 / img.interval)} DPI)`;
  };

  let timer = 0;
  const update = (now = false) => {
    clearTimeout(timer);
    const run = () => { res = processed(preview, img); draw(); rating(); info(); };
    if (now) run(); else timer = window.setTimeout(run, 90);
  };

  // ---- Bedienung ----
  ov.querySelectorAll<HTMLElement>(".eng-fx .eng-pre").forEach(b => b.addEventListener("click", () => {
    const fx = FX.find(f => f[0] === b.dataset.m)!;
    img.preset = "custom";
    img.raster = { ...img.raster, method: fx[0], cell: fx[2], angle: fx[0] === "crosshatch" ? 0 : img.raster.angle };
    fill(); update(true);
  }));
  ov.querySelectorAll<HTMLElement>(".eng-pre[data-p]").forEach(b => b.addEventListener("click", () => {
    const p = b.dataset.p as EngravePreset, ps = presetSettings(p);
    img.preset = p;
    img.raster = { ...ps.raster };
    img.adjust = ps.auto ? autoAdjust(small, ps.adjust) : { ...NO_ADJUST, ...ps.adjust };
    fill(); update(true);
  }));
  $("eng-auto").addEventListener("click", () => {
    const keep = A();
    img.adjust = autoAdjust(small, { invert: keep.invert, sharpen: Math.max(25, keep.sharpen) });
    fill(); update(true);
    log(t("eng.autoDone"));
  });
  $("eng-mask-off").addEventListener("click", () => { delete img.mask; fill(); update(true); });
  $("eng-reset").addEventListener("click", () => { img.adjust = { ...NO_ADJUST, invert: A().invert }; fill(); update(true); });
  ov.querySelectorAll(".eng-right input, .eng-right select").forEach(el => el.addEventListener("input", () => { read(); fill(); update(); }));
  $("eng-zoom").addEventListener("input", draw);
  // Trennlinie ziehen, sonst (bei Vergrößerung) Bild verschieben
  let drag: "split" | "pan" | null = null, lx = 0, ly = 0;
  cv.addEventListener("mousedown", e => {
    const r = cv.getBoundingClientRect();
    drag = Math.abs(e.clientX - r.left - split * r.width) < 14 || !Number($<HTMLSelectElement>("eng-zoom").value) ? "split" : "pan";
    lx = e.clientX; ly = e.clientY;
    if (drag === "split") { split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); draw(); }
  });
  window.addEventListener("mousemove", e => {
    if (!drag) return;
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (drag === "split") split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    else { panX += (e.clientX - lx) * dpr; panY += (e.clientY - ly) * dpr; lx = e.clientX; ly = e.clientY; }
    draw();
  });
  window.addEventListener("mouseup", () => { drag = null; });

  const close = () => { ov.dispatchEvent(new Event("remove-listeners")); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("eng-cancel").addEventListener("click", close);
  $("eng-ok").addEventListener("click", () => {
    read();
    shape.img = img;
    close();
    log(t("eng.applied", { type: img.preset === "custom" ? t("eng.m." + img.raster.method) : t("eng.p." + img.preset) }));
    onDone();
  });
  // ---- Bildkurve: Punkte ziehen, Klick = neuer Punkt, Doppelklick = Punkt weg ----
  const ccv = $<HTMLCanvasElement>("eng-curve");
  const pts = (): number[][] => (img.adjust.curve && img.adjust.curve.length >= 2 ? img.adjust.curve : [[0, 0], [1, 1]]).map(p => [...p]);
  let hist: Float32Array | null = null;
  const histogram = () => {
    const g = applyAdjust(small, sw, sh, { ...A(), curve: undefined });
    const h = new Float32Array(64);
    for (let i = 0; i < g.length; i++) h[Math.min(63, Math.floor(g[i] * 64))]++;
    const mx = Math.max(1, ...h);
    hist = h.map(v => v / mx);
  };
  const PAD = 10;
  const toC = (x: number, y: number) => ({ x: PAD + x * (ccv.width - 2 * PAD), y: ccv.height - PAD - y * (ccv.height - 2 * PAD) });
  const fromC = (cx: number, cy: number) => ({
    x: Math.min(1, Math.max(0, (cx - PAD) / (ccv.width - 2 * PAD))),
    y: Math.min(1, Math.max(0, (ccv.height - PAD - cy) / (ccv.height - 2 * PAD)))
  });
  const drawCurve = () => {
    const g = ccv.getContext("2d")!, W = ccv.width, H = ccv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#0d0d12"; g.fillRect(0, 0, W, H);
    if (!hist) histogram();
    g.fillStyle = "rgba(160,150,200,0.22)";
    hist!.forEach((v, i) => { const a = toC(i / 64, 0), b = toC((i + 1) / 64, v * 0.9); g.fillRect(a.x, b.y, b.x - a.x, a.y - b.y); });
    g.strokeStyle = "rgba(255,255,255,0.08)"; g.lineWidth = 1;
    for (let k = 1; k < 4; k++) { const a = toC(k / 4, 0), b = toC(k / 4, 1), c = toC(0, k / 4), d = toC(1, k / 4); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c.x, c.y); g.lineTo(d.x, d.y); g.stroke(); }
    g.strokeStyle = "rgba(255,255,255,0.18)"; g.setLineDash([4, 4]);
    const o = toC(0, 0), e = toC(1, 1); g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(e.x, e.y); g.stroke(); g.setLineDash([]);
    const lut = curveLut(pts());
    g.strokeStyle = "#a78bff"; g.lineWidth = 2; g.beginPath();
    for (let i = 0; i < 256; i++) { const q = toC(i / 255, lut[i]); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); }
    g.stroke();
    pts().forEach((p, i) => { const q = toC(p[0], p[1]); g.fillStyle = i === cdrag ? "#fff" : "#6d4aff"; g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, 5, 0, Math.PI * 2); g.fill(); g.stroke(); });
  };
  const setCurve = (c: number[][] | undefined) => {
    if (!c || curveIsIdentity(c)) delete img.adjust.curve; else img.adjust.curve = c.map(p => [+p[0].toFixed(3), +p[1].toFixed(3)]);
    drawCurve(); update();
  };
  let cdrag = -1;
  const pos = (e: MouseEvent) => { const r = ccv.getBoundingClientRect(); return { cx: (e.clientX - r.left) * ccv.width / r.width, cy: (e.clientY - r.top) * ccv.height / r.height }; };
  const near = (cx: number, cy: number) => pts().findIndex(p => { const q = toC(p[0], p[1]); return Math.hypot(q.x - cx, q.y - cy) < 9; });
  ccv.addEventListener("mousedown", e => {
    const { cx, cy } = pos(e);
    let i = near(cx, cy);
    if (i < 0) {
      const p = fromC(cx, cy), list = pts();
      list.push([p.x, p.y]); list.sort((a, b) => a[0] - b[0]);
      i = list.findIndex(q => q[0] === p.x && q[1] === p.y);
      setCurve(list);
    }
    cdrag = i; drawCurve();
  });
  const onCurveMove = (e: MouseEvent) => {
    if (cdrag < 0 || !document.body.contains(ccv)) return;
    const { cx, cy } = pos(e), p = fromC(cx, cy), list = pts();
    const last = list.length - 1;
    // Anfang und Ende bleiben am Rand (x = 0 / 1), sonst zwischen den Nachbarn
    const x = cdrag === 0 ? 0 : cdrag === last ? 1 : Math.min(list[cdrag + 1][0] - 0.01, Math.max(list[cdrag - 1][0] + 0.01, p.x));
    list[cdrag] = [x, p.y];
    setCurve(list);
  };
  const onCurveUp = () => { if (cdrag >= 0) { cdrag = -1; drawCurve(); } };
  window.addEventListener("mousemove", onCurveMove);
  window.addEventListener("mouseup", onCurveUp);
  ccv.addEventListener("dblclick", e => {
    const { cx, cy } = pos(e), i = near(cx, cy), list = pts();
    if (i > 0 && i < list.length - 1) { list.splice(i, 1); setCurve(list); }
  });
  ov.querySelectorAll<HTMLElement>("[data-curve]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.curve;
    setCurve(k === "s" ? [[0, 0], [0.25, 0.18], [0.75, 0.84], [1, 1]] : k === "light" ? [[0, 0], [0.3, 0.42], [1, 1]] : undefined);
  }));
  // Schieber geändert → Verteilung neu zeichnen
  ov.querySelectorAll(".eng-right input, .eng-right select, .eng-pre, #eng-auto, #eng-reset").forEach(el =>
    el.addEventListener(el.tagName === "BUTTON" ? "click" : "input", () => { hist = null; drawCurve(); }));
  ov.addEventListener("remove-listeners", () => { window.removeEventListener("mousemove", onCurveMove); window.removeEventListener("mouseup", onCurveUp); });

  fill();
  update(true);
  drawCurve();
}

/** Zeilen mit mindestens einem gebrannten Punkt (für die Zeit-Schätzung) */
function countRows(burn: Float32Array, gw: number, gh: number): number {
  let n = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (burn[y * gw + x] >= 0.004) { n++; break; }
  return n;
}
