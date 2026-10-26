/**
 * LASER-BEDIENUNG RECHTS (wie das "Cuts / Layers"-Fenster in LightBurn)
 *
 *  - Umschalter Fräse / Laser / Plasma (ganz oben im rechten Panel)
 *  - Reiter "Objekt": Liste der Laser-Ebenen
 *      Klick auf eine Ebene: ausgewählte Formen kommen auf diese Ebene
 *                            (ohne Auswahl: wird Standard-Ebene für alle Formen ohne Ebene)
 *      ✎ bearbeiten, ▲▼ Reihenfolge (= Laser-Reihenfolge), ＋ neue Ebene
 *  - Reiter "Fräsen": Laser-Einstellungen (S-Max, M4/M3)
 */
import { t, T, tip } from "../i18n/i18n";
import {
  getLayers, activeLayer, setActiveLayer, layerForShape, getLayer, layerInfo,
  openLayerDialog, moveLayer, laserSettings, setLaserSettings, LAYERS_CHANGED
} from "../laserLayers";
import { getMachineMode, setMachineMode, MODE_CHANGED, MachineMode } from "../machineMode";

function state(): any {
  return (window as any).cncState;
}
function selectedShapes(): any[] {
  const st = state();
  if (!st) return [];
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id));
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Umschalter ganz oben im rechten Panel */
export function modeSwitchHtml(): string {
  return `
    <div class="machine-switch" role="tablist">
      <button class="ms-btn" data-mode="mill" ${tip("mode.millTip")}>🛠️ ${T("mode.mill")}</button>
      <button class="ms-btn" data-mode="laser" ${tip("mode.laserTip")}>🔦 ${T("mode.laser")}</button>
      <button class="ms-btn" data-mode="plasma" ${tip("mode.plasmaTip")}>🔥 ${T("mode.plasma")}</button>
    </div>`;
}

/** Reiter "Objekt" im Laser-Modus */
export function laserLayersHtml(): string {
  return `
    <div class="menu-section-unified only-laser">
      <h3 class="menu-trigger">${T("laser.layers")}</h3>
      <div class="menu-body rp-box">
        <div id="laser-layer-list" class="ll-list"></div>
        <button id="laser-layer-new" class="btn-secondary btn-compact" ${tip("laser.newTip")}>＋ ${T("laser.newLayer")}</button>
        <div id="laser-layer-scope" class="tool-scope"></div>
      </div>
    </div>`;
}

/** Reiter "Fräsen" im Laser-Modus */
export function laserSettingsHtml(): string {
  return `
    <div class="menu-section-unified only-laser">
      <h3 class="menu-trigger">${T("laser.settings")}</h3>
      <div class="menu-body rp-box">
        <div class="prop-row" ${tip("laser.sMaxTip")}>${T("laser.sMax")}<input type="number" id="laser-smax" min="1" step="1" class="prop-input"></div>
        <label class="prop-row" style="cursor:pointer;" ${tip("laser.dynamicTip")}><span>${T("laser.dynamic")}</span><input type="checkbox" id="laser-dynamic" style="width:auto;"></label>
        <label class="prop-row" style="cursor:pointer;" ${tip("cam.avoidCutTip")}><span>${T("cam.avoidCut")}</span><input type="checkbox" id="laser-avoid" style="width:auto;"></label>
        <div class="tool-scope">${T("laser.grblHint")}</div>
      </div>
    </div>`;
}

let lastSig = "";

export function initLaserPanel(redraw: () => void) {
  // ---- Umschalter ----
  const syncSwitch = () => {
    const m = getMachineMode();
    document.querySelectorAll<HTMLElement>(".ms-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  };
  document.querySelectorAll<HTMLElement>(".ms-btn").forEach(b => b.addEventListener("click", () => {
    setMachineMode(b.dataset.mode as MachineMode);
  }));
  window.addEventListener(MODE_CHANGED, () => { syncSwitch(); refreshLaserPanel(true); redraw(); });
  syncSwitch();

  // ---- Ebenen-Liste ----
  const list = document.getElementById("laser-layer-list");
  // Doppelklick selbst erkennen: nach dem ersten Klick wird die Liste neu aufgebaut,
  // dann käme das normale "dblclick"-Ereignis nicht mehr an
  let lastClick = { id: "", time: 0 };
  list?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest("[data-layer-id]") as HTMLElement | null;
    if (!row) return;
    const id = row.dataset.layerId!;
    const layer = getLayer(id);
    if (!layer) return;
    const act = (target.closest("[data-act]") as HTMLElement | null)?.dataset.act;
    if (act === "edit") { openLayerDialog(layer, () => { refreshLaserPanel(true); redraw(); }); return; }
    if (act === "up") { moveLayer(id, -1); return; }
    if (act === "down") { moveLayer(id, 1); return; }
    const now = performance.now();
    if (lastClick.id === id && now - lastClick.time < 450) {
      lastClick = { id: "", time: 0 };
      openLayerDialog(layer, () => { refreshLaserPanel(true); redraw(); });
      return;
    }
    lastClick = { id, time: now };
    // Zeile angeklickt: zuordnen
    const shapes = selectedShapes();
    if (shapes.length) shapes.forEach(s => { s.laserLayerId = id; });
    else setActiveLayer(id);
    refreshLaserPanel(true);
    redraw();
  });

  document.getElementById("laser-layer-new")?.addEventListener("click", () => {
    openLayerDialog(null, (layer) => {
      if (!layer) return;
      const shapes = selectedShapes();
      if (shapes.length) shapes.forEach(s => { s.laserLayerId = layer.id; });
      refreshLaserPanel(true);
      redraw();
    });
  });

  // ---- Laser-Einstellungen ----
  const smax = document.getElementById("laser-smax") as HTMLInputElement | null;
  const dyn = document.getElementById("laser-dynamic") as HTMLInputElement | null;
  const avoid = document.getElementById("laser-avoid") as HTMLInputElement | null;
  if (smax) {
    smax.value = String(laserSettings.sMax);
    smax.addEventListener("change", () => { setLaserSettings({ sMax: parseFloat(smax.value) }); smax.value = String(laserSettings.sMax); });
  }
  if (dyn) {
    dyn.checked = laserSettings.dynamic;
    dyn.addEventListener("change", () => setLaserSettings({ dynamic: dyn.checked }));
  }
  if (avoid) {
    avoid.checked = laserSettings.avoidCut;
    avoid.addEventListener("change", () => setLaserSettings({ avoidCut: avoid.checked }));
  }

  // Einstellungen von woanders geändert (Bibliothek, Import): Felder nachziehen
  const syncFields = () => {
    if (smax && document.activeElement !== smax) smax.value = String(laserSettings.sMax);
    if (dyn) dyn.checked = laserSettings.dynamic;
    if (avoid) avoid.checked = laserSettings.avoidCut;
  };
  window.addEventListener(LAYERS_CHANGED, () => { syncFields(); refreshLaserPanel(true); });
  window.addEventListener("cnc-language-changed", () => refreshLaserPanel(true));
  refreshLaserPanel(true);
}

/** Liste neu zeichnen, wenn sich Auswahl/Zuordnung geändert hat (aus der Zeichenschleife) */
export function refreshLaserPanel(force = false) {
  const list = document.getElementById("laser-layer-list");
  const st = state();
  if (!list || !st) return;
  if (getMachineMode() !== "laser" && !force) return;
  const sig = st.selectedShapeIds.join(",") + "|" + st.shapes.length + "|"
    + st.shapes.map((s: any) => s.laserLayerId || "").join(",") + "|" + (activeLayer?.id || "");
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const shapes = selectedShapes();
  const selLayers = new Set(shapes.map(s => layerForShape(s)?.id));
  const counts = new Map<string, number>();
  for (const s of st.shapes) { const l = layerForShape(s); if (l) counts.set(l.id, (counts.get(l.id) || 0) + 1); }

  const layers = getLayers();
  list.innerHTML = layers.map((l, i) => `
    <div class="ll-row${selLayers.has(l.id) ? " sel" : ""}" data-layer-id="${l.id}" data-tip="${esc(t(shapes.length ? "laser.rowTipAssign" : "laser.rowTipDefault"))}">
      <span class="ll-swatch" style="background:${l.color}">${l.mode !== "line" ? "▦" : ""}</span>
      <span class="ll-text">
        <span class="ll-name">${esc(l.name)}${activeLayer && activeLayer.id === l.id ? ` <em class="ll-def">${esc(t("laser.default"))}</em>` : ""}</span>
        <span class="ll-info">${esc(layerInfo(l))}</span>
      </span>
      <span class="ll-count">${counts.get(l.id) || ""}</span>
      <span class="ll-btns">
        <button data-act="up" ${i === 0 ? "disabled" : ""} data-tip="${esc(t("laser.upTip"))}">▲</button>
        <button data-act="down" ${i === layers.length - 1 ? "disabled" : ""} data-tip="${esc(t("laser.downTip"))}">▼</button>
        <button data-act="edit" data-tip="${esc(t("laser.editTip"))}">✎</button>
      </span>
    </div>`).join("");

  const scope = document.getElementById("laser-layer-scope");
  if (scope) scope.textContent = shapes.length ? t("laser.scopeSelection", { n: shapes.length }) : t("laser.scopeDefault");
}
