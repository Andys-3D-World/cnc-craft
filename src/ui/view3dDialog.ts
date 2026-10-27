/**
 * 3D-ANSICHT: so sieht das Ergebnis aus – ausgeschnittene Teile aus Holz, Acryl … oder die Gravur auf dem
 * runden Teil (Drehachse). Frei drehbar mit der Maus (siehe view3d/viewer3d.ts).
 * Fräse zusätzlich (Standard): „Fräsergebnis“ – Materialabtrag aus dem echten G-Code mit der Form der Fräser
 * (view3d/carveSim.ts): Taschen, V-Carve, Inlays, stehen gebliebenes Material in Innenecken.
 */
import { t } from "../i18n/i18n";
import { Viewer3D } from "../view3d/viewer3d";
import { partsScene, cylinderScene, carveScene } from "../view3d/scenes";
import { carve, CarveResult } from "../view3d/carveSim";
import { generateGcode, noGcodeMessage, orderToolGroups, lastThreads } from "../cam";
import { threadMeshes } from "../view3d/threadMesh";
import { MATERIALS, materialView } from "../materialView";
import { rotary } from "../rotary";
import { isLaser, isPlasma } from "../machineMode";

const KEY = "cnc_craft_view3d";
function state(): any { return (window as any).cncState; }

type Mode = "parts" | "cylinder" | "carve";

/** zuletzt berechnetes Fräsergebnis (gleicher G-Code -> nicht neu rechnen) */
let carveCache: { key: string; res: CarveResult | null } | null = null;

export function openView3D(want: "auto" | Mode = "auto") {
  const shapes: any[] = state()?.shapes || [];
  document.getElementById("v3d-dialog-overlay")?.remove();
  let o = { material: materialView()?.id || "birch", thickness: isLaser() ? 3 : 6, sheet: false, lift: 12, spin: false, carveT: 0 };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* egal */ }
  if (!isLaser()) {
    // Fräse: Dicke = tiefste Schnitttiefe (falls vorhanden)
    const deep = Math.max(0, ...shapes.map(s => Math.abs(Number(s.millingDepth) || 0)));
    if (deep > 0) o.thickness = deep;
  }
  const canCyl = rotary.on && isLaser();
  const mill = !isLaser() && !isPlasma();
  const modes: Mode[] = mill ? ["carve", "parts"] : canCyl ? ["parts", "cylinder"] : ["parts"];
  let mode: Mode = want === "auto" ? (canCyl ? "cylinder" : modes[0]) : modes.includes(want) ? want : modes[0];
  // Fräsergebnis: Materialdicke = Tiefe der Durchschnitte (außen/innen), sonst tiefste Stelle + 5 mm
  const autoCarveT = () => {
    const d = (list: any[]) => Math.max(0, ...list.map(s => Math.abs(Number(s.millingDepth) || 0)));
    const through = d(shapes.filter(s => s.millingMode === "outside" || s.millingMode === "inside"));
    return +(through > 0 ? through : Math.max(3, d(shapes) + 5)).toFixed(2);
  };
  const carveT = () => (o.carveT > 0 ? o.carveT : autoCarveT());
  const ov = document.createElement("div");
  ov.id = "v3d-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1000px, calc(100vw - 32px));">
      <h3>🧊 ${t("v3d.title")}</h3>
      <canvas id="v3d-cv" style="width:100%;height:min(520px, calc(100vh - 260px));border-radius:10px;cursor:grab;display:block;"></canvas>
      <div class="v3d-bar">
        ${modes.length > 1 ? `<select id="v3d-mode" class="prop-input" style="width:auto;">${modes.map(md =>
          `<option value="${md}">${t(md === "parts" ? "v3d.modeParts" : md === "cylinder" ? "v3d.modeCyl" : "v3d.modeCarve")}</option>`).join("")}</select>` : ""}
        <label>${t("rot.material")} <select id="v3d-mat" class="prop-input" style="width:auto;">
          ${MATERIALS.map(m => `<option value="${m.id}">${t("mat3d." + m.id)}</option>`).join("")}</select></label>
        <label class="v3d-thickrow">${t("v3d.thick")} <input id="v3d-thick" type="number" min="0.2" step="0.5" class="prop-input" style="width:70px;"></label>
        <label class="eng-ck v3d-parts"><input type="checkbox" id="v3d-sheet"> ${t("v3d.sheet")}</label>
        <label class="v3d-parts v3d-lift">${t("v3d.lift")} <input id="v3d-lift" type="range" min="0" max="60" step="1" style="width:110px;"></label>
        <label class="eng-ck"><input type="checkbox" id="v3d-spin"> ${t("rot.spin")}</label>
        <span class="dlg-hint" id="v3d-info" style="margin-left:auto;"></span>
      </div>
      <div class="dlg-hint" id="v3d-hint"></div>
      <div class="dlg-buttons"><button id="v3d-close" class="btn-primary" style="margin-left:auto;">${t("dlg.close")}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const viewer = new Viewer3D($<HTMLCanvasElement>("v3d-cv"));
  const info = $<HTMLElement>("v3d-info");
  $<HTMLSelectElement>("v3d-mat").value = o.material;
  $("v3d-sheet").checked = o.sheet;
  $("v3d-lift").value = String(o.lift);
  $("v3d-spin").checked = o.spin;
  if (modes.length > 1) $<HTMLSelectElement>("v3d-mode").value = mode;

  let run = 0; // laufende Berechnung (neuer Aufbau / Schließen bricht die alte ab)
  let closed = false;
  const build = async (keepView: boolean) => {
    const my = ++run;
    const m = MATERIALS.find(x => x.id === o.material) || MATERIALS[0];
    ov.querySelectorAll<HTMLElement>(".v3d-parts").forEach(el => { el.style.display = mode === "parts" ? "" : "none"; });
    ov.querySelector<HTMLElement>(".v3d-thickrow")!.style.display = mode === "cylinder" ? "none" : "";
    ov.querySelector<HTMLElement>(".v3d-lift")!.style.display = mode === "parts" && o.sheet ? "" : "none";
    $("v3d-thick").value = String(mode === "carve" ? carveT() : o.thickness);
    $<HTMLElement>("v3d-hint").textContent = t(mode === "carve" ? "v3d.hintCarve" : "v3d.hint");
    if (!viewer.ok) { info.textContent = t("v3d.noGl"); return; }
    if (!shapes.length) { info.textContent = t("v3d.empty"); return; }
    if (mode === "cylinder") {
      viewer.setMeshes(cylinderScene(shapes, m, rotary.diameter), keepView);
      info.textContent = t("rot.info", { c: (Math.PI * rotary.diameter).toFixed(1), d: rotary.diameter }).replace(/ – .*$/, "");
    } else if (mode === "carve") {
      // G-Code wie für die Maschine (ohne Drehachse), Fräser je Abschnitt in derselben Reihenfolge wie im G-Code
      const g = generateGcode(shapes, { flat: true });
      if (!g) { viewer.setMeshes([], keepView); info.textContent = noGcodeMessage(); return; }
      const key = g + "|" + JSON.stringify(orderToolGroups(shapes).map(x => x.tool));
      let res: CarveResult | null;
      if (carveCache?.key === key) res = carveCache.res;
      else {
        info.textContent = t("v3d.carving", { p: 0 });
        const tools = orderToolGroups(shapes).map(x => x.tool);
        res = await carve(g.split("\n"), tools, f => {
          if (my !== run || closed) return false;
          info.textContent = t("v3d.carving", { p: Math.round(f * 100) });
          return true;
        });
        if (my !== run || closed) return;
        carveCache = { key, res };
      }
      if (!res) { viewer.setMeshes([], keepView); info.textContent = t("v3d.carveEmpty"); return; }
      const T = carveT();
      // Gewindegänge zeigt das Höhenraster nicht – als eigenes Netz dazu (threadMesh.ts)
      const threads = [...lastThreads];
      viewer.setMeshes([...carveScene(res, m, T), ...threadMeshes(threads, T, [m.base[0] / 255 * 0.8, m.base[1] / 255 * 0.8, m.base[2] / 255 * 0.8])], keepView);
      info.textContent = t("v3d.carveInfo", { d: (-res.minZ).toFixed(2), c: res.cell.toFixed(2) })
        + (-res.minZ > T + 1e-3 ? " · " + t("v3d.carveThrough", { t: T }) : "");
    } else {
      const r = partsScene(shapes, m, { thickness: o.thickness, sheet: o.sheet, lift: o.lift });
      viewer.setMeshes(r.meshes, keepView);
      info.textContent = r.parts ? t("v3d.parts", { n: r.parts, t: o.thickness }) : t("v3d.noCut", { t: o.thickness });
    }
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ } };
  $<HTMLSelectElement>("v3d-mat").addEventListener("change", e => { o.material = (e.target as HTMLSelectElement).value; save(); build(true); });
  $("v3d-thick").addEventListener("change", () => {
    const v = parseFloat($("v3d-thick").value);
    if (!(v > 0)) return;
    if (mode === "carve") o.carveT = v; else o.thickness = v;
    save(); build(true);
  });
  $("v3d-sheet").addEventListener("change", () => { o.sheet = $("v3d-sheet").checked; save(); build(true); });
  $("v3d-lift").addEventListener("input", () => { o.lift = parseFloat($("v3d-lift").value) || 0; save(); build(true); });
  $("v3d-spin").addEventListener("change", () => { o.spin = $("v3d-spin").checked; viewer.spin = o.spin; save(); });
  if (modes.length > 1) $<HTMLSelectElement>("v3d-mode").addEventListener("change", e => {
    const v = (e.target as HTMLSelectElement).value as Mode;
    mode = modes.includes(v) ? v : modes[0];
    build(false);
  });
  viewer.spin = o.spin;
  build(false);

  const close = () => { closed = true; viewer.destroy(); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("v3d-close").onclick = close;
}
