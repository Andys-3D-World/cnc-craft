/**
 * BAHN-KORREKTUR: Außen / Innen / Mitte / Tasche für die Auswahl festlegen.
 *
 * "Außen" arbeitet wie "Teil" in Estlcam: Bei einem Teil mit Löchern wird die
 * äußere Kontur außen und jedes Loch automatisch innen gefräst.
 * "Innen" = Ausschnitt: alle geschlossenen Konturen werden innen gefräst.
 * Offene Linien werden immer auf der Linie (Mitte) gefräst.
 */
import { isClosedShape, shapeToPaths, pathArea, pointInPath } from "./shapeTransform";
import { t } from "./i18n/i18n";

export function bindOffsetModes(state: any, redraw: () => void, appendToConsole: (t: string) => void) {
  const labels = (m: string) => t(`mode.${m}`);

  ["part", "hole", "engrave", "pocket"].forEach(mode => {
    const btn = document.getElementById(`cam-mode-${mode}`);
    btn?.addEventListener("click", () => {
      const ids = new Set(state.selectedShapeIds);
      const sel = state.shapes.filter((s: any) => ids.has(s.id));
      if (sel.length === 0) {
        appendToConsole(t("mode.selectFirst"));
        return;
      }

      const closed = sel.filter(isClosedShape);
      const depth = nestingDepths(closed);

      sel.forEach((s: any) => {
        if (!isClosedShape(s)) { s.millingMode = "on-line"; return; }
        const d = depth.get(s.id) || 0;
        if (mode === "part") s.millingMode = d % 2 === 0 ? "outside" : "inside";
        if (mode === "hole") s.millingMode = "inside";
        if (mode === "engrave") s.millingMode = "on-line";
        if (mode === "pocket") s.millingMode = "pocket";
      });

      appendToConsole(t("mode.applied", { n: sel.length, mode: labels(mode) }));
      redraw();
    });
  });
}

/** Wie tief liegt jede Kontur in anderen? 0 = außen, 1 = Loch, 2 = Insel im Loch ... */
function nestingDepths(shapes: any[]): Map<string, number> {
  const paths = shapes.map(s => shapeToPaths(s)[0]?.pts || []);
  const areas = paths.map(p => Math.abs(pathArea(p)));
  const out = new Map<string, number>();
  shapes.forEach((s, i) => {
    const probe = paths[i][0];
    let d = 0;
    if (probe) {
      paths.forEach((q, j) => {
        if (j !== i && areas[j] > areas[i] && pointInPath(probe.x, probe.y, q)) d++;
      });
    }
    out.set(s.id, d);
  });
  return out;
}
