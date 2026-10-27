/**
 * 3D-FRÄSEN – Dialog (aus dem 3D-Import: „3D-Fräsen“)
 *
 * Links: Lage und Größe auf dem Bett, Modellhöhe, Materialdicke, Werkzeug + Werte fürs Schruppen und Schlichten.
 * Rechts: 3D-Ansicht – vor dem Rechnen das Modell auf dem Bett, danach das Fräsergebnis aus dem fertigen G-Code
 * (dieselbe Materialabtrag-Simulation wie die 3D-Ansicht, view3d/carveSim.ts).
 * Gerechnet wird im App-Kern (cam3d.rs), der G-Code entsteht in cam3d.ts.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n/i18n";
import { Viewer3D, Mesh } from "../view3d/viewer3d";
import { carve } from "../view3d/carveSim";
import { carveScene } from "../view3d/scenes";
import { MATERIALS, materialView } from "../materialView";
import { getTools, MillingTool } from "../toolLibrary";
import { loadGcodeFromText } from "../machineStream";
import { openFacingDialog } from "./facingDialog";
import { Job3D, Path3D, loadModel3d, computePaths3d, cancelPaths3d, gcode3d, stats3d } from "../cam3d";

const KEY = "cnc_craft_cam3d";

interface Opts {
  x0: number; y0: number; sizeX: number; sizeY: number; height: number; thick: number; keep: boolean; margin: boolean;
  rough: boolean; roughTool: string; roughDown: number; roughOver: number; allow: number;
  finish: boolean; finishTool: string; finishOver: number; dir: "x" | "y" | "xy"; tol: number; finishDown: number;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * @param name  Dateiname (nur Anzeige und G-Code-Kommentar)
 * @param pos   Dreiecke (9 Werte je Dreieck), schon in der gewählten Blickrichtung: z = Höhe
 */
export function openCam3D(name: string, pos: Float32Array, log: (s: string) => void) {
  document.getElementById("c3d-overlay")?.remove();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = pos[i + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const span = [0, 1, 2].map(a => Math.max(0.01, hi[a] - lo[a]));
  const tools = getTools();
  const pick = (types: string[]) => tools.find(x => types.includes(x.type))?.id || tools[0]?.id || "";
  let o: Opts = {
    x0: 10, y0: 10, sizeX: +span[0].toFixed(2), sizeY: +span[1].toFixed(2), height: +span[2].toFixed(2),
    thick: Math.ceil(span[2] + 2), keep: true, margin: true,
    rough: true, roughTool: pick(["endmill", "bullnose", "facemill"]), roughDown: 0, roughOver: 0, allow: 0.5,
    finish: true, finishTool: pick(["ball"]), finishOver: 0, dir: "x", tol: 0.02, finishDown: 0
  };
  // Werte vom letzten Mal (ohne die Maße – die gehören zum Modell)
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of ["x0", "y0", "keep", "margin", "rough", "allow", "finish", "dir", "tol"] as const) if (k in saved) (o as any)[k] = saved[k];
    for (const k of ["roughTool", "finishTool"] as const) if (tools.some(x => x.id === saved[k])) o[k] = saved[k];
  } catch { /* egal */ }
  const tool = (id: string) => tools.find(x => x.id === id) || null;
  const defaults = () => {
    const r = tool(o.roughTool), f = tool(o.finishTool);
    if (r) { o.roughDown = +(r.stepZ || 1).toFixed(2); o.roughOver = +(r.diameter * 0.4).toFixed(2); }
    if (f) { o.finishOver = +(f.diameter * (f.type === "ball" ? 0.1 : 0.4)).toFixed(2); o.finishDown = +(f.stepZ || 1).toFixed(2); }
  };
  defaults();

  const toolOpts = (sel: string) => tools.map(x =>
    `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name)} · Ø${x.diameter} · ${esc(t("tl.type." + x.type))}</option>`).join("");
  const num = (id: string, label: string, unit = "mm", step = "0.1") =>
    `<div class="dlg-row"><span>${label}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
  const ov = document.createElement("div");
  ov.id = "c3d-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1100px, calc(100vw - 32px));">
      <h3>🏔 ${t("c3d.title")} <span class="dlg-hint" style="font-weight:400;">${esc(name)}</span></h3>
      <div class="c3d-grid">
        <div class="c3d-form">
          <div class="c3d-sec">${t("c3d.model")}</div>
          ${num("c3d-x0", t("c3d.posX"))}${num("c3d-y0", t("c3d.posY"))}
          ${num("c3d-sx", t("c3d.sizeX"))}${num("c3d-sy", t("c3d.sizeY"))}
          <label class="eng-ck"><input type="checkbox" id="c3d-keep"> ${t("c3d.keep")}</label>
          ${num("c3d-h", t("c3d.height"))}${num("c3d-t", t("c3d.thick"))}
          <label class="eng-ck" data-tip="${esc(t("c3d.marginTip"))}"><input type="checkbox" id="c3d-margin"> ${t("c3d.margin")}</label>

          <label class="c3d-sec eng-ck"><input type="checkbox" id="c3d-rough"> ${t("c3d.rough")}</label>
          <div id="c3d-rough-box">
            <select id="c3d-rtool" class="prop-input" style="width:100%;">${toolOpts(o.roughTool)}</select>
            ${num("c3d-rdown", t("c3d.stepDown"))}${num("c3d-rover", t("c3d.stepOver"))}${num("c3d-allow", t("c3d.allow"), "mm", "0.05")}
          </div>

          <label class="c3d-sec eng-ck"><input type="checkbox" id="c3d-finish"> ${t("c3d.finish")}</label>
          <div id="c3d-finish-box">
            <select id="c3d-ftool" class="prop-input" style="width:100%;">${toolOpts(o.finishTool)}</select>
            ${num("c3d-fover", t("c3d.stepOver"), "mm", "0.05")}
            <div class="dlg-row"><span>${t("c3d.dir")}</span><select id="c3d-dir" class="prop-input" style="width:auto;">
              <option value="x">${t("c3d.dirX")}</option><option value="y">${t("c3d.dirY")}</option><option value="xy">${t("c3d.dirXY")}</option></select></div>
            ${num("c3d-tol", t("c3d.tol"), "mm", "0.005")}
            <div id="c3d-fdown-row">${num("c3d-fdown", t("c3d.stepDown"))}<div class="dlg-hint">${t("c3d.finishStepHint")}</div></div>
          </div>
          <div class="dlg-hint">${t("c3d.toolHint")}</div>
        </div>
        <div class="c3d-view">
          <canvas id="c3d-cv"></canvas>
          <div class="c3d-bar">
            <select id="c3d-mat" class="prop-input" style="width:auto;">${MATERIALS.map(m => `<option value="${m.id}">${t("mat3d." + m.id)}</option>`).join("")}</select>
            <span class="dlg-hint" id="c3d-info"></span>
          </div>
          <div id="c3d-warn" class="mat-beta" style="display:none;"></div>
        </div>
      </div>
      <div class="dlg-buttons">
        <button id="c3d-run" class="btn-primary">▶ ${t("c3d.compute")}</button>
        <button id="c3d-stop" class="btn-secondary" style="display:none;">■ ${t("c3d.cancel")}</button>
        <button id="c3d-load" class="btn-secondary" disabled>${t("c3d.load")}</button>
        <button id="c3d-save" class="btn-secondary" disabled>💾 ${t("c3d.save")}</button>
        <button id="c3d-face" class="btn-secondary" data-tip="${esc(t("face.btnTip"))}">🪵 ${t("face.btn")}</button>
        <button id="c3d-close" class="btn-secondary" style="margin-left:auto;">${t("dlg.close")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const info = $<HTMLElement>("c3d-info"), warn = $<HTMLElement>("c3d-warn");
  const viewer = new Viewer3D($<HTMLCanvasElement>("c3d-cv"));
  let mat = materialView()?.id || "birch";
  $<HTMLSelectElement>("c3d-mat").value = mat;

  // Felder <-> Werte
  const fields: [string, keyof Opts][] = [["c3d-x0", "x0"], ["c3d-y0", "y0"], ["c3d-sx", "sizeX"], ["c3d-sy", "sizeY"], ["c3d-h", "height"],
    ["c3d-t", "thick"], ["c3d-rdown", "roughDown"], ["c3d-rover", "roughOver"], ["c3d-allow", "allow"], ["c3d-fover", "finishOver"],
    ["c3d-tol", "tol"], ["c3d-fdown", "finishDown"]];
  const fill = () => {
    for (const [id, k] of fields) $(id).value = String(o[k]);
    $("c3d-keep").checked = o.keep; $("c3d-margin").checked = o.margin;
    $("c3d-rough").checked = o.rough; $("c3d-finish").checked = o.finish;
    $<HTMLSelectElement>("c3d-dir").value = o.dir;
    $<HTMLElement>("c3d-rough-box").style.display = o.rough ? "" : "none";
    $<HTMLElement>("c3d-finish-box").style.display = o.finish ? "" : "none";
    $<HTMLElement>("c3d-fdown-row").style.display = o.rough ? "none" : "";
  };
  const save_ = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ } };

  let paths: Path3D[] | null = null, gcode = "", running = false, run = 0, closed = false;
  const job = (): Job3D => {
    const op = (on: boolean, id: string, down: number, over: number, allow: number) => {
      const tl = tool(id);
      return on && tl ? { tool: tl, stepDown: down, stepOver: over, allowance: allow, dir: o.dir, tolerance: o.tol } : null;
    };
    return {
      place: { x0: o.x0, y0: o.y0, sizeX: o.sizeX, sizeY: o.sizeY, height: o.height }, margin: o.margin,
      rough: op(o.rough, o.roughTool, o.roughDown, o.roughOver, Math.max(0, o.allow)),
      finish: op(o.finish, o.finishTool, o.finishDown, o.finishOver, 0), name
    };
  };
  const warnings = (): string[] => {
    const w: string[] = [];
    if (o.height > o.thick + 1e-6) w.push(t("c3d.warnThick"));
    const used = new Set([o.rough ? o.roughTool : "", o.finish ? o.finishTool : ""].filter(Boolean));
    for (const id of used) {
      const tl = tool(id);
      if (tl && tl.fluteLen > 0 && tl.fluteLen < o.height) w.push(t("c3d.warnFlute", { name: tl.name, l: tl.fluteLen, h: o.height }));
    }
    return w;
  };
  const showWarn = (extra: string[] = []) => {
    const w = [...warnings(), ...extra];
    warn.style.display = w.length ? "" : "none";
    warn.textContent = w.join(" ");
  };
  const buttons = () => {
    $<HTMLButtonElement>("c3d-run").style.display = running ? "none" : "";
    $<HTMLButtonElement>("c3d-stop").style.display = running ? "" : "none";
    $<HTMLButtonElement>("c3d-load").disabled = running || !gcode;
    $<HTMLButtonElement>("c3d-save").disabled = running || !gcode;
  };

  /** Modell auf dem Bett (vor dem Rechnen): Oberkante = Material-Oberkante */
  const showModel = (keepView: boolean) => {
    const kx = o.sizeX / span[0], ky = o.sizeY / span[1], kz = o.height / span[2];
    const T = Math.max(o.thick, o.height);
    const m: Mesh = { pos: [], nrm: [], color: [0.78, 0.62, 0.42] };
    const step = Math.max(1, Math.ceil(pos.length / 9 / 400_000)); // sehr große Modelle: nur jedes n-te Dreieck zeigen
    for (let i = 0; i + 8 < pos.length; i += 9 * step) {
      const P = [0, 1, 2].map(k => [(pos[i + k * 3] - lo[0]) * kx + o.x0, (pos[i + k * 3 + 1] - lo[1]) * ky + o.y0, (pos[i + k * 3 + 2] - hi[2]) * kz + T]);
      const u = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], v = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      for (const p of P) { m.pos.push(p[0], p[1], p[2]); m.nrm.push(n[0] / l, n[1] / l, n[2] / l); }
    }
    viewer.setMeshes([m], keepView);
    info.textContent = t("c3d.hintView");
  };

  /** Fräsergebnis aus dem G-Code (Schruppen + Schlichten) */
  const simulate = async (keepView: boolean) => {
    const my = ++run;
    const j = job();
    const tl = [j.rough, j.finish].filter(Boolean).map(x => x!.tool) as MillingTool[];
    info.textContent = t("v3d.carving", { p: 0 });
    const res = await carve(gcode.split("\n"), tl, f => {
      if (my !== run || closed) return false;
      info.textContent = t("v3d.carving", { p: Math.round(f * 100) });
      return true;
    });
    if (my !== run || closed || !res) return;
    const m = MATERIALS.find(x => x.id === mat) || MATERIALS[0];
    viewer.setMeshes(carveScene(res, m, Math.max(o.thick, 0.2)), keepView);
    const s = stats3d(paths!, j);
    info.textContent = t("c3d.result", { n: paths!.length, r: s.rough.toFixed(1), f: s.finish.toFixed(1), min: Math.max(1, Math.round(s.minutes)) });
  };

  const stale = () => {
    if (running) return;
    if (gcode) { paths = null; gcode = ""; buttons(); }
    run++;
    showModel(true);
    showWarn();
  };

  const compute = async () => {
    const j = job();
    if (!tools.length) { showWarn([t("c3d.noTools")]); return; }
    if (!j.rough && !j.finish) { showWarn([t("c3d.noOp")]); return; }
    running = true; paths = null; gcode = ""; buttons();
    const my = ++run;
    try {
      info.textContent = t("c3d.progLoad");
      await loadModel3d(pos);
      const res = await computePaths3d(j, (f, stage) => {
        if (my === run && !closed) info.textContent = t(stage === "finish" ? "c3d.progFinish" : "c3d.progRough", { p: Math.round(f * 100) });
      });
      if (closed || my !== run) return;
      paths = res;
      gcode = gcode3d(res, j);
      running = false; buttons();
      log(t("c3d.done", { n: res.length, l: gcode.split("\n").length }));
      await simulate(false);
    } catch (e) {
      running = false; buttons();
      if (closed) return;
      const msg = String((e as any)?.message ?? e);
      const inApp = !!(window as any).__TAURI_INTERNALS__;
      info.textContent = msg.includes("cancelled") ? t("c3d.cancelled") : !inApp ? t("c3d.needApp") : t("c3d.error", { e: msg });
    }
  };

  fill(); showWarn(); showModel(false); buttons();

  for (const [id, k] of fields) $(id).addEventListener("change", () => {
    const v = parseFloat($(id).value);
    const min = k === "x0" || k === "y0" || k === "allow" ? (k === "allow" ? 0 : -1e6) : 0.001;
    if (!Number.isFinite(v) || v < min) { $(id).value = String(o[k]); return; }
    const old = o[k] as number;
    (o as any)[k] = v;
    // Seitenverhältnis halten
    if (o.keep && (k === "sizeX" || k === "sizeY")) {
      const f = v / old;
      if (k === "sizeX") o.sizeY = +(o.sizeY * f).toFixed(2); else o.sizeX = +(o.sizeX * f).toFixed(2);
      fill();
    }
    save_(); stale();
  });
  for (const [id, k] of [["c3d-keep", "keep"], ["c3d-margin", "margin"], ["c3d-rough", "rough"], ["c3d-finish", "finish"]] as [string, keyof Opts][]) {
    $(id).addEventListener("change", () => { (o as any)[k] = $(id).checked; fill(); save_(); stale(); });
  }
  // Rohteil vorher beidseitig planen (gegen Verzug); danach ist das Material dünner
  $<HTMLButtonElement>("c3d-face").onclick = () => openFacingDialog(
    { x0: o.x0, y0: o.y0, w: o.sizeX, h: o.sizeY, thick: o.thick, height: o.height }, log,
    depth => { o.thick = +Math.max(0.1, o.thick - 2 * depth).toFixed(2); fill(); save_(); stale(); });
  $<HTMLSelectElement>("c3d-rtool").addEventListener("change", e => {
    o.roughTool = (e.target as HTMLSelectElement).value;
    const r = tool(o.roughTool);
    if (r) { o.roughDown = +(r.stepZ || 1).toFixed(2); o.roughOver = +(r.diameter * 0.4).toFixed(2); }
    fill(); save_(); stale();
  });
  $<HTMLSelectElement>("c3d-ftool").addEventListener("change", e => {
    o.finishTool = (e.target as HTMLSelectElement).value;
    const f = tool(o.finishTool);
    if (f) { o.finishOver = +(f.diameter * (f.type === "ball" ? 0.1 : 0.4)).toFixed(2); o.finishDown = +(f.stepZ || 1).toFixed(2); }
    fill(); save_(); stale();
  });
  $<HTMLSelectElement>("c3d-dir").addEventListener("change", e => { o.dir = (e.target as HTMLSelectElement).value as Opts["dir"]; save_(); stale(); });
  $<HTMLSelectElement>("c3d-mat").addEventListener("change", e => { mat = (e.target as HTMLSelectElement).value; if (gcode) simulate(true); });

  $("c3d-run").onclick = compute;
  $("c3d-stop").onclick = () => cancelPaths3d();
  $("c3d-load").onclick = () => {
    if (gcode && loadGcodeFromText(gcode, t("c3d.jobName", { name }), log)) log(t("c3d.loaded", { n: gcode.split("\n").length }));
  };
  $("c3d-save").onclick = async () => {
    if (!gcode) return;
    try {
      const filePath = await save({
        title: t("rp.saveGcode"),
        defaultPath: name.replace(/\.[^.]+$/, "") + "-3d.gcode",
        filters: [{ name: t("stream.dlgFilter"), extensions: ["gcode", "nc", "tap"] }]
      });
      if (filePath) {
        await writeFile(filePath, new TextEncoder().encode(gcode));
        log(t("gcw.saved", { p: filePath }));
      }
    } catch (err) {
      log(t("gcw.saveError", { e: String(err) }));
    }
  };
  const close = () => {
    closed = true;
    if (running) cancelPaths3d();
    viewer.destroy();
    ov.remove();
  };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("c3d-close").onclick = close;
}
