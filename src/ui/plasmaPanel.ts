/**
 * PLASMA-BEDIENUNG RECHTS
 *
 *  - Reiter "Objekt": Liste der Plasma-Schnitte (wie die Laser-Ebenen)
 *      Klick: ausgewählte Formen bekommen diesen Schnitt (ohne Auswahl: Standard-Schnitt)
 *      Doppelklick / ✎: bearbeiten, ▲▼ Reihenfolge, ＋ neuer Schnitt
 *    Die Bahn-Korrektur (außen/innen/auf Linie) kommt vom Fräsen und gilt auch hier.
 *  - Reiter "Plasma": Maschinen-Einstellungen (Sicherheitshöhe, Z-Achse, Abtasten, Überlauf)
 *    und Höhenregelung (THC: keine / externe Box über M8/M7 / grblHAL-Plugin),
 *    Anti-Dive und kleine Löcher (ohne THC, langsamer)
 */
import { t, T, tip } from "../i18n/i18n";
import {
  getCuts, activeCut, setActiveCut, cutForShape, getCut, cutInfo, openCutDialog, moveCut,
  plasmaSettings, setPlasmaSettings, PLASMA_CHANGED
} from "../plasmaCuts";
import { getMachineMode, MODE_CHANGED } from "../machineMode";

function state(): any { return (window as any).cncState; }
function selectedShapes(): any[] {
  const st = state();
  if (!st) return [];
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id));
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export function plasmaCutsHtml(): string {
  return `
    <div class="menu-section-unified only-plasma">
      <h3 class="menu-trigger">${T("plasma.cuts")}</h3>
      <div class="menu-body rp-box">
        <div id="plasma-cut-list" class="ll-list"></div>
        <button id="plasma-cut-new" class="btn-secondary btn-compact" ${tip("plasma.newTip")}>＋ ${T("plasma.newCut")}</button>
        <div id="plasma-cut-scope" class="tool-scope"></div>
      </div>
    </div>`;
}

export function plasmaSettingsHtml(): string {
  return `
    <div class="menu-section-unified only-plasma">
      <h3 class="menu-trigger">${T("plasma.settings")}</h3>
      <div class="menu-body rp-box">
        <label class="prop-row" style="cursor:pointer;" ${tip("plasma.useZTip")}><span>${T("plasma.useZ")}</span><input type="checkbox" id="plasma-usez" style="width:auto;"></label>
        <div class="prop-row">${T("plasma.safeZ")}<input type="number" id="plasma-safez" min="0" step="1" class="prop-input"></div>
        <label class="prop-row" style="cursor:pointer;" ${tip("plasma.probeTip")}><span>${T("plasma.probe")}</span><input type="checkbox" id="plasma-probe" style="width:auto;"></label>
        <div class="prop-row" ${tip("plasma.probeOffsetTip")}>${T("plasma.probeOffset")}<input type="number" id="plasma-probe-offset" step="0.1" class="prop-input"></div>
        <div class="prop-row" ${tip("plasma.overcutTip")}>${T("plasma.overcut")}<input type="number" id="plasma-overcut" min="0" step="0.5" class="prop-input"></div>
        <div class="tool-scope">${T("plasma.hint")}</div>
      </div>
    </div>
    <div class="menu-section-unified only-plasma">
      <h3 class="menu-trigger">${T("thc.title")}</h3>
      <div class="menu-body rp-box">
        <div class="prop-row" ${tip("thc.modeTip")}>${T("thc.mode")}
          <select id="plasma-thc" class="prop-input" style="width: 130px;">
            <option value="none" data-i18n="thc.none">${T("thc.none")}</option>
            <option value="external" data-i18n="thc.external">${T("thc.external")}</option>
            <option value="grblhal" data-i18n="thc.grblhal">${T("thc.grblhal")}</option>
          </select>
        </div>
        <div class="prop-row thc-ext" ${tip("thc.outTip")}>${T("thc.out")}
          <select id="plasma-thc-out" class="prop-input" style="width: 130px;">
            <option value="M8">M8 (Flood)</option>
            <option value="M7">M7 (Mist)</option>
          </select>
        </div>
        <div class="prop-row thc-hal" ${tip("thc.antiDiveTip")}>${T("thc.antiDive")}<input type="number" id="plasma-antidive" min="0" step="1" class="prop-input"></div>
        <div class="prop-row" ${tip("thc.smallHoleTip")}>${T("thc.smallHole")}<input type="number" id="plasma-smallhole" min="0" step="1" class="prop-input"></div>
        <div class="prop-row" ${tip("thc.holeSpeedTip")}>${T("thc.holeSpeed")}<input type="number" id="plasma-holespeed" min="10" max="100" step="5" class="prop-input"></div>
        <div id="thc-hint" class="tool-scope"></div>
      </div>
    </div>`;
}

let lastSig = "";

/** THC-Zeilen passend zur gewählten Art ein-/ausblenden und Hinweis setzen */
export function syncThc() {
  const m = plasmaSettings.thc;
  document.querySelectorAll<HTMLElement>(".thc-ext").forEach(e => { e.style.display = m === "external" ? "" : "none"; });
  document.querySelectorAll<HTMLElement>(".thc-hal").forEach(e => { e.style.display = m === "grblhal" ? "" : "none"; });
  const h = document.getElementById("thc-hint");
  if (h) h.textContent = t("thc.hint." + m, { out: plasmaSettings.thcOut });
  window.dispatchEvent(new CustomEvent("cnc-thc-changed"));
}

export function initPlasmaPanel(redraw: () => void) {
  const list = document.getElementById("plasma-cut-list");
  let lastClick = { id: "", time: 0 };
  const edit = (id: string) => {
    const cut = getCut(id);
    if (cut) openCutDialog(cut, () => { refreshPlasmaPanel(true); redraw(); });
  };
  list?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest("[data-cut-id]") as HTMLElement | null;
    if (!row) return;
    const id = row.dataset.cutId!;
    const act = (target.closest("[data-act]") as HTMLElement | null)?.dataset.act;
    if (act === "edit") { edit(id); return; }
    if (act === "up") { moveCut(id, -1); return; }
    if (act === "down") { moveCut(id, 1); return; }
    const now = performance.now();
    if (lastClick.id === id && now - lastClick.time < 450) { lastClick = { id: "", time: 0 }; edit(id); return; }
    lastClick = { id, time: now };
    const shapes = selectedShapes();
    if (shapes.length) shapes.forEach(s => { s.plasmaCutId = id; });
    else setActiveCut(id);
    refreshPlasmaPanel(true);
    redraw();
  });

  document.getElementById("plasma-cut-new")?.addEventListener("click", () => {
    openCutDialog(null, (cut) => {
      if (!cut) return;
      const shapes = selectedShapes();
      if (shapes.length) shapes.forEach(s => { s.plasmaCutId = cut.id; });
      refreshPlasmaPanel(true);
      redraw();
    });
  });

  // ---- Einstellungen ----
  const bindNum = (id: string, key: "safeZ" | "probeOffset" | "overcut" | "antiDive" | "smallHole" | "holeSpeed") => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.value = String(plasmaSettings[key]);
    el.addEventListener("change", () => { setPlasmaSettings({ [key]: parseFloat(el.value) }); el.value = String(plasmaSettings[key]); });
  };
  const bindCheck = (id: string, key: "useZ" | "probe") => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.checked = plasmaSettings[key];
    el.addEventListener("change", () => { setPlasmaSettings({ [key]: el.checked }); syncEnabled(); });
  };
  const syncEnabled = () => {
    const z = plasmaSettings.useZ;
    ["plasma-safez", "plasma-probe", "plasma-probe-offset"].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.disabled = !z || (id === "plasma-probe-offset" && !plasmaSettings.probe);
    });
  };
  bindNum("plasma-safez", "safeZ");
  bindNum("plasma-probe-offset", "probeOffset");
  bindNum("plasma-overcut", "overcut");
  bindCheck("plasma-usez", "useZ");
  bindCheck("plasma-probe", "probe");
  bindNum("plasma-antidive", "antiDive");
  bindNum("plasma-smallhole", "smallHole");
  bindNum("plasma-holespeed", "holeSpeed");
  const bindSel = (id: string, key: "thc" | "thcOut") => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (!el) return;
    el.value = plasmaSettings[key];
    el.addEventListener("change", () => { setPlasmaSettings({ [key]: el.value } as any); el.value = plasmaSettings[key]; syncThc(); });
  };
  bindSel("plasma-thc", "thc");
  bindSel("plasma-thc-out", "thcOut");
  syncEnabled();
  syncThc();
  window.addEventListener("cnc-language-changed", syncThc);

  // Einstellungen von woanders geändert (Bibliothek, Import): Felder nachziehen
  const syncFields = () => {
    const nums: [string, keyof typeof plasmaSettings][] = [["plasma-safez", "safeZ"], ["plasma-probe-offset", "probeOffset"], ["plasma-overcut", "overcut"],
      ["plasma-antidive", "antiDive"], ["plasma-smallhole", "smallHole"], ["plasma-holespeed", "holeSpeed"], ["plasma-thc", "thc"], ["plasma-thc-out", "thcOut"]];
    for (const [id, key] of nums) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el && document.activeElement !== el) el.value = String(plasmaSettings[key]);
    }
    const uz = document.getElementById("plasma-usez") as HTMLInputElement | null;
    const pr = document.getElementById("plasma-probe") as HTMLInputElement | null;
    if (uz) uz.checked = plasmaSettings.useZ;
    if (pr) pr.checked = plasmaSettings.probe;
    syncEnabled();
    syncThc();
  };
  window.addEventListener(PLASMA_CHANGED, () => { syncFields(); refreshPlasmaPanel(true); });
  window.addEventListener(MODE_CHANGED, () => refreshPlasmaPanel(true));
  window.addEventListener("cnc-language-changed", () => refreshPlasmaPanel(true));
  refreshPlasmaPanel(true);
}

export function refreshPlasmaPanel(force = false) {
  const list = document.getElementById("plasma-cut-list");
  const st = state();
  if (!list || !st) return;
  if (getMachineMode() !== "plasma" && !force) return;
  const sig = st.selectedShapeIds.join(",") + "|" + st.shapes.length + "|"
    + st.shapes.map((s: any) => s.plasmaCutId || "").join(",") + "|" + (activeCut?.id || "");
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const shapes = selectedShapes();
  const selCuts = new Set(shapes.map(s => cutForShape(s)?.id));
  const counts = new Map<string, number>();
  for (const s of st.shapes) { const c = cutForShape(s); if (c) counts.set(c.id, (counts.get(c.id) || 0) + 1); }
  const cuts = getCuts();
  list.innerHTML = cuts.map((c, i) => `
    <div class="ll-row${selCuts.has(c.id) ? " sel" : ""}" data-cut-id="${c.id}" data-tip="${esc(t(shapes.length ? "plasma.rowTipAssign" : "plasma.rowTipDefault"))}">
      <span class="ll-swatch" style="background:${c.color}"></span>
      <span class="ll-text">
        <span class="ll-name">${esc(c.name)}${activeCut && activeCut.id === c.id ? ` <em class="ll-def">${esc(t("laser.default"))}</em>` : ""}</span>
        <span class="ll-info">${esc(cutInfo(c))}</span>
      </span>
      <span class="ll-count">${counts.get(c.id) || ""}</span>
      <span class="ll-btns">
        <button data-act="up" ${i === 0 ? "disabled" : ""} data-tip="${esc(t("laser.upTip"))}">▲</button>
        <button data-act="down" ${i === cuts.length - 1 ? "disabled" : ""} data-tip="${esc(t("laser.downTip"))}">▼</button>
        <button data-act="edit" data-tip="${esc(t("plasma.editTip"))}">✎</button>
      </span>
    </div>`).join("");
  const scope = document.getElementById("plasma-cut-scope");
  if (scope) scope.textContent = shapes.length ? t("plasma.scopeSelection", { n: shapes.length }) : t("plasma.scopeDefault");
}
