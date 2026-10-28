/**
 * ASSISTENT „Rohteil beidseitig planen“ (gegen Verzug durch innere Spannungen)
 *
 * Aus dem 3D-Fräsen aufrufbar (dort ist viel Materialabtrag üblich). Fläche, Tiefe je Seite und Werkzeug wählen,
 * „Als Auftrag laden“ – dann: Seite 1 fräsen, Platte wenden, Z neu nullen, denselben Auftrag noch einmal fräsen.
 * Die Bahn selbst entsteht in facing.ts.
 */
import { t, ascii } from "../i18n/i18n";
import { getTools, MillingTool, DEFAULT_PLUNGE, cutDiameter } from "../toolLibrary";
import { spindleCode } from "../spindleDir";
import { loadGcodeFromText } from "../machineStream";
import { facingPath, FacingParams } from "../facing";

const KEY = "cnc_craft_facing";
const SAFE_Z = 5.0; // wie cam.ts

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export interface FacingStart {
  x0: number; y0: number; w: number; h: number;
  thick: number;      // Materialdicke vorher (mm), 0 = unbekannt
  height: number;     // Höhe des Modells (mm), 0 = unbekannt
  spoil?: boolean;    // Opferplatte planen (eine Seite, ganzes Bett) statt Rohteil beidseitig
}

/** Werkzeug-Vorschlag: Planfräser, sonst der größte Schaft-/Torusfräser */
function pickTool(tools: MillingTool[]): MillingTool | null {
  const face = tools.filter(x => x.type === "facemill").sort((a, b) => b.diameter - a.diameter)[0];
  if (face) return face;
  return tools.filter(x => x.type === "endmill" || x.type === "bullnose").sort((a, b) => b.diameter - a.diameter)[0] || tools[0] || null;
}

/** G-Code für eine Seite (für beide Seiten derselbe) */
export function facingGcode(p: FacingParams, tool: MillingTool, rpm: number): string | null {
  const res = facingPath(p);
  if (!res.lines.length) return null;
  const c = (key: string, v?: Record<string, string | number>) => `(${ascii(t(key, v))})`;
  return [
    c("face.gcHead", { d: p.depth, w: p.w, h: p.h }),
    c("gc.tool", { name: tool.name, d: tool.diameter.toFixed(1) }),
    `G21 ${c("gc.unitMm")}`, `G90 ${c("gc.absolute")}`, "G17",
    `G0 Z${SAFE_Z.toFixed(2)} ${c("gc.safeZ")}`,
    `${spindleCode("M3")} S${Math.round(rpm)} ${c("gc.spindleOn", { rpm: Math.round(rpm) })}`,
    `G4 P3 ${c("gc.spinUp")}`,
    ...res.lines,
    `M5 ${c("gc.spindleOff")}`,
    `G0 X0 Y0 ${c("gc.park")}`,
    `M30 ${c("gc.end")}`,
  ].join("\n") + "\n";
}

/**
 * @param start   Fläche und Dicke (aus dem 3D-Fräsen)
 * @param onDone  nach „Als Auftrag laden“: Abtrag je Seite (z. B. um die Materialdicke anzupassen)
 */
export function openFacingDialog(start: FacingStart, log: (s: string) => void, onDone?: (depth: number) => void) {
  document.getElementById("face-overlay")?.remove();
  const tools = getTools();
  if (!tools.length) { log(t("face.noTool")); return; }
  const o = { depth: 0.5, toolId: pickTool(tools)!.id, stepZ: 0, over: 60, dir: "x" as "x" | "y", ...start };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (s.depth > 0) o.depth = s.depth;
    if (s.over > 0) o.over = s.over;
    if (s.dir === "x" || s.dir === "y") o.dir = s.dir;
    if (tools.some(x => x.id === s.toolId)) o.toolId = s.toolId;
  } catch { /* egal */ }
  const tool = () => tools.find(x => x.id === o.toolId) || tools[0];
  o.stepZ = Math.min(o.depth, +(tool().stepZ || 1).toFixed(2));

  // Opferplatte: eigene Texte (face.spoil.*), sonst wie „beidseitig planen“
  const k = (key: string) => (start.spoil ? key.replace(/^face\./, "face.spoil.") : key);
  const num = (id: string, label: string, unit = "mm", step = "0.1", tip = "") =>
    `<div class="dlg-row"${tip ? ` data-tip="${esc(t(tip))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="${id}" type="number" min="0" step="${step}" class="prop-input"><em>${unit}</em></span></div>`;
  const ov = document.createElement("div");
  ov.id = "face-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(520px, calc(100vw - 32px));">
      <h3>🪵 ${esc(t(k("face.title")))}</h3>
      <div class="dlg-hint">${esc(t(k("face.intro")))}</div>
      ${num("face-x0", "c3d.posX")}${num("face-y0", "c3d.posY")}
      ${num("face-w", "c3d.sizeX")}${num("face-h", "c3d.sizeY")}
      ${num("face-depth", "face.depth", "mm", "0.1", "face.depthTip")}
      <div class="dlg-row"><span>${esc(t("face.tool"))}</span>
        <select id="face-tool" class="prop-input" style="width:260px;max-width:60%;">${tools.map(x =>
          `<option value="${esc(x.id)}">${esc(x.name)} · Ø${x.diameter} · ${esc(t("tl.type." + x.type))}</option>`).join("")}</select></div>
      ${num("face-stepz", "c3d.stepDown")}
      ${num("face-over", "face.over", "%", "5")}
      <div class="dlg-row"><span>${esc(t("c3d.dir"))}</span><select id="face-dir" class="prop-input" style="width:auto;">
        <option value="x">${esc(t("c3d.dirX"))}</option><option value="y">${esc(t("c3d.dirY"))}</option></select></div>
      <div class="dlg-hint" id="face-info"></div>
      <div class="dlg-hint" id="face-warn" style="color:#ffb454;"></div>
      <ol class="dlg-hint" style="margin:6px 0 0 18px;padding:0;">
        ${(start.spoil ? [1, 2, 3] : [1, 2, 3, 4]).map(i => `<li>${esc(t(k("face.step" + i)))}</li>`).join("")}
      </ol>
      <div class="dlg-buttons">
        <button id="face-load" class="btn-primary">${esc(t("c3d.load"))}</button>
        <button id="face-close" class="btn-secondary" style="margin-left:auto;">${esc(t("dlg.close"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const fields: [string, "x0" | "y0" | "w" | "h" | "depth" | "stepZ" | "over"][] =
    [["face-x0", "x0"], ["face-y0", "y0"], ["face-w", "w"], ["face-h", "h"], ["face-depth", "depth"], ["face-stepz", "stepZ"], ["face-over", "over"]];
  for (const [id, k] of fields) $(id).value = String(+(+o[k]).toFixed(3));
  $<HTMLSelectElement>("face-tool").value = o.toolId;
  $<HTMLSelectElement>("face-dir").value = o.dir;

  const params = (): FacingParams => {
    const tl = tool();
    return {
      x0: o.x0, y0: o.y0, w: o.w, h: o.h, depth: o.depth, stepZ: o.stepZ || o.depth, toolD: cutDiameter(tl),
      stepOver: o.over / 100, feed: tl.feedrate || 800, plunge: tl.plungeFeed ?? DEFAULT_PLUNGE, safeZ: SAFE_Z, dir: o.dir,
    };
  };
  const refresh = () => {
    const p = params(), res = facingPath(p);
    const min = res.length / Math.max(1, p.feed);
    $<HTMLElement>("face-info").textContent = res.lines.length
      ? t(k("face.info"), { n: res.passes, r: res.rows, m: Math.max(1, Math.round(min)) })
        + (o.thick > 0 ? " " + t("face.after", { a: +(o.thick - 2 * o.depth).toFixed(2), b: o.thick }) : "")
      : t("face.invalid");
    $<HTMLElement>("face-warn").textContent = o.thick > 0 && o.height > 0 && o.thick - 2 * o.depth < o.height - 1e-6
      ? t("face.warnThin", { h: o.height }) : "";
    $<HTMLButtonElement>("face-load").disabled = !res.lines.length;
  };
  // Zustellung folgt dem Werkzeug und dem Abtrag, bis man sie selbst ändert
  let autoStep = true;
  const autoStepZ = () => { if (autoStep) { o.stepZ = Math.min(o.depth, +(tool().stepZ || 1).toFixed(2)); $("face-stepz").value = String(o.stepZ); } };
  for (const [id, k] of fields) $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v) && (v >= 0 || k === "x0" || k === "y0")) (o as any)[k] = v;
    if (k === "stepZ") autoStep = false;
    if (k === "depth") autoStepZ();
    refresh();
  });
  $<HTMLSelectElement>("face-tool").addEventListener("change", () => {
    o.toolId = $<HTMLSelectElement>("face-tool").value;
    autoStepZ();
    refresh();
  });
  $<HTMLSelectElement>("face-dir").addEventListener("change", () => { o.dir = $<HTMLSelectElement>("face-dir").value as "x" | "y"; refresh(); });
  $<HTMLButtonElement>("face-close").onclick = () => ov.remove();
  $<HTMLButtonElement>("face-load").onclick = () => {
    const tl = tool();
    const g = facingGcode(params(), tl, tl.rpm || 12000);
    if (!g) return;
    try { localStorage.setItem(KEY, JSON.stringify({ depth: o.depth, over: o.over, dir: o.dir, toolId: o.toolId })); } catch { /* egal */ }
    if (loadGcodeFromText(g, t(k("face.jobName"), { d: o.depth }), log)) {
      log(t(k("face.loaded"), { d: o.depth }));
      onDone?.(o.depth);
      ov.remove();
    }
  };
  refresh();
}
