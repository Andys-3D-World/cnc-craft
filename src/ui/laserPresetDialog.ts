/**
 * FENSTER „MATERIAL-VORLAGEN“ (Laser-Bibliothek → 📋 Vorlagen)
 *
 * Laserart + Watt einstellen, dann pro Material/Dicke/Arbeit mit ＋ eine Ebene mit Startwerten anlegen.
 * Gravur-Ebenen kommen vor die Schneide-Ebenen (Reihenfolge in der Liste = Laser-Reihenfolge).
 * Oben „Meine Vorlagen“: getestete Ebenen merken und wieder einsetzen (ownPresets.ts).
 * Werte und Umrechnung: laserPresets.ts
 */
import { t } from "../i18n/i18n";
import { addLayer, getLayers, moveLayer } from "../laserLayers";
import { PRESETS, LaserKind, LaserPreset, presetValues, REF_WATT } from "../laserPresets";
import { mountOwnPresets } from "./ownPresetSection";

const KEY = "cnc_craft_laser_presets";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const f2 = (v: number) => String(Math.round(v * 100) / 100);

function load(): { kind: LaserKind; watt: number } {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const kind: LaserKind = s.kind === "co2" ? "co2" : "diode";
    const watt = Number(s.watt) > 0 ? Number(s.watt) : REF_WATT[kind];
    return { kind, watt };
  } catch { return { kind: "diode", watt: REF_WATT.diode }; }
}

/** Name der neuen Ebene, z. B. „Pappel-Sperrholz 3 mm schneiden“ */
function presetName(p: LaserPreset): string {
  const mat = t("llib.mat." + p.mat);
  return p.thick > 0 ? t("llib.pre.nameThick", { m: mat, d: f2(p.thick), op: t("llib.pre." + p.op) }) : t("llib.pre.name", { m: mat, op: t("llib.pre." + p.op) });
}

export function openLaserPresetDialog(onAdded: (id: string) => void) {
  const init = load();
  document.getElementById("lpre-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "lpre-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:640px;">
      <h3>📋 ${esc(t("llib.pre.title"))}</h3>
      <div class="dlg-hint">${esc(t("llib.pre.desc"))}</div>
      <div class="own-box" id="lpre-own"></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:6px 0;">
        <label class="dlg-row" style="flex:1;min-width:200px;"><span>${esc(t("llib.pre.kind"))}</span>
          <select id="lpre-kind" class="prop-input" style="width:auto;">
            <option value="diode"${init.kind === "diode" ? " selected" : ""}>${esc(t("llib.pre.kind.diode"))}</option>
            <option value="co2"${init.kind === "co2" ? " selected" : ""}>${esc(t("llib.pre.kind.co2"))}</option>
          </select></label>
        <label class="dlg-row" style="flex:1;min-width:200px;" data-tip="${esc(t("llib.pre.wattTip"))}"><span>${esc(t("llib.pre.watt"))}</span>
          <span class="dlg-num"><input id="lpre-watt" type="number" min="1" step="1" value="${init.watt}"><em>W</em></span></label>
      </div>
      <div id="lpre-list" style="max-height:340px;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;"></div>
      <div class="dlg-hint">⚠️ ${esc(t("llib.pre.hint"))}</div>
      <div class="dlg-buttons">
        <button id="lpre-close" class="btn-primary">${esc(t("llib.pre.close"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const kindSel = ov.querySelector("#lpre-kind") as HTMLSelectElement;
  const wattIn = ov.querySelector("#lpre-watt") as HTMLInputElement;
  const list = ov.querySelector("#lpre-list") as HTMLElement;
  const added = new Set<string>();

  const read = () => {
    const kind: LaserKind = kindSel.value === "co2" ? "co2" : "diode";
    const w = parseFloat(wattIn.value);
    return { kind, watt: Number.isFinite(w) && w > 0 ? w : REF_WATT[kind] };
  };

  const render = () => {
    const { kind, watt } = read();
    list.innerHTML = PRESETS.map(p => {
      const v = presetValues(p, kind, watt);
      const vals = v
        ? `${v.power} % · ${v.speed} mm/min${v.passes > 1 ? ` · ${v.passes}×` : ""}`
        : esc(t("llib.pre.unsuited"));
      const warn = v?.weak ? ` <span style="color:var(--color-warning);">${esc(t("llib.pre.weak"))}</span>` : "";
      const note = p.note ? `<div class="tool-scope">${esc(t(p.note))}</div>` : "";
      const done = added.has(p.id + kind + watt);
      return `
        <div class="lpre-row" style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.05);">
          <span style="width:22px;text-align:center;">${p.op === "cut" ? "✂️" : "▦"}</span>
          <div style="flex:1;min-width:0;">
            <div><b>${esc(presetName(p))}</b></div>
            <div class="tool-scope">${vals}${warn}</div>${note}
          </div>
          <button type="button" class="btn-secondary btn-compact" data-id="${p.id}" ${!v || done ? "disabled" : ""}>${done ? "✔ " + esc(t("llib.pre.added")) : "＋ " + esc(t("llib.pre.add"))}</button>
        </div>`;
    }).join("");
  };

  list.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest("button[data-id]") as HTMLButtonElement | null;
    if (!b || b.disabled) return;
    const p = PRESETS.find(x => x.id === b.dataset.id);
    if (!p) return;
    const { kind, watt } = read();
    const v = presetValues(p, kind, watt);
    if (!v) return;
    try { localStorage.setItem(KEY, JSON.stringify({ kind, watt })); } catch { /* egal */ }
    const engrave = p.op === "engrave";
    const l = addLayer({
      name: presetName(p), mode: engrave ? "fill" : "line",
      power: v.power, speed: v.speed, fillPower: v.power, fillSpeed: v.speed, passes: v.passes,
      interval: kind === "diode" ? 0.08 : 0.1, angle: 0, air: !engrave, leadIn: 0,
      material: t("llib.mat." + p.mat), thickness: p.thick,
      notes: t("llib.pre.layerNote", { kind: t("llib.pre.kind." + kind), w: f2(watt) })
    });
    // Gravieren vor Schneiden: nach oben über alle Linien-Ebenen
    if (engrave) {
      for (let guard = 0; guard < 500; guard++) {
        const ls = getLayers(), i = ls.findIndex(x => x.id === l.id);
        if (i <= 0 || ls[i - 1].mode !== "line") break;
        moveLayer(l.id, -1);
      }
    }
    added.add(p.id + kind + watt);
    onAdded(l.id);
    render();
  });
  kindSel.addEventListener("change", () => {
    // beim Wechsel der Laserart die übliche Leistung vorschlagen
    wattIn.value = String(REF_WATT[kindSel.value === "co2" ? "co2" : "diode"]);
    render();
  });
  wattIn.addEventListener("input", render);
  mountOwnPresets(ov.querySelector("#lpre-own") as HTMLElement, "laser",
    () => getLayers().map(l => ({ id: l.id, name: l.name, values: l })),
    d => t("own.laserInfo", { p: Number(d.power) || 0, v: Number(d.speed) || 0, n: Number(d.passes) || 1 }),
    (label, data) => { const l = addLayer({ ...data, name: label }); onAdded(l.id); });
  const close = () => ov.remove();
  ov.querySelector("#lpre-close")!.addEventListener("click", close);
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
}
