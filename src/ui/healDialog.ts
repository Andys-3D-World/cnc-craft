/**
 * VEKTOREN SCHLIESSEN: offene Pfade der Auswahl (oder des ganzen Projekts) zu geschlossenen verbinden.
 * Geometrie: joinPaths.ts. Punkte bleiben, wo sie sind; nur die Lücke (höchstens die eingestellte Weite) wird überbrückt.
 * Ein Rückgängig-Schritt. Was offen bleibt, wird gemeldet und ausgewählt, damit man es sieht.
 */
import { t } from "../i18n/i18n";
import { state } from "../main";
import { joinChains } from "../joinPaths";
import { replaceWithJoined } from "../offsetModes";
import { isClosedShape, shapeToPaths, MM_TO_PIXEL } from "../shapeTransform";

const KEY = "cnc_craft_heal_tol";
const MIN_TOL = 0.001, MAX_TOL = 5;   // mehr wäre keine Lücke, sondern ein anderer Weg

function savedTol(): number {
  try {
    const v = parseFloat(localStorage.getItem(KEY) || "");
    if (v >= MIN_TOL && v <= MAX_TOL) return v;
  } catch { /* Standard */ }
  return 0.1;
}

/** Kommt in Frage: offen, genau ein Pfad; Bilder und Texte nicht */
function healable(s: any): boolean {
  if (isClosedShape(s) || s.type === "image" || s.type === "text") return false;
  return shapeToPaths(s).length === 1;
}

export function openHealDialog(log: (s: string) => void, onChange: () => void) {
  const ids = new Set(state.selectedShapeIds);
  const sel = state.shapes.filter((s: any) => ids.has(s.id));
  const scope = sel.length ? sel : state.shapes;
  const open = scope.filter(healable);

  document.getElementById("heal-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "heal-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:440px;">
      <h3>${t("heal.title")}</h3>
      <div class="dlg-hint" id="heal-scope"></div>
      <label class="dlg-row"><span>${t("heal.tol")}</span>
        <span class="dlg-num"><input id="heal-tol" type="number" min="${MIN_TOL}" max="${MAX_TOL}" step="0.01"><em>mm</em></span></label>
      <div class="dlg-hint">${t("heal.hint")}</div>
      <div class="dlg-hint" id="heal-result" style="white-space:pre-line;"></div>
      <div class="dlg-buttons">
        <button type="button" class="btn-secondary" id="heal-cancel">${t("heal.close")}</button>
        <button type="button" class="btn-primary" id="heal-ok">${t("heal.run")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = <T extends HTMLElement>(id: string) => ov.querySelector<T>("#" + id)!;
  q("heal-scope").textContent = t(sel.length ? "heal.scopeSel" : "heal.scopeAll", { n: open.length });
  const input = q<HTMLInputElement>("heal-tol");
  input.value = String(savedTol());
  const run = q<HTMLButtonElement>("heal-ok");
  run.disabled = !open.length;

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  q("heal-cancel").onclick = close;
  run.onclick = () => {
    const tol = parseFloat(input.value);
    const res = q("heal-result");
    if (!(tol >= MIN_TOL && tol <= MAX_TOL)) { res.textContent = t("heal.badTol", { min: MIN_TOL, max: MAX_TOL }); return; }
    try { localStorage.setItem(KEY, String(tol)); } catch { /* nur Komfort */ }
    const r = joinChains(open.map((s: any) => ({ ref: s, pts: shapeToPaths(s)[0]?.pts || [] })), tol * MM_TO_PIXEL, true);
    const made = r.closed.length ? replaceWithJoined(state, r.closed) : [];
    const from = r.closed.reduce((n, c) => n + c.from.length, 0);
    const leftShapes = r.left.flatMap(l => l.from);
    const lines = [t("heal.done", { k: made.length, n: from })];
    if (r.left.length) {
      const gaps = r.left.slice(0, 8).map(l => `${(l.gap / MM_TO_PIXEL).toFixed(2)} mm`).join(", ");
      lines.push(t("heal.left", { n: r.left.length, gaps: gaps + (r.left.length > 8 ? " …" : "") }));
    }
    lines.forEach(l => log(l));
    res.textContent = lines.join("\n");
    // Offene zeigen; ist nichts offen geblieben, die neuen
    const show = leftShapes.length ? leftShapes : made;
    state.selectedShapeIds = show.map((s: any) => s.id);
    run.disabled = true;
    onChange();
  };
  input.focus();
  input.select();
}
