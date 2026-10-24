/**
 * INLAY (Fräse, V-Stichel): aus der Auswahl Tasche + Stecker machen
 *
 *  - Original  → V-Carve-Tasche mit flachem Boden in Tiefe P
 *  - Kopie     → gespiegelt rechts daneben, „Stecker“: außen herum V-gecarvt, Start-Tiefe S = P − Leimspalt,
 *                Wände bis S + P. Umgedreht in die Tasche leimen, Rest des Stecker-Bretts abschneiden/abhobeln.
 * Rechnung der Bahnen: vcarve.ts, G-Code: cam.ts (Arten "vcarve" und "vplug").
 */
import { t } from "../i18n/i18n";
import { isClosedShape, cloneShape, groupBounds, newId, MM_TO_PIXEL } from "../shapeTransform";
import { mirrorX } from "../vcarve";

const KEY = "cnc_craft_inlay";

export function openInlayDialog(state: any, redraw: () => void, log: (s: string) => void) {
  const ids = new Set(state.selectedShapeIds);
  const sel = state.shapes.filter((s: any) => ids.has(s.id) && isClosedShape(s) && (s.type === "polyline" || s.type === "circle"));
  if (!sel.length) { log(t("inlay.selectFirst")); return; }
  let o = { depth: 3, gap: 0.5 };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* egal */ }

  document.getElementById("inlay-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "inlay-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:440px;">
      <h3>🧩 ${t("inlay.title")}</h3>
      <div class="dlg-hint">${t("inlay.desc")}</div>
      <label class="prop-row">${t("inlay.depth")}<input id="inlay-depth" type="number" min="0.5" step="0.5" class="prop-input" value="${Number(o.depth) || 3}"></label>
      <label class="prop-row">${t("inlay.gap")}<input id="inlay-gap" type="number" min="0" step="0.1" class="prop-input" value="${Number(o.gap) || 0}"></label>
      <div id="inlay-info" class="dlg-hint"></div>
      <div class="dlg-hint">${t("inlay.howto")}</div>
      <div class="dlg-buttons">
        <button id="inlay-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="inlay-ok" class="btn-primary">✔ ${t("inlay.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  const read = () => ({ depth: Math.max(0.5, parseFloat($("inlay-depth").value) || 3), gap: Math.max(0, parseFloat($("inlay-gap").value) || 0) });
  const info = () => {
    const v = read(), s = Math.max(0, v.depth - v.gap);
    ov.querySelector("#inlay-info")!.textContent = t("inlay.info", { p: v.depth.toFixed(1), s: s.toFixed(1), w: (s + v.depth).toFixed(1) });
  };
  ov.querySelectorAll("input").forEach(i => i.addEventListener("input", info));
  info();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") ov.querySelector<HTMLElement>("#inlay-ok")!.click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.querySelector<HTMLElement>("#inlay-cancel")!.onclick = close;
  ov.querySelector<HTMLElement>("#inlay-ok")!.onclick = () => {
    const v = read();
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* egal */ }
    close();
    const start = Math.max(0, v.depth - v.gap);
    const b = groupBounds(sel);
    if (!b) return;
    // Stecker rechts daneben, an der Mitte des Bereichs gespiegelt, mit 15 mm Abstand
    const mid = (b.minX + b.maxX) / 2, shift = (b.maxX - b.minX) + 15 * MM_TO_PIXEL;
    const plugs = sel.map((s: any) => {
      const c = cloneShape(s);
      c.id = newId();
      if (c.type === "circle") c.x = 2 * mid - c.x + shift;
      else c.points = mirrorX(c.points, mid).map((p: any) => ({ ...p, x: p.x + shift }));
      c.millingMode = "vplug"; c.vStart = start; c.millingDepth = -(start + v.depth);
      delete c.groupId; delete c.parentChainId; delete c.tabs;
      return c;
    });
    for (const s of sel) { s.millingMode = "vcarve"; s.millingDepth = -v.depth; delete s.vStart; }
    state.shapes = [...state.shapes, ...plugs];
    state.selectedShapeIds = plugs.map((p: any) => p.id);
    log(t("inlay.done", { n: sel.length, p: v.depth.toFixed(1), s: start.toFixed(1) }));
    redraw();
  };
}
