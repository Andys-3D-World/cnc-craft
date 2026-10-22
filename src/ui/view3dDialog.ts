/**
 * 3D-ANSICHT: so sieht das Ergebnis aus – ausgeschnittene Teile aus Holz, Acryl … oder die Gravur auf dem
 * runden Teil (Drehachse). Frei drehbar mit der Maus (siehe view3d/viewer3d.ts).
 */
import { t } from "../i18n/i18n";
import { Viewer3D } from "../view3d/viewer3d";
import { partsScene, cylinderScene } from "../view3d/scenes";
import { MATERIALS, materialView } from "../materialView";
import { rotary } from "../rotary";
import { isLaser } from "../machineMode";

const KEY = "cnc_craft_view3d";
function state(): any { return (window as any).cncState; }

export function openView3D(want: "auto" | "parts" | "cylinder" = "auto") {
  const shapes: any[] = state()?.shapes || [];
  document.getElementById("v3d-dialog-overlay")?.remove();
  let o = { material: materialView()?.id || "birch", thickness: isLaser() ? 3 : 6, sheet: false, lift: 12, spin: false };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* egal */ }
  if (!isLaser()) {
    // Fräse: Dicke = tiefste Schnitttiefe (falls vorhanden)
    const deep = Math.max(0, ...shapes.map(s => Math.abs(Number(s.millingDepth) || 0)));
    if (deep > 0) o.thickness = deep;
  }
  const canCyl = rotary.on && isLaser();
  let mode: "parts" | "cylinder" = want === "auto" ? (canCyl ? "cylinder" : "parts") : want;
  const ov = document.createElement("div");
  ov.id = "v3d-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1000px, calc(100vw - 32px));">
      <h3>🧊 ${t("v3d.title")}</h3>
      <canvas id="v3d-cv" style="width:100%;height:min(520px, calc(100vh - 260px));border-radius:10px;cursor:grab;display:block;"></canvas>
      <div class="v3d-bar">
        ${canCyl ? `<select id="v3d-mode" class="prop-input" style="width:auto;"><option value="parts">${t("v3d.modeParts")}</option><option value="cylinder">${t("v3d.modeCyl")}</option></select>` : ""}
        <label>${t("rot.material")} <select id="v3d-mat" class="prop-input" style="width:auto;">
          ${MATERIALS.map(m => `<option value="${m.id}">${t("mat3d." + m.id)}</option>`).join("")}</select></label>
        <label class="v3d-parts">${t("v3d.thick")} <input id="v3d-thick" type="number" min="0.2" step="0.5" class="prop-input" style="width:70px;"></label>
        <label class="eng-ck v3d-parts"><input type="checkbox" id="v3d-sheet"> ${t("v3d.sheet")}</label>
        <label class="v3d-parts v3d-lift">${t("v3d.lift")} <input id="v3d-lift" type="range" min="0" max="60" step="1" style="width:110px;"></label>
        <label class="eng-ck"><input type="checkbox" id="v3d-spin"> ${t("rot.spin")}</label>
        <span class="dlg-hint" id="v3d-info" style="margin-left:auto;"></span>
      </div>
      <div class="dlg-hint">${t("v3d.hint")}</div>
      <div class="dlg-buttons"><button id="v3d-close" class="btn-primary" style="margin-left:auto;">${t("dlg.close")}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const viewer = new Viewer3D($<HTMLCanvasElement>("v3d-cv"));
  const info = $<HTMLElement>("v3d-info");
  $<HTMLSelectElement>("v3d-mat").value = o.material;
  $("v3d-thick").value = String(o.thickness);
  $("v3d-sheet").checked = o.sheet;
  $("v3d-lift").value = String(o.lift);
  $("v3d-spin").checked = o.spin;
  if (canCyl) $<HTMLSelectElement>("v3d-mode").value = mode;

  const build = (keepView: boolean) => {
    const m = MATERIALS.find(x => x.id === o.material) || MATERIALS[0];
    ov.querySelectorAll<HTMLElement>(".v3d-parts").forEach(el => { el.style.display = mode === "parts" ? "" : "none"; });
    ov.querySelector<HTMLElement>(".v3d-lift")!.style.display = mode === "parts" && o.sheet ? "" : "none";
    if (!viewer.ok) { info.textContent = t("v3d.noGl"); return; }
    if (!shapes.length) { info.textContent = t("v3d.empty"); return; }
    if (mode === "cylinder") {
      viewer.setMeshes(cylinderScene(shapes, m, rotary.diameter), keepView);
      info.textContent = t("rot.info", { c: (Math.PI * rotary.diameter).toFixed(1), d: rotary.diameter }).replace(/ – .*$/, "");
    } else {
      const r = partsScene(shapes, m, { thickness: o.thickness, sheet: o.sheet, lift: o.lift });
      viewer.setMeshes(r.meshes, keepView);
      info.textContent = r.parts ? t("v3d.parts", { n: r.parts, t: o.thickness }) : t("v3d.noCut", { t: o.thickness });
    }
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ } };
  $<HTMLSelectElement>("v3d-mat").addEventListener("change", e => { o.material = (e.target as HTMLSelectElement).value; save(); build(true); });
  $("v3d-thick").addEventListener("change", () => { const v = parseFloat($("v3d-thick").value); if (v > 0) { o.thickness = v; save(); build(true); } });
  $("v3d-sheet").addEventListener("change", () => { o.sheet = $("v3d-sheet").checked; save(); build(true); });
  $("v3d-lift").addEventListener("input", () => { o.lift = parseFloat($("v3d-lift").value) || 0; save(); build(true); });
  $("v3d-spin").addEventListener("change", () => { o.spin = $("v3d-spin").checked; viewer.spin = o.spin; save(); });
  if (canCyl) $<HTMLSelectElement>("v3d-mode").addEventListener("change", e => { mode = (e.target as HTMLSelectElement).value === "cylinder" ? "cylinder" : "parts"; build(false); });
  viewer.spin = o.spin;
  build(false);

  const close = () => { viewer.destroy(); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("v3d-close").onclick = close;
}
