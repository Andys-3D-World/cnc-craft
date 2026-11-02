/**
 * DREHACHSE – Bedienung (Reiter „Fräsen“/„Lasern“, nicht Plasma) und 3D-Vorschau auf dem Zylinder
 *
 * Abschnitt „Drehachse (Rotary)“: an/aus, Lage (entlang X oder Y), Drehrichtung, Anschluss (Y/X oder A), Art (Rollen/Futter), Durchmesser,
 * Rollen-Durchmesser, Y-Weg pro Umdrehung und „3D-Vorschau“. Rollen gibt es nur beim Laser (Fräse: Futter).
 * Die 3D-Vorschau (ui/view3dDialog.ts) wickelt die Zeichnung im Aussehen der Materialansicht um einen
 * Zylinder mit dem eingestellten Durchmesser – frei drehbar mit der Maus.
 */
import { t, T, tip } from "../i18n/i18n";
import { rotary, setRotary, circumference, rotaryCheck, ROTARY_CHANGED } from "../rotary";
import { MACHINE_EVENT } from "../machine";
import { openView3D } from "./view3dDialog";

export function rotarySectionHtml(): string {
  return `
    <div class="menu-section-unified not-plasma">
      <h3 class="menu-trigger">⟳ ${T("rot.title")}</h3>
      <div class="menu-body rp-box">
        <label class="prop-row" style="cursor:pointer;" ${tip("rot.onTip")}><span>${T("rot.on")}</span><input type="checkbox" id="rot-on" style="width:auto;"></label>
        <div id="rot-body">
          <label class="prop-row" ${tip("rot.alongTip")}>${T("rot.along")}
            <select id="rot-along" class="prop-input" style="width:auto;"><option value="x">${T("rot.along.x")}</option><option value="y">${T("rot.along.y")}</option></select></label>
          <label class="prop-row" ${tip("rot.axisTip")}>${T("rot.axis")}
            <select id="rot-axis" class="prop-input" style="width:auto;"><option value="y" id="rot-axis-port">${T("rot.axis.y")}</option><option value="a">${T("rot.axis.a")}</option></select></label>
          <label class="prop-row only-laser">${T("rot.kind")}
            <select id="rot-kind" class="prop-input" style="width:auto;"><option value="roller">${T("rot.kind.roller")}</option><option value="chuck">${T("rot.kind.chuck")}</option></select></label>
          <div class="prop-row" ${tip("rot.diaTip")}>${T("rot.dia")}<input type="number" id="rot-dia" min="1" step="0.5" class="prop-input"></div>
          <div class="prop-row only-laser" id="rot-roller-row" ${tip("rot.rollerTip")}>${T("rot.roller")}<input type="number" id="rot-roller" min="1" step="0.1" class="prop-input"></div>
          <div class="prop-row" id="rot-mpr-row" ${tip("rot.mprTip")}><span id="rot-mpr-label">${T("rot.mpr")}</span><input type="number" id="rot-mpr" min="0.1" step="0.1" class="prop-input"></div>
          <label class="prop-row" style="cursor:pointer;" ${tip("rot.reverseTip")}><span>${T("rot.reverse")}</span><input type="checkbox" id="rot-reverse" style="width:auto;"></label>
          <div class="tool-info" id="rot-info"></div>
          <div class="rot-check" id="rot-check"></div>
          <button id="rot-preview" class="btn-secondary btn-compact">🧊 ${T("rot.preview")}</button>
          <div class="tool-scope only-laser" id="rot-hint">${T("rot.hint")}</div>
          <div class="tool-scope only-mill" id="rot-millhint">${T("rot.millHint")}</div>
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
    set("rot-axis", rotary.axis); set("rot-kind", rotary.kind); set("rot-along", rotary.along);
    const rev = $<HTMLInputElement>("rot-reverse");
    if (rev) rev.checked = rotary.reverse;
    // Achse entlang Y: die Drehachse steckt am X-Anschluss (statt Y)
    const port = rotary.along === "y" ? "x" : "y";
    const po = $("rot-axis-port"), ml = $("rot-mpr-label");
    if (po) po.textContent = t("rot.axis." + port);
    if (ml) ml.textContent = t(port === "x" ? "rot.mprX" : "rot.mpr");
    const h1 = $("rot-hint"), h2 = $("rot-millhint");
    if (h1) h1.textContent = t(rotary.along === "y" ? "rot.hint.y" : "rot.hint");
    if (h2) h2.textContent = t(rotary.along === "y" ? "rot.millHint.y" : "rot.millHint");
    set("rot-dia", String(rotary.diameter)); set("rot-roller", String(rotary.rollerDia)); set("rot-mpr", String(rotary.mmPerRot));
    const rr = $("rot-roller-row"), mr = $("rot-mpr-row");
    if (rr) rr.style.display = rotary.kind === "roller" ? "" : "none";
    if (mr) mr.style.display = rotary.axis === "y" ? "" : "none";
    const info = $("rot-info");
    if (info) info.textContent = t("rot.info", { c: circumference().toFixed(1), d: rotary.diameter });
    // passt das zur verbundenen Steuerung? (ohne Verbindung: Hinweis, wofür die A-Achse geht)
    const ck = $("rot-check");
    if (ck) {
      const c = rotaryCheck();
      const text = c.block || c.warn || (rotary.axis === "a" ? t("rot.aNote") : "");
      ck.textContent = text ? (c.block ? "⛔ " : "⚠ ") + text : "";
      ck.className = "rot-check" + (c.block ? " block" : c.warn ? " warn" : "");
      ck.style.display = text ? "" : "none";
    }
  };
  $("rot-on")?.addEventListener("change", e => setRotary({ on: (e.target as HTMLInputElement).checked }));
  $("rot-axis")?.addEventListener("change", e => setRotary({ axis: (e.target as HTMLSelectElement).value === "a" ? "a" : "y" }));
  $("rot-along")?.addEventListener("change", e => setRotary({ along: (e.target as HTMLSelectElement).value === "y" ? "y" : "x" }));
  $("rot-reverse")?.addEventListener("change", e => setRotary({ reverse: (e.target as HTMLInputElement).checked }));
  $("rot-kind")?.addEventListener("change", e => setRotary({ kind: (e.target as HTMLSelectElement).value === "chuck" ? "chuck" : "roller" }));
  for (const [id, key] of [["rot-dia", "diameter"], ["rot-roller", "rollerDia"], ["rot-mpr", "mmPerRot"]] as const) {
    $(id)?.addEventListener("change", () => { const v = num(id); if (v > 0) setRotary({ [key]: v }); else sync(); });
  }
  $("rot-preview")?.addEventListener("click", () => openRotaryPreview());
  window.addEventListener(ROTARY_CHANGED, () => { sync(); redraw(); });
  window.addEventListener("cnc-language-changed", sync);
  // Verbinden / Trennen / Einstellungen gelesen: Hinweis neu prüfen
  window.addEventListener(MACHINE_EVENT, e => { if (["connected", "disconnected", "welcome", "setting", "switched"].includes((e as CustomEvent).detail?.type)) sync(); });
  sync();
}

/** 3D-Vorschau: die Zeichnung auf dem runden Teil, frei drehbar */
export function openRotaryPreview() { openView3D("cylinder"); }
