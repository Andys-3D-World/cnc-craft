/**
 * DIALOG „Foto mit dem V-Stichel“ (Fräse): Bild → parallele V-Nuten, deren Breite die Helligkeit nachbildet.
 * Gerechnet wird in photoVcarve.ts. Hier: Werte, Vorschau, G-Code als Auftrag laden oder speichern – gestartet wird nichts.
 */
import { isLathe } from "../machineMode";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t, ascii, tMm } from "../i18n/i18n";
import { getTools, MillingTool, DEFAULT_PLUNGE } from "../toolLibrary";
import { spindleCode } from "../spindleDir";
import { loadGcodeFromText } from "../machineStream";
import { bedSizeMm } from "../editor/editorState";
import { loadImage, toGray } from "../importers/imageTrace";
import { resampleGray } from "../relief/imageRelief.ts";
import { withPost, postedText, postFileName, postExtensions } from "../post/postExport";
import { coneDepth, photoLines, photoPlan, PhotoOpts, PhotoPlan, tooMuch, widthAtDepth } from "../photoVcarve.ts";

const KEY = "cnc_craft_photo_vcarve";
const SAFE_Z = 5.0; // wie cam.ts

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** G-Code aus dem Plan */
function photoGcode(plan: PhotoPlan, o: PhotoOpts, tool: MillingTool): { gcode: string; minutes: number } {
  const c = (key: string, v?: Record<string, string | number>) => `(${ascii(tMm(key, v))})`;
  const feed = tool.feedrate || 800, plunge = tool.plungeFeed ?? DEFAULT_PLUNGE, rpm = Math.round(tool.rpm || 12000);
  const r = photoLines(plan, o, feed, plunge, SAFE_Z);
  const gcode = [
    c("pvc.gcHead", { w: o.w, h: o.h, s: o.spacing }),
    c("gc.tool", { name: tool.name, d: tool.diameter.toFixed(1) }),
    `G21 ${c("gc.unitMm")}`, `G90 ${c("gc.absolute")}`, "G17",
    `G0 Z${SAFE_Z.toFixed(2)} ${c("gc.safeZ")}`,
    `${spindleCode("M3")} S${rpm} ${c("gc.spindleOn", { rpm })}`,
    `G4 P3 ${c("gc.spinUp")}`,
    ...r.lines,
    `M5 ${c("gc.spindleOff")}`,
    `G0 X0 Y0 ${c("gc.park")}`,
    `M30 ${c("gc.end")}`
  ].join("\n") + "\n";
  // grob: Schneiden im Vorschub, Wege oben mit 3000 mm/min, je Stück ein Eintauchen
  return { gcode, minutes: r.cut / feed + r.air / 3000 + plan.segs.length * 2 / plunge };
}

export async function openPhotoVcarve(name: string, bytes: Uint8Array, log: (s: string) => void) {
  if (isLathe()) { log(t("deco.onlyMill")); return; }
  document.getElementById("pvc-overlay")?.remove();
  const tools = getTools().filter(x => (x.type === "vbit" || x.type === "chamfer") && x.angle > 0);
  if (!tools.length) { log(t("pvc.noTool")); return; }
  const img = await loadImage(name, bytes);
  const { gray, W, H } = toGray(img);
  const bed = bedSizeMm();

  const first = tools.find(x => x.type === "vbit") || tools[0];
  const o = { toolId: first.id, x0: 10, y0: 10, w: Math.min(150, Math.max(20, bed.w - 20)), h: 0, spacing: 0.8, maxDepth: 1, stepDown: 0, lines: 45, contrast: 1, gamma: 1, invert: false };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of ["w", "spacing", "maxDepth", "lines", "contrast", "gamma", "invert"] as const) if (typeof s[k] === typeof o[k] && (typeof s[k] !== "number" || Number.isFinite(s[k]))) (o as any)[k] = s[k];
    if (tools.some(x => x.id === s.toolId)) o.toolId = s.toolId;
  } catch { /* Standard */ }
  const tool = () => tools.find(x => x.id === o.toolId) || first;
  o.h = +(o.w * H / W).toFixed(2);
  o.stepDown = Math.max(0.05, +(tool().stepZ || 1).toFixed(2));

  const num = (id: string, label: string, unit = "mm", step = "0.1", tip = "") =>
    `<div class="dlg-row"${tip ? ` data-tip="${esc(t(tip))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
  const ov = document.createElement("div");
  ov.id = "pvc-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(980px, calc(100vw - 32px));">
      <h3>🖼️ ${esc(t("pvc.title"))} <span class="dlg-hint" style="font-weight:400;">${esc(name)}</span></h3>
      <div class="dlg-hint">${esc(t("pvc.intro"))}</div>
      <div class="c3d-grid">
        <div class="c3d-form">
          <div class="dlg-row"><span>${esc(t("pvc.tool"))}</span>
            <select id="pvc-tool" class="prop-input" style="width:170px;">${tools.map(x => `<option value="${esc(x.id)}">${esc(x.name)} · ${x.angle}°</option>`).join("")}</select></div>
          ${num("pvc-w", "c3d.sizeX")}${num("pvc-h", "c3d.sizeY")}
          ${num("pvc-x0", "c3d.posX")}${num("pvc-y0", "c3d.posY")}
          ${num("pvc-spacing", "pvc.spacing", "mm", "0.05", "pvc.spacingTip")}
          ${num("pvc-depth", "pvc.maxDepth", "mm", "0.1", "pvc.maxDepthTip")}
          ${num("pvc-step", "c3d.stepDown")}
          <div class="dlg-row"><span>${esc(t("pvc.lines"))}</span><select id="pvc-lines" class="prop-input" style="width:auto;">
            ${[0, 45, 90, 135].map(a => `<option value="${a}">${a}°</option>`).join("")}</select></div>
          ${num("pvc-contrast", "rlf.contrast", "", "0.1")}${num("pvc-gamma", "rlf.gamma", "", "0.1", "pvc.gammaTip")}
          <label class="eng-ck" data-tip="${esc(t("pvc.invertTip"))}"><input type="checkbox" id="pvc-invert"> ${esc(t("pvc.invert"))}</label>
          <div class="dlg-hint" id="pvc-info"></div>
          <div class="dlg-hint" id="pvc-warn" style="color:var(--lt-amber, #ffb454);"></div>
        </div>
        <canvas id="pvc-cv" style="width:100%;border-radius:6px;display:block;"></canvas>
      </div>
      <div class="dlg-buttons">
        <button id="pvc-load" class="btn-primary">${esc(t("c3d.load"))}</button>
        <button id="pvc-save" class="btn-secondary">💾 ${esc(t("c3d.save"))}</button>
        <button id="pvc-close" class="btn-secondary" style="margin-left:auto;">${esc(t("dlg.close"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const fields: [string, "w" | "h" | "x0" | "y0" | "spacing" | "maxDepth" | "stepDown" | "contrast" | "gamma", number, number][] = [
    ["pvc-w", "w", 1, 5000], ["pvc-h", "h", 1, 5000], ["pvc-x0", "x0", -5000, 5000], ["pvc-y0", "y0", -5000, 5000], ["pvc-spacing", "spacing", 0.1, 10],
    ["pvc-depth", "maxDepth", 0.05, 20], ["pvc-step", "stepDown", 0.05, 20], ["pvc-contrast", "contrast", 0.2, 5], ["pvc-gamma", "gamma", 0.2, 5]];
  const fill = () => {
    for (const [id, k] of fields) if (document.activeElement !== $(id)) $(id).value = String(o[k]);
    $<HTMLSelectElement>("pvc-tool").value = o.toolId;
    $<HTMLSelectElement>("pvc-lines").value = String(o.lines);
    $("pvc-invert").checked = o.invert;
  };
  const opts = (): PhotoOpts => {
    const tl = tool();
    return { x0: o.x0, y0: o.y0, w: o.w, h: o.h, spacing: o.spacing, angle: tl.angle, tipDia: tl.tipDia, toolDia: tl.diameter, maxDepth: o.maxDepth, stepDown: o.stepDown, lines: o.lines };
  };

  let plan: PhotoPlan | null = null;
  const compute = () => {
    const p = opts();
    plan = null;
    if (tooMuch(p)) { $<HTMLElement>("pvc-warn").textContent = t("pvc.tooMuch"); $<HTMLElement>("pvc-info").textContent = ""; enable(); return; }
    // Bild auf das Raster der Linien bringen (feiner sieht man nicht), dann Kontrast und Helligkeit
    const cell = Math.max(0.1, o.spacing / 2);
    const nx = Math.max(2, Math.min(1500, Math.round(o.w / cell))), ny = Math.max(2, Math.min(1500, Math.round(o.h / cell)));
    const g = resampleGray(gray, W, H, nx, ny);
    for (let i = 0; i < g.length; i++) {
      let v = 1 - g[i] / 255;
      if (o.invert) v = 1 - v;
      v = Math.max(0, Math.min(1, (v - 0.5) * o.contrast + 0.5));
      g[i] = Math.pow(v, o.gamma);
    }
    const at = (u: number, v: number) => {
      const fx = Math.max(0, Math.min(nx - 1, u / o.w * (nx - 1))), fy = Math.max(0, Math.min(ny - 1, (1 - v / o.h) * (ny - 1)));
      const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), a = fx - i, b = fy - j;
      return (g[j * nx + i] * (1 - a) + g[j * nx + i + 1] * a) * (1 - b) + (g[(j + 1) * nx + i] * (1 - a) + g[(j + 1) * nx + i + 1] * a) * b;
    };
    plan = photoPlan(at, p);
    draw(p, plan);
    const est = plan.segs.length ? photoGcode(plan, p, tool()) : null;
    $<HTMLElement>("pvc-info").textContent = est
      ? t("pvc.info", { n: plan.lines, d: plan.deepest.toFixed(2), b: widthAtDepth(plan.deepest, p).toFixed(2), m: Math.max(1, Math.round(est.minutes)) })
      : t("pvc.empty");
    const warn: string[] = [];
    if (plan.clipped > 0.02) warn.push(t("pvc.warnClip", { p: Math.round(plan.clipped * 100), d: Math.min(o.maxDepth, coneDepth(p)).toFixed(2) }));
    if (tool().tipDia > o.spacing / 2) warn.push(t("pvc.warnTip", { d: tool().tipDia }));
    if (o.x0 < -1e-6 || o.y0 < -1e-6 || o.x0 + o.w > bed.w + 1e-6 || o.y0 + o.h > bed.h + 1e-6) warn.push(t("pvc.warnBed", { w: bed.w, h: bed.h }));
    $<HTMLElement>("pvc-warn").textContent = warn.join(" ");
    enable();
  };
  const enable = () => { for (const id of ["pvc-load", "pvc-save"]) $<HTMLButtonElement>(id).disabled = !plan?.segs.length; };

  /** Vorschau: so breit, wie die Nuten werden */
  const draw = (p: PhotoOpts, pl: PhotoPlan) => {
    const cv = $<HTMLCanvasElement>("pvc-cv");
    const k = Math.min(900 / p.w, 900 / p.h);
    cv.width = Math.max(1, Math.round(p.w * k)); cv.height = Math.max(1, Math.round(p.h * k));
    const ctx = cv.getContext("2d")!;
    const [board, groove] = o.invert ? ["#2c2a28", "#e6d2b0"] : ["#e6d2b0", "#3a2a1c"];
    ctx.fillStyle = board; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = groove;
    const X = (x: number) => (x - p.x0) * k, Y = (y: number) => cv.height - (y - p.y0) * k;
    for (const s of pl.segs) {
      // Band mit der Breite der Nut: eine Seite hin, die andere zurück
      const dx = s[s.length - 1].x - s[0].x, dy = s[s.length - 1].y - s[0].y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      ctx.beginPath();
      const side = (q: typeof s[number], sg: number) => { const r = widthAtDepth(q.d, p) / 2 * sg; ctx.lineTo(X(q.x + nx * r), Y(q.y + ny * r)); };
      for (const q of s) side(q, 1);
      for (let i = s.length - 1; i >= 0; i--) side(s[i], -1);
      ctx.fill();
    }
  };

  let timer = 0;
  const later = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) compute(); }, 120); };
  for (const [id, k, lo, hi] of fields) $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v) || v < lo || v > hi) return;
    o[k] = v;
    // Seitenverhältnis des Fotos bleibt
    if (k === "w") o.h = +(v * H / W).toFixed(2);
    if (k === "h") o.w = +(v * W / H).toFixed(2);
    fill(); later();
  });
  for (const [id] of fields) $(id).addEventListener("change", () => { $(id).blur(); fill(); });
  $<HTMLSelectElement>("pvc-tool").addEventListener("change", e => {
    o.toolId = (e.target as HTMLSelectElement).value;
    o.stepDown = Math.max(0.05, +(tool().stepZ || 1).toFixed(2));
    fill(); later();
  });
  $<HTMLSelectElement>("pvc-lines").addEventListener("change", e => { o.lines = +(e.target as HTMLSelectElement).value; later(); });
  $("pvc-invert").addEventListener("change", () => { o.invert = $("pvc-invert").checked; later(); });
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ toolId: o.toolId, w: o.w, spacing: o.spacing, maxDepth: o.maxDepth, lines: o.lines, contrast: o.contrast, gamma: o.gamma, invert: o.invert })); } catch { /* egal */ } };
  const close = () => { clearTimeout(timer); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLButtonElement>("pvc-close").onclick = close;
  $<HTMLButtonElement>("pvc-load").onclick = () => {
    compute();
    if (!plan?.segs.length) return;
    keep();
    if (loadGcodeFromText(photoGcode(plan, opts(), tool()).gcode, t("pvc.jobName", { name }), log)) { log(t("pvc.loaded")); close(); }
  };
  $<HTMLButtonElement>("pvc-save").onclick = async () => {
    compute();
    const pl = plan;
    if (!pl?.segs.length) return;
    keep();
    const text = postedText(withPost(() => photoGcode(pl, opts(), tool()).gcode), log);
    if (text === null) return;
    try {
      const filePath = await save({ title: t("rp.saveGcode"), defaultPath: postFileName(name.replace(/\.[^.]+$/, "") + "-v.gcode"), filters: [{ name: t("stream.dlgFilter"), extensions: postExtensions() }] });
      if (filePath) { await writeFile(filePath, new TextEncoder().encode(text)); log(t("gcw.saved", { p: filePath })); }
    } catch (err) { log(t("gcw.saveError", { e: String(err) })); }
  };
  fill();
  compute();
}
