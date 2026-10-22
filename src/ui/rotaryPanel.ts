/**
 * DREHACHSE – Bedienung (Reiter „Lasern“) und 3D-Vorschau auf dem Zylinder
 *
 * Abschnitt „Drehachse (Rotary)“: an/aus, Anschluss (Y oder A), Art (Rollen/Futter), Durchmesser,
 * Rollen-Durchmesser, Y-Weg pro Umdrehung und „3D-Vorschau“.
 * Die 3D-Vorschau (ui/view3dDialog.ts) wickelt die Zeichnung im Aussehen der Materialansicht um einen
 * Zylinder mit dem eingestellten Durchmesser – frei drehbar mit der Maus.
 */
import { t, T, tip } from "../i18n/i18n";
import { rotary, setRotary, circumference, ROTARY_CHANGED } from "../rotary";
import { openView3D } from "./view3dDialog";

export function rotarySectionHtml(): string {
  return `
    <div class="menu-section-unified only-laser">
      <h3 class="menu-trigger">⟳ ${T("rot.title")}</h3>
      <div class="menu-body rp-box">
        <label class="prop-row" style="cursor:pointer;" ${tip("rot.onTip")}><span>${T("rot.on")}</span><input type="checkbox" id="rot-on" style="width:auto;"></label>
        <div id="rot-body">
          <label class="prop-row" ${tip("rot.axisTip")}>${T("rot.axis")}
            <select id="rot-axis" class="prop-input" style="width:auto;"><option value="y">${T("rot.axis.y")}</option><option value="a">${T("rot.axis.a")}</option></select></label>
          <label class="prop-row">${T("rot.kind")}
            <select id="rot-kind" class="prop-input" style="width:auto;"><option value="roller">${T("rot.kind.roller")}</option><option value="chuck">${T("rot.kind.chuck")}</option></select></label>
          <div class="prop-row" ${tip("rot.diaTip")}>${T("rot.dia")}<input type="number" id="rot-dia" min="1" step="0.5" class="prop-input"></div>
          <div class="prop-row" id="rot-roller-row" ${tip("rot.rollerTip")}>${T("rot.roller")}<input type="number" id="rot-roller" min="1" step="0.1" class="prop-input"></div>
          <div class="prop-row" id="rot-mpr-row" ${tip("rot.mprTip")}>${T("rot.mpr")}<input type="number" id="rot-mpr" min="0.1" step="0.1" class="prop-input"></div>
          <div class="tool-info" id="rot-info"></div>
          <button id="rot-preview" class="btn-secondary btn-compact">🧊 ${T("rot.preview")}</button>
          <div class="tool-scope">${T("rot.hint")}</div>
        </div>
      </div>
    </div>`;
}

export function initRotaryPanel(redraw: () => void) {
  const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E | null;
  const num = (id: string) => parseFloat($<HTMLInputElement>(id)?.value || "");
  const sync = () => {
    const on = $<HTMLInputElement>("rot-on"), body = $("rot-body");
    if (on) on.checked = rotary.on;
    if (body) body.style.display = rotary.on ? "" : "none";
    const set = (id: string, v: string) => { const e = $<HTMLInputElement>(id); if (e && document.activeElement !== e) e.value = v; };
    set("rot-axis", rotary.axis); set("rot-kind", rotary.kind);
    set("rot-dia", String(rotary.diameter)); set("rot-roller", String(rotary.rollerDia)); set("rot-mpr", String(rotary.mmPerRot));
    const rr = $("rot-roller-row"), mr = $("rot-mpr-row");
    if (rr) rr.style.display = rotary.kind === "roller" ? "" : "none";
    if (mr) mr.style.display = rotary.axis === "y" ? "" : "none";
    const info = $("rot-info");
    if (info) info.textContent = t("rot.info", { c: circumference().toFixed(1), d: rotary.diameter });
  };
  $("rot-on")?.addEventListener("change", e => setRotary({ on: (e.target as HTMLInputElement).checked }));
  $("rot-axis")?.addEventListener("change", e => setRotary({ axis: (e.target as HTMLSelectElement).value === "a" ? "a" : "y" }));
  $("rot-kind")?.addEventListener("change", e => setRotary({ kind: (e.target as HTMLSelectElement).value === "chuck" ? "chuck" : "roller" }));
  for (const [id, key] of [["rot-dia", "diameter"], ["rot-roller", "rollerDia"], ["rot-mpr", "mmPerRot"]] as const) {
    $(id)?.addEventListener("change", () => { const v = num(id); if (v > 0) setRotary({ [key]: v }); else sync(); });
  }
  $("rot-preview")?.addEventListener("click", () => openRotaryPreview());
  window.addEventListener(ROTARY_CHANGED, () => { sync(); redraw(); });
  window.addEventListener("cnc-language-changed", sync);
  sync();
}

/** 3D-Vorschau: die Zeichnung auf dem runden Teil, frei drehbar */
export function openRotaryPreview() { openView3D("cylinder"); }
