/**
 * MATERIAL-AUSWAHL IN DEN FRÄS-PARAMETERN (Reiter „Objekt“)
 *
 * Ein Klick wendet ein eigenes Profil oder ein Material aus der Datenbank auf die ausgewählten Formen an: Sie bekommen
 * eine Kopie der Werte (shape.cutData), das Werkzeug selbst bleibt unverändert. „Werte vom Werkzeug“ nimmt sie wieder weg.
 * Ablauf und Regeln: millProfiles.ts. Eingebaute Materialien werden je Form für ihr Werkzeug gerechnet (calcCutData).
 */
import { t, tip } from "../i18n/i18n";
import { MATERIALS, materialName, calcCutData, toolForShape, toolSettings, TOOLS_CHANGED, getTool, activeTool } from "../toolLibrary";
import { getMillProfiles, makeCutData, cleanCutData, cutDataFits, profileFitsDiameter, MILL_PROFILES_CHANGED } from "../millProfiles";
import { extraOps } from "../ops";
import { openMaterialDb } from "./materialDbDialog";

const MIXED = "__mixed__";
const OTHER = "__other__";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function selectedShapes(): any[] {
  const st = (window as any).cncState;
  if (!st) return [];
  const ids = new Set(st.selectedShapeIds);
  return st.shapes.filter((s: any) => ids.has(s.id));
}

export function millProfilePickerHtml(): string {
  return `
    <div class="needs-sel" ${tip("mprof.tip")}>
      <div class="tool-pick-row">
        <select id="mprof-select" class="prop-input" aria-label="${esc(t("mprof.label"))}"></select>
        <button id="mprof-manage" class="btn-secondary btn-icon" ${tip("mprof.manageTip")}>📚</button>
      </div>
      <div id="mprof-status" class="tool-scope"></div>
    </div>`;
}

let lastSig = "";

function applyChoice(value: string, redraw: () => void) {
  const shapes = selectedShapes();
  if (!shapes.length || value === MIXED || value === OTHER) return;
  if (!value) {
    shapes.forEach(s => { delete s.cutData; });
    redraw();
    return;
  }
  const isProfile = value.startsWith("p:");
  const profile = isProfile ? getMillProfiles().find(p => p.id === value.slice(2)) : null;
  const matId = value.startsWith("m:") ? value.slice(2) : "";
  if (isProfile && !profile) return;
  if (!isProfile && !MATERIALS.some(m => m.id === matId)) return;

  // Profil für einen anderen Fräser? Lieber einmal fragen – die Werte könnten den Fräser zerstören
  if (profile) {
    const other = [...new Set(shapes.map(s => toolForShape(s)?.diameter).filter((d): d is number => !!d && !profileFitsDiameter(profile, d)))];
    if (other.length && !window.confirm(t("mprof.diaConfirm", { name: profile.name, pd: profile.diameter ?? 0, d: other.join(", ") }))) {
      refreshMillProfilePicker(true);
      return;
    }
  }
  shapes.forEach(s => {
    const tool = toolForShape(s);
    if (!tool) return;
    const cd = profile
      ? makeCutData(tool, profile, profile.name, value, toolSettings)
      : makeCutData(tool, calcCutData(tool, matId, toolSettings), materialName(matId), value, toolSettings);
    const { limited, ...data } = cd;
    if (limited) limitedFor = selectionKey(shapes);
    s.cutData = data;
  });
  redraw();
}

/** Bei welcher Auswahl wurden Werte an den Grenzen gekürzt? Der Hinweis bleibt, bis die Auswahl wechselt */
let limitedFor = "";
const selectionKey = (shapes: any[]) => shapes.map(s => s.id).join(",");

/** Text unter der Liste: was gerade gilt */
function statusText(shapes: any[]): string {
  const parts: string[] = [];
  const data = shapes.map(s => ({ s, cd: cleanCutData(s.cutData), tool: toolForShape(s) }));
  const off = data.filter(x => x.cd && !cutDataFits(x.cd, x.tool));
  const on = data.filter(x => x.cd && cutDataFits(x.cd, x.tool));
  if (off.length) parts.push(t("mprof.off", { n: off.length }));
  if (on.length) {
    const sigs = new Set(on.map(x => `${x.cd!.feedrate}|${x.cd!.rpm}|${x.cd!.stepZ}|${x.cd!.plungeFeed}`));
    if (sigs.size === 1) {
      const c = on[0].cd!;
      parts.push(t("mprof.values", { f: c.feedrate, s: c.rpm, z: c.stepZ, p: c.plungeFeed ?? 0 }));
    } else parts.push(t("mprof.valuesMixed"));
    if (on.length < shapes.length - off.length) parts.push(t("mprof.partly", { n: on.length, all: shapes.length }));
    parts.push(t("mprof.toolKept"));
  }
  if (shapes.length && limitedFor === selectionKey(shapes)) parts.push(t("mprof.limited"));
  // Weitere Bearbeitungen mit anderem Werkzeug behalten ihre eigenen Werte
  const otherOps = on.reduce((n, x) => n + extraOps(x.s).filter(o => (getTool(o.toolId) || activeTool)?.id !== x.cd!.toolId).length, 0);
  if (otherOps) parts.push(t("mprof.opsOwn", { n: otherOps }));
  return parts.join(" ");
}

/** Auswahlliste und Text anpassen – aus der Zeichenschleife, macht nur bei Änderungen etwas */
export function refreshMillProfilePicker(force = false) {
  const sel = document.getElementById("mprof-select") as HTMLSelectElement | null;
  if (!sel) return;
  const shapes = selectedShapes();
  const sig = shapes.map(s => `${s.id}/${s.toolId || ""}/${JSON.stringify(s.cutData || "")}/${(s.ops || []).length}`).join(",") + "|" + (activeTool?.id || "");
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const profiles = getMillProfiles();
  const srcs = new Set(shapes.map(s => cleanCutData(s.cutData)?.src || ""));
  const only = srcs.size === 1 ? [...srcs][0] : MIXED;
  const known = !only || only === MIXED
    || (only.startsWith("p:") && profiles.some(p => "p:" + p.id === only))
    || (only.startsWith("m:") && MATERIALS.some(m => "m:" + m.id === only));
  const label = cleanCutData(shapes.find(s => s.cutData)?.cutData)?.label || "?";
  const opts: string[] = [];
  if (only === MIXED) opts.push(`<option value="${MIXED}" disabled>${esc(t("tool.mixed"))}</option>`);
  if (!known) opts.push(`<option value="${OTHER}" disabled>${esc(label)}</option>`);
  opts.push(`<option value="">${esc(t("mprof.useTool"))}</option>`);
  if (profiles.length) {
    opts.push(`<optgroup label="${esc(t("mprof.own"))}">`
      + profiles.map(p => `<option value="p:${esc(p.id)}">${esc(p.name)}${p.diameter ? ` · Ø${p.diameter}` : ""}</option>`).join("")
      + "</optgroup>");
  }
  opts.push(`<optgroup label="${esc(t("mprof.builtin"))}">`
    + MATERIALS.map(m => `<option value="m:${esc(m.id)}">${esc(materialName(m.id))}</option>`).join("") + "</optgroup>");
  sel.innerHTML = opts.join("");
  sel.value = known ? only : OTHER;

  const status = document.getElementById("mprof-status");
  if (status) status.textContent = statusText(shapes);
}

/** Einmal beim Start (nachdem das rechte Panel gezeichnet ist) */
export function initMillProfilePicker(redraw: () => void) {
  const sel = document.getElementById("mprof-select") as HTMLSelectElement | null;
  if (!sel) return;
  sel.addEventListener("change", () => {
    limitedFor = "";
    applyChoice(sel.value, redraw);
    sel.blur();
    refreshMillProfilePicker(true);
  });
  document.getElementById("mprof-manage")?.addEventListener("click", () => openMaterialDb());
  const again = () => refreshMillProfilePicker(true);
  window.addEventListener(MILL_PROFILES_CHANGED, again);
  window.addEventListener(TOOLS_CHANGED, again);
  window.addEventListener("cnc-language-changed", again);
  again();
}
