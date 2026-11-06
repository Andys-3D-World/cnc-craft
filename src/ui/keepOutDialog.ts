/**
 * SPERRZONE: Gewählte Rechtecke/Kreise werden zu Sperrzonen (nicht gefräst, im G-Code umfahren per Z) – oder wieder normal.
 * Bleiben Formen in der Zeichnung: Zeichnen, Verschieben, Speichern und Rückgängig laufen wie bei allen Formen.
 */
import { t } from "../i18n/i18n";
import { state } from "../main";
import { isKeepOut, keepValues, KEEP_HEIGHT, KEEP_MARGIN } from "../keepOut";
import { isClosedShape } from "../shapeTransform";

const KEY = "cnc_craft_keepout_defaults";

function defaults(): { height: number; margin: number } {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "null");
    if (d && Number.isFinite(d.height) && Number.isFinite(d.margin)) return { height: d.height, margin: d.margin };
  } catch { /* Standard */ }
  return { height: KEEP_HEIGHT, margin: KEEP_MARGIN };
}

export function openKeepOutDialog(log: (s: string) => void, onChange: () => void) {
  const ids = new Set(state.selectedShapeIds);
  const sel = state.shapes.filter((s: any) => ids.has(s.id));
  const usable = sel.filter(isClosedShape); // gezeichnete Rechtecke sind geschlossene Polylinien
  if (!usable.length) { log(t("ko.selectFirst")); return; }
  const v = isKeepOut(usable[0]) ? keepValues(usable[0]) : defaults();
  const anyOn = usable.some(isKeepOut);

  document.getElementById("keepout-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "keepout-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:440px;">
      <h3>${t("ko.title")}</h3>
      <div class="dlg-hint">${t("ko.hint")}</div>
      <label class="dlg-row"><span>${t("ko.height")}</span><span class="dlg-num"><input id="ko-height" type="number" step="1" min="-100" max="500"><em>mm</em></span></label>
      <label class="dlg-row"><span>${t("ko.margin")}</span><span class="dlg-num"><input id="ko-margin" type="number" step="1" min="0" max="100"><em>mm</em></span></label>
      <div class="dlg-hint" id="ko-safe"></div>
      <div class="dlg-buttons">
        <button type="button" class="btn-secondary" id="ko-cancel">${t("ko.cancel")}</button>
        ${anyOn ? `<button type="button" class="btn-secondary" id="ko-remove">${t("ko.remove")}</button>` : ""}
        <button type="button" class="btn-primary" id="ko-ok">${t("ko.apply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = <T extends HTMLElement>(id: string) => ov.querySelector<T>("#" + id)!;
  const h = q<HTMLInputElement>("ko-height"), m = q<HTMLInputElement>("ko-margin");
  h.value = String(v.height);
  m.value = String(v.margin);
  const showSafe = () => {
    const a = parseFloat(h.value), b = parseFloat(m.value);
    q("ko-safe").textContent = Number.isFinite(a) && Number.isFinite(b) ? t("ko.safe", { z: (a + b).toFixed(1) }) : "";
  };
  h.oninput = m.oninput = showSafe;
  showSafe();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  q("ko-cancel").onclick = close;
  q("ko-ok").onclick = () => {
    const height = parseFloat(h.value), margin = parseFloat(m.value);
    if (!Number.isFinite(height) || !Number.isFinite(margin) || margin < 0) { q("ko-safe").textContent = t("ko.bad"); return; }
    usable.forEach((s: any) => { s.keepOut = { height, margin }; });
    try { localStorage.setItem(KEY, JSON.stringify({ height, margin })); } catch { /* nur Komfort */ }
    log(t("ko.applied", { n: usable.length, z: (height + margin).toFixed(1) }));
    close();
    onChange();
  };
  const rm = ov.querySelector<HTMLElement>("#ko-remove");
  if (rm) rm.onclick = () => {
    usable.forEach((s: any) => { delete s.keepOut; });
    log(t("ko.removed", { n: usable.length }));
    close();
    onChange();
  };
  h.focus();
  h.select();
}
