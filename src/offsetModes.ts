/**
 * BAHN-KORREKTUR: Außen / Innen / Mitte / Tasche für die Auswahl festlegen.
 *
 * "Außen" arbeitet wie "Teil" in Estlcam: Bei einem Teil mit Löchern wird die
 * äußere Kontur außen und jedes Loch automatisch innen gefräst.
 * "Innen" = Ausschnitt: alle geschlossenen Konturen werden innen gefräst.
 * Einzelne Linien und Bögen, deren Enden sich treffen, werden bei Außen/Innen/Tasche vorher zu einer
 * geschlossenen Kontur verbunden. Ein einzelner Bogen kann außen/innen gefräst werden (weg vom bzw. hin zum
 * Mittelpunkt). Was sonst noch offen ist, wird auf der Linie (Mitte) gefräst.
 */
import { isClosedShape, shapeToPaths, pathArea, pointInPath, createPolyline, cloneShape, MM_TO_PIXEL, Pt } from "./shapeTransform";
import { t } from "./i18n/i18n";

/** Enden gelten als verbunden, wenn sie höchstens so weit auseinander liegen (0,05 mm) */
const JOIN_TOL = 0.05 * MM_TO_PIXEL;

/**
 * Verbindet offene Formen (Linien, Bögen, offene Polylinien), deren Enden sich treffen.
 * Nur Ketten, die sich schließen, werden ersetzt – alles andere bleibt unverändert.
 */
function joinOpenShapes(open: any[]): { closed: { pts: Pt[]; from: any[] }[]; left: any[] } {
  const items = open.map(s => ({ s, pts: shapeToPaths(s)[0]?.pts || [] })).filter(i => i.pts.length >= 2);
  const used = items.map(() => false);
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const closed: { pts: Pt[]; from: any[] }[] = [];
  const left: any[] = [];
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = items[i].pts.map(p => ({ x: p.x, y: p.y }));
    const from = [items[i].s];
    let grew = true;
    while (grew && d(chain[0], chain[chain.length - 1]) > JOIN_TOL) {
      grew = false;
      for (let j = 0; j < items.length && !grew; j++) {
        if (used[j]) continue;
        const q = items[j].pts, a = q[0], b = q[q.length - 1];
        const end = chain[chain.length - 1], start = chain[0];
        let add: Pt[] | null = null, front = false;
        if (d(end, a) <= JOIN_TOL) add = q.slice(1);
        else if (d(end, b) <= JOIN_TOL) add = q.slice(0, -1).reverse();
        else if (d(start, b) <= JOIN_TOL) { add = q.slice(0, -1); front = true; }
        else if (d(start, a) <= JOIN_TOL) { add = q.slice(1).reverse(); front = true; }
        if (!add) continue;
        const copy = add.map(p => ({ x: p.x, y: p.y }));
        chain = front ? copy.concat(chain) : chain.concat(copy);
        used[j] = true; from.push(items[j].s); grew = true;
      }
    }
    if (chain.length > 2 && d(chain[0], chain[chain.length - 1]) <= JOIN_TOL) {
      chain.pop();
      closed.push({ pts: chain, from });
    } else left.push(...from);
  }
  return { closed, left };
}

export function bindOffsetModes(state: any, redraw: () => void, appendToConsole: (t: string) => void) {
  const labels = (m: string) => t(`mode.${m}`);

  ["part", "hole", "engrave", "pocket"].forEach(mode => {
    const btn = document.getElementById(`cam-mode-${mode}`);
    btn?.addEventListener("click", () => {
      const ids = new Set(state.selectedShapeIds);
      let sel = state.shapes.filter((s: any) => ids.has(s.id));
      if (sel.length === 0) {
        appendToConsole(t("mode.selectFirst"));
        return;
      }

      // Außen/Innen/Tasche brauchen geschlossene Konturen: zusammenhängende Linien/Bögen verbinden
      const open = sel.filter((s: any) => !isClosedShape(s));
      if (mode !== "engrave" && open.length) {
        const { closed: joined, left } = joinOpenShapes(open);
        if (joined.length) {
          const gone = new Set(joined.flatMap(c => c.from.map((s: any) => s.id)));
          const made = joined.map(c => {
            // Werkzeug, Tiefe, Ebene, Gruppe … von der ersten Form übernehmen
            const extra = cloneShape(c.from[0]);
            ["id", "type", "points", "closed", "x", "y", "w", "h", "midX", "midY", "rotation"].forEach(k => delete extra[k]);
            return createPolyline(c.pts, true, "outside", extra);
          });
          const at = state.shapes.findIndex((s: any) => gone.has(s.id));
          const rest = state.shapes.filter((s: any) => !gone.has(s.id));
          rest.splice(Math.max(0, Math.min(at, rest.length)), 0, ...made);
          state.shapes = rest;
          sel = sel.filter((s: any) => !gone.has(s.id)).concat(made);
          state.selectedShapeIds = sel.map((s: any) => s.id);
          appendToConsole(t("mode.joined", { n: gone.size, k: made.length }));
        }
        // Bögen können auch allein außen/innen gefräst werden (Fräser weg vom bzw. hin zum Mittelpunkt)
        const onLine = left.filter((s: any) => mode === "pocket" || s.type !== "arc").length;
        if (onLine) appendToConsole(t("mode.openLeft", { n: onLine }));
      }

      const closed = sel.filter(isClosedShape);
      const depth = nestingDepths(closed);

      sel.forEach((s: any) => {
        if (!isClosedShape(s)) {
          s.millingMode = s.type === "arc" && mode === "part" ? "outside" : s.type === "arc" && mode === "hole" ? "inside" : "on-line";
          return;
        }
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
