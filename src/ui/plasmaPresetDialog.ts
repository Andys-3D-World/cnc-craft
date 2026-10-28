/**
 * FENSTER „MATERIAL-VORLAGEN“ FÜR PLASMA (Plasma-Bibliothek → 📋 Material-Vorlagen)
 *
 * Geräteklasse (40 A / 60 A) wählen, dann je Material und Blechdicke mit ＋ einen Schnitt mit Startwerten anlegen.
 * Oben „Meine Vorlagen“: getestete Schnitte merken und wieder einsetzen. Werte: plasmaPresets.ts
 */
import { t } from "../i18n/i18n";
import { addCut, getCuts } from "../plasmaCuts";
import { PLASMA_PRESETS, PLASMA_AMPS, PlasmaPreset } from "../plasmaPresets";
import { mountOwnPresets } from "./ownPresetSection";

const KEY = "cnc_craft_plasma_presets";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const f2 = (v: number) => String(Math.round(v * 100) / 100);

function presetName(p: PlasmaPreset): string {
  return t("ppre.name", { m: t("plib.mat." + p.mat), d: f2(p.thick), a: p.amps });
}
/** Kurzinfo für Vorlagen (eingebaut und eigene) */
function info(d: Record<string, unknown>): string {
  const n = (k: string) => f2(Number(d[k]) || 0);
  return t("ppre.info", { v: n("speed"), k: n("kerf"), h: n("pierceHeight"), s: n("pierceDelay"), c: n("cutHeight") });
}

export function openPlasmaPresetDialog(onAdded: (id: string) => void) {
  let amps = 40;
  try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); if (PLASMA_AMPS.includes(s.amps)) amps = s.amps; } catch { /* egal */ }
  document.getElementById("ppre-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "ppre-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:640px;">
      <h3>📋 ${esc(t("ppre.title"))}</h3>
      <div class="dlg-hint">${esc(t("ppre.desc"))}</div>
      <div class="own-box" id="ppre-own"></div>
      <label class="dlg-row" style="margin:6px 0;" data-tip="${esc(t("ppre.ampsTip"))}"><span>${esc(t("ppre.amps"))}</span>
        <select id="ppre-amps" class="prop-input" style="width:auto;">${PLASMA_AMPS.map(a => `<option value="${a}"${a === amps ? " selected" : ""}>${t("ppre.ampsOpt", { a })}</option>`).join("")}</select></label>
      <div id="ppre-list" style="max-height:300px;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;"></div>
      <div class="dlg-hint">⚠️ ${esc(t("ppre.hint"))}</div>
      <div class="dlg-buttons"><button id="ppre-close" class="btn-primary">${esc(t("llib.pre.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const list = ov.querySelector("#ppre-list") as HTMLElement;
  const ampsSel = ov.querySelector("#ppre-amps") as HTMLSelectElement;
  const added = new Set<string>();

  const render = () => {
    list.innerHTML = PLASMA_PRESETS.filter(p => p.amps === amps).map(p => `
      <div class="lpre-row" style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="flex:1;min-width:0;"><b>${esc(presetName(p))}</b><div class="tool-scope">${esc(info(p as unknown as Record<string, unknown>))}</div></div>
        <button type="button" class="btn-secondary btn-compact" data-id="${p.id}" ${added.has(p.id) ? "disabled" : ""}>${added.has(p.id) ? "✔ " + esc(t("llib.pre.added")) : "＋ " + esc(t("llib.pre.add"))}</button>
      </div>`).join("");
  };
  list.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button[data-id]") as HTMLButtonElement | null;
    const p = b && !b.disabled ? PLASMA_PRESETS.find(x => x.id === b.dataset.id) : null;
    if (!p) return;
    const c = addCut({
      name: presetName(p), speed: p.speed, kerf: p.kerf, pierceHeight: p.pierceHeight, pierceDelay: p.pierceDelay,
      cutHeight: p.cutHeight, leadIn: p.leadIn, material: t("plib.mat." + p.mat), thickness: p.thick, amps: p.amps,
      notes: t("ppre.cutNote")
    });
    added.add(p.id);
    onAdded(c.id);
    render();
  });
  ampsSel.addEventListener("change", () => {
    amps = Number(ampsSel.value) || 40;
    try { localStorage.setItem(KEY, JSON.stringify({ amps })); } catch { /* egal */ }
    render();
  });
  mountOwnPresets(ov.querySelector("#ppre-own") as HTMLElement, "plasma",
    () => getCuts().map(c => ({ id: c.id, name: c.name, values: c })), info,
    (label, data) => { const c = addCut({ ...data, name: label }); onAdded(c.id); });
  const close = () => ov.remove();
  ov.querySelector("#ppre-close")!.addEventListener("click", close);
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
}
