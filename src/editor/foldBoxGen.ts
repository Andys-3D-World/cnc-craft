/**
 * FALTSCHACHTEL – Fenster (Generatoren): Bauart, Maße, Karton, Klappen, Verschluss, Fenster/Loch, Faltlinien.
 * Vorschau: rot = schneiden, blau gestrichelt = falten. Geometrie: foldBox.ts.
 *
 * Faltlinien liegen auf einer eigenen Ebene mit wenig Leistung, die vor der Schnitt-Ebene steht. Beim Fräsen werden sie nur
 * flach angeritzt; Plasma schneidet immer durch, dort geht der Generator nicht (plasmaCam lässt auch später Faltlinien weg).
 */
import { icon } from "../ui/icons";
import { loadSettings, matchDefaults, saveSettings } from "./genRun";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, createPolyline, newId } from "../shapeTransform";
import { addLayer, ensureLayerBefore, getLayer, getLayers, type LaserLayer } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { t } from "../i18n/i18n";
import { esc } from "../setupSheet";
import { foldBox, FOLD_OUTPUTS, FOLD_STYLES, type FoldBoxOptions, type FoldBoxResult, type FoldMsg, type XY } from "../foldBox";

const KEY = "cnc_craft_fold_box";
const FOLD_LAYER = "FOLD-SCORE", PERF_LAYER = "FOLD-PERF";
const FOLD_POWER = 15, FOLD_SPEED = 1500;
const DEF: FoldBoxOptions = { style: "tuck", width: 80, depth: 40, height: 120, outside: false, thickness: 0.5, flap: 20, clearance: 0.3,
  lock: true, windowW: 0, windowH: 0, hangD: 0, foldOut: "score" };
const NUMS = ["width", "depth", "height", "thickness", "flap", "clearance", "windowW", "windowH", "hangD"] as const;

function load(): FoldBoxOptions {
  try {
    const o: FoldBoxOptions = { ...DEF, ...matchDefaults(DEF, JSON.parse(loadSettings(KEY) || "{}")) };
    for (const k of NUMS) if (o[k] < 0) o[k] = DEF[k];
    if (!FOLD_STYLES.includes(o.style)) o.style = DEF.style;
    if (!FOLD_OUTPUTS.includes(o.foldOut)) o.foldOut = DEF.foldOut;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 1) => String(Number(v.toFixed(n)));
const msg = (m: FoldMsg) => t(m.key, m.vars);
const isFoldLayer = (l: LaserLayer) => l.id === FOLD_LAYER || l.id === PERF_LAYER || l.name === t("fold.layerScore") || l.name === t("fold.layerPerf");
/** Die normale Schnitt-Ebene: die stärkste Linien-Ebene, die keine Falz-Ebene ist */
const findCutLayer = () => getLayers().filter(l => l.mode === "line" && !isFoldLayer(l)).sort((a, b) => b.power - a.power)[0] as LaserLayer | undefined;

function previewSvg(r: FoldBoxResult, perforated: boolean): string {
  const pad = Math.max(r.w, r.h) * 0.02 + 1, sw = Math.max(r.w, r.h) / 450;
  const X = (x: number) => (x + pad).toFixed(2), Y = (y: number) => (r.h - y + pad).toFixed(2);
  const ring = (pts: XY[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x)},${Y(y)}`).join("") + "Z";
  const body = `<path d="${ring(r.outline)}${r.holes.map(ring).join("")}" fill="rgba(201,138,75,0.22)" fill-rule="evenodd" stroke="#ff6b5e" stroke-width="${sw.toFixed(2)}"/>`;
  const lines = (perforated ? r.dashes : r.folds).map(([a, b]) => `M${X(a[0])},${Y(a[1])}L${X(b[0])},${Y(b[1])}`).join("");
  const dash = perforated ? "" : ` stroke-dasharray="${(sw * 5).toFixed(2)} ${(sw * 3).toFixed(2)}"`;
  return `<svg viewBox="0 0 ${(r.w + 2 * pad).toFixed(2)} ${(r.h + 2 * pad).toFixed(2)}" style="width:100%;height:340px;">${body}<path d="${lines}" fill="none" stroke="#5aa9ff" stroke-width="${(sw * 1.2).toFixed(2)}"${dash}/></svg>`;
}

export function openFoldBoxDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  const mode = getMachineMode();
  document.getElementById("foldbox-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "foldbox-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>mm</em></span></label>`;
  const sel = (id: string, key: string, opts: string) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(900px, calc(100vw - 32px));">
      <h3>${icon("foldBox", 20)}${t("fold.title")}</h3>
      <div class="dlg-hint">${t("fold.desc")}</div>
      ${mode === "laser" ? "" : `<div class="dlg-hint" style="color:var(--lt-amber, #ffb454);">${t(mode === "plasma" ? "fold.modePlasma" : "fold.modeMill")}</div>`}
      <div style="display:grid;grid-template-columns:320px 1fr;gap:12px;align-items:start;">
        <div class="box-fields" style="max-height:62vh;overflow:auto;">
          ${sel("fb-style", "fold.style", FOLD_STYLES.map(k => `<option value="${k}">${t("fold.style." + k)}</option>`).join(""))}
          ${sel("fb-size", "fold.sizeMode", `<option value="in">${t("fold.inside")}</option><option value="out">${t("fold.outside")}</option>`)}
          ${num("fb-w", "fold.width", "1", "1")}
          ${num("fb-d", "fold.depth", "1", "1")}
          ${num("fb-h", "fold.height", "1", "1")}
          ${num("fb-t", "fold.thickness", "0.05", "0.1")}
          ${num("fb-flap", "fold.flap", "1", "1")}
          ${num("fb-cl", "fold.clearance", "0.05", "0")}
          <label class="dlg-row" style="cursor:pointer;" title="${t("fold.lockTip")}"><span>${t("fold.lock")}</span><input id="fb-lock" type="checkbox" style="width:auto;"></label>
          ${num("fb-win-w", "fold.windowW", "1", "0")}
          ${num("fb-win-h", "fold.windowH", "1", "0")}
          ${num("fb-hang", "fold.hang", "0.5", "0")}
          ${sel("fb-out", "fold.foldOut", FOLD_OUTPUTS.map(k => `<option value="${k}">${t("fold.foldOut." + k)}</option>`).join(""))}
        </div>
        <div class="box-prev" style="min-height:340px;"><div id="fb-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div class="dlg-hint"><span style="color:#ff6b5e;">━</span> ${t("fold.legendCut")} &nbsp; <span style="color:#5aa9ff;">╌</span> ${t("fold.legendFold")}</div>
          <div id="fb-info" class="dlg-hint"></div><div id="fb-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="fb-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="fb-ok" class="btn-primary">✔ ${t("fold.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, typeof NUMS[number]][] = [["fb-w", "width"], ["fb-d", "depth"], ["fb-h", "height"], ["fb-t", "thickness"], ["fb-flap", "flap"],
    ["fb-cl", "clearance"], ["fb-win-w", "windowW"], ["fb-win-h", "windowH"], ["fb-hang", "hangD"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("fb-style").value = init.style;
  $<HTMLSelectElement>("fb-size").value = init.outside ? "out" : "in";
  $<HTMLSelectElement>("fb-out").value = init.foldOut;
  $("fb-lock").checked = init.lock;
  // Perforation sind echte Schnitte – die gibt es nur am Laser, dort stimmt auch die Ebene
  $<HTMLSelectElement>("fb-out").disabled = mode !== "laser";

  const read = (): FoldBoxOptions => {
    // leeres Feld = 0: Die Geometrie meldet dann klar, was fehlt
    const n = (id: string, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0; };
    return {
      style: $<HTMLSelectElement>("fb-style").value as FoldBoxOptions["style"],
      width: n("fb-w", 5000), depth: n("fb-d", 5000), height: n("fb-h", 5000),
      outside: $<HTMLSelectElement>("fb-size").value === "out",
      thickness: n("fb-t", 100), flap: n("fb-flap", 5000), clearance: n("fb-cl", 2), lock: $("fb-lock").checked,
      windowW: n("fb-win-w", 5000), windowH: n("fb-win-h", 5000), hangD: n("fb-hang", 500),
      foldOut: $<HTMLSelectElement>("fb-out").value as FoldBoxOptions["foldOut"]
    };
  };

  let last: FoldBoxResult | null = null;
  const update = () => {
    const o = read();
    const r = foldBox(o);
    last = r;
    const svg = $<HTMLElement>("fb-svg"), info = $<HTMLElement>("fb-info"), warnEl = $<HTMLElement>("fb-warn");
    const blocked = r.errors.length > 0 || mode === "plasma";
    $<HTMLButtonElement>("fb-ok").disabled = blocked;
    if (r.errors.length) {
      svg.innerHTML = "";
      info.innerHTML = "";
      warnEl.innerHTML = r.errors.map(e => `<div>${msg(e)}</div>`).join("");
      return;
    }
    const perf = mode === "laser" && o.foldOut === "perforate";
    svg.innerHTML = previewSvg(r, perf);
    const bed = bedSizeMm();
    const lines = [t("fold.info", { w: f(r.w, 0), h: f(r.h, 0), iw: f(r.inner.w), id: f(r.inner.d), ih: f(r.inner.h), ow: f(r.outer.w), od: f(r.outer.d), oh: f(r.outer.h), tuck: f(r.lengths.tuck) }),
      t("fold.how." + o.style)];
    const warn = r.warnings.map(msg);
    if (r.w > bed.w + 1e-6 || r.h > bed.h + 1e-6) warn.push(t("fold.warnBed", { w: f(bed.w, 0), h: f(bed.h, 0) }));
    if (mode === "laser") {
      const cut = findCutLayer();
      const existing = getLayer(perf ? PERF_LAYER : FOLD_LAYER) || getLayers().find(l => l.name === t(perf ? "fold.layerPerf" : "fold.layerScore"));
      const name = existing ? existing.name : t(perf ? "fold.layerPerf" : "fold.layerScore");
      const power = existing ? existing.power : perf ? (cut?.power ?? 100) : FOLD_POWER;
      const speed = existing ? existing.speed : perf ? (cut?.speed ?? 300) : FOLD_SPEED;
      // die Namen können vom Nutzer stammen
      lines.push(t(perf ? "fold.infoPerf" : "fold.infoLayer", { name: esc(name), p: f(power), f: f(speed, 0) }));
      if (!perf && cut && power >= cut.power * 0.5) warn.push(t("fold.warnPower", { name: esc(name), p: f(power), cut: f(cut.power) }));
      if (perf) warn.push(t("fold.warnPerf"));
    }
    info.innerHTML = lines.map(s => `<div>${s}</div>`).join("");
    warnEl.innerHTML = warn.map(s => `<div>${s}</div>`).join("");
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" ? "change" : "input", update));
  update();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("fb-cancel").onclick = close;
  $<HTMLElement>("fb-ok").onclick = () => {
    update();
    const r = last;
    if (!r || r.errors.length || mode === "plasma") return;
    const o = read();
    saveSettings(KEY, o);
    close();
    place(r, o);
    log(t("fold.done", { w: f(r.w, 0), h: f(r.h, 0) }));
    done();
  };
}

function place(r: FoldBoxResult, o: FoldBoxOptions) {
  const st = app();
  const bed = bedSizeMm();
  const ox = Math.max(0, (bed.w - r.w) / 2), oy = Math.max(0, (bed.h - r.h) / 2);
  const laser = getMachineMode() === "laser";
  const perf = laser && o.foldOut === "perforate";
  const toW = (pts: XY[]) => pts.map(([x, y]) => ({ x: (x + ox) * MM_TO_PIXEL, y: (y + oy) * MM_TO_PIXEL }));

  let cutId: string | undefined, foldId: string | undefined;
  if (laser) {
    const cut = findCutLayer() || addLayer({ name: t("laser.defCut"), mode: "line", power: 100, speed: 300, passes: 1, air: true });
    cutId = cut.id;
    foldId = (perf
      ? ensureLayerBefore(PERF_LAYER, { name: t("fold.layerPerf"), power: cut.power, speed: cut.speed, passes: cut.passes, air: cut.air }, cut.id)
      : ensureLayerBefore(FOLD_LAYER, { name: t("fold.layerScore"), power: FOLD_POWER, speed: FOLD_SPEED, passes: 1, air: false }, cut.id)).id;
  }
  // Tiefen für die Fräse: Kontur ganz durch, Falz nur flach. Bleiben auch sicher, wenn später die Maschinenart wechselt.
  const groupId = "foldbox-" + newId(), source = t("fold.title").slice(0, 40);
  const common = { groupId, source };
  const cutExtra = { ...common, ...(cutId ? { laserLayerId: cutId } : {}), millingDepth: -o.thickness };
  const foldExtra = { ...common, ...(foldId ? { laserLayerId: foldId } : {}), millingDepth: -Math.min(0.3, o.thickness * 0.4), foldLine: true };
  const made: any[] = [];
  // Perforation ist kein Anritzen: andere Rolle, damit „Mit Generator bearbeiten“ beim Umschalten nie die alte Ebene übernimmt
  for (const [a, b] of perf ? r.dashes : r.folds) made.push(createPolyline(toW([a, b]), false, "on-line", perf ? foldExtra : { ...foldExtra, isScore: true }));
  for (const h of r.holes) made.push(createPolyline(toW(h), true, "inside", cutExtra));
  made.push(createPolyline(toW(r.outline), true, "outside", cutExtra));
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
