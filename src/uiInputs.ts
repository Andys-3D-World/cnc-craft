/**
 * EIGENSCHAFTEN-FELDER (rechte Seite): Position, Größe, Drehung, Frästiefe der Auswahl.
 *
 * - X-Mitte / Y-Mitte: Mittelpunkt der Auswahl in mm
 * - Breite / Höhe:     Größe der Auswahl in mm (mit Schloss = Seitenverhältnis bleibt)
 * - Drehen um (°):     dreht die Auswahl um ihren Mittelpunkt (positiv = gegen den Uhrzeigersinn)
 *
 * Werte werden übernommen, sobald du Enter drückst oder das Feld verlässt.
 */
import { MM_TO_PIXEL, groupBounds, translateShape, scaleShape, rotateShape } from "./shapeTransform";
import { autoFractions } from "./tabs";

function getState(): any {
  return (window as any).cncState;
}

function selected(state: any): any[] {
  const ids = new Set(state.selectedShapeIds);
  return state.shapes.filter((s: any) => ids.has(s.id));
}

export function setupUiInputs(redraw: () => void) {
  const dimX = document.getElementById("dim-x") as HTMLInputElement;
  const dimY = document.getElementById("dim-y") as HTMLInputElement;
  const dimW = document.getElementById("dim-w") as HTMLInputElement;
  const dimH = document.getElementById("dim-h") as HTMLInputElement;
  const dimAngle = document.getElementById("dim-angle") as HTMLInputElement;
  const dimDepth = document.getElementById("dim-depth") as HTMLInputElement;
  const lockRatio = document.getElementById("dim-lock-ratio") as HTMLInputElement | null;
  const tabN = document.getElementById("dim-tab-n") as HTMLInputElement | null;
  const tabW = document.getElementById("dim-tab-w") as HTMLInputElement | null;
  const tabH = document.getElementById("dim-tab-h") as HTMLInputElement | null;
  const tabMode = document.getElementById("dim-tab-mode") as HTMLSelectElement | null;
  const tabInputs = [tabN, tabW, tabH].filter(Boolean) as HTMLInputElement[];
  // Automatisch / selbst gesetzt: beim Wechsel auf „selbst“ werden die automatischen Stellen übernommen
  tabMode?.addEventListener("change", () => {
    const state = getState();
    if (!state) return;
    for (const s of selected(state)) {
      if (tabMode.value === "manual" && s.tabMode !== "manual") s.tabPts = autoFractions(Math.round(Number(s.tabN) || 0));
      s.tabMode = tabMode.value;
      if (!(Number(s.tabLen) > 0)) s.tabLen = parseFloat(tabW?.value || "") || 5;
      if (!(Number(s.tabH) > 0)) s.tabH = parseFloat(tabH?.value || "") || 1.5;
    }
    redraw();
  });

  const apply = (input: HTMLInputElement) => {
    const state = getState();
    if (!state || state.selectedShapeIds.length === 0) return;
    const value = parseFloat(input.value);
    if (!Number.isFinite(value)) { updateDimensionInputs(null); return; }

    const shapes = selected(state);
    const b = groupBounds(shapes);
    if (!b) return;
    const curW = b.maxX - b.minX, curH = b.maxY - b.minY;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;

    if (input === dimX) {
      const dx = value * MM_TO_PIXEL - cx;
      shapes.forEach(s => translateShape(s, dx, 0));
    } else if (input === dimY) {
      const dy = value * MM_TO_PIXEL - cy;
      shapes.forEach(s => translateShape(s, 0, dy));
    } else if (input === dimW || input === dimH) {
      if (value <= 0) { updateDimensionInputs(null); return; }
      const locked = lockRatio ? lockRatio.checked : true;
      let sx = 1, sy = 1;
      if (input === dimW) {
        if (curW <= 1e-9) return;
        sx = (value * MM_TO_PIXEL) / curW;
        sy = locked ? sx : 1;
      } else {
        if (curH <= 1e-9) return;
        sy = (value * MM_TO_PIXEL) / curH;
        sx = locked ? sy : 1;
      }
      // Skalieren von der linken unteren Ecke aus -> das Teil bleibt auf dem Bett
      shapes.forEach(s => scaleShape(s, b.minX, b.minY, sx, sy));
    } else if (input === dimAngle) {
      if (value !== 0) shapes.forEach(s => rotateShape(s, cx, cy, (value * Math.PI) / 180));
      input.value = "0";
    } else if (input === dimDepth) {
      shapes.forEach(s => { s.millingDepth = value; });
    } else if (tabInputs.includes(input)) {
      // Haltestege: alle drei Werte zusammen an die Auswahl (Anzahl 0 = keine Stege)
      const num = (el: HTMLInputElement | null, d: number) => { const v = parseFloat(el?.value || ""); return Number.isFinite(v) && v >= 0 ? v : d; };
      const n = Math.round(num(tabN, 0)), len = num(tabW, 5), h = num(tabH, 1.5);
      shapes.forEach(s => {
        s.tabLen = len; s.tabH = h;
        // eine neue Anzahl heißt: wieder automatisch verteilen
        if (input === tabN) { s.tabN = n; s.tabMode = "auto"; } else if (s.tabMode !== "manual") s.tabN = n;
      });
    }

    updateDimensionInputs(null);
    redraw();
  };

  [dimX, dimY, dimW, dimH, dimAngle, dimDepth, ...tabInputs].forEach(input => {
    if (!input) return;
    input.addEventListener("change", () => apply(input));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") { apply(input); input.blur(); }
    });
  });
}

/**
 * Trägt die echten Millimeter-Maße der aktuellen Auswahl in die Felder ein.
 * (Der Parameter ist nur noch aus Kompatibilitätsgründen da.)
 */
export function updateDimensionInputs(_shape: any) {
  const dimX = document.getElementById("dim-x") as HTMLInputElement;
  const dimY = document.getElementById("dim-y") as HTMLInputElement;
  const dimW = document.getElementById("dim-w") as HTMLInputElement;
  const dimH = document.getElementById("dim-h") as HTMLInputElement;
  const dimDepth = document.getElementById("dim-depth") as HTMLInputElement;
  const state = getState();
  if (!state || !dimX || !dimY || !dimW || !dimH) return;

  const shapes = selected(state);
  const b = groupBounds(shapes);
  if (!b) {
    [dimX, dimY, dimW, dimH].forEach(i => { i.value = ""; });
    return;
  }

  dimX.value = (((b.minX + b.maxX) / 2) / MM_TO_PIXEL).toFixed(2);
  dimY.value = (((b.minY + b.maxY) / 2) / MM_TO_PIXEL).toFixed(2);
  dimW.value = ((b.maxX - b.minX) / MM_TO_PIXEL).toFixed(2);
  dimH.value = ((b.maxY - b.minY) / MM_TO_PIXEL).toFixed(2);
  if (dimDepth && shapes[0] && typeof shapes[0].millingDepth === "number") {
    dimDepth.value = String(shapes[0].millingDepth);
  }
  // Haltestege der ersten Form zeigen (ohne eigene Werte: keine Stege, Länge/Höhe bleiben stehen)
  const s0 = shapes[0];
  const set = (id: string, v: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el && typeof v === "number") el.value = String(v); };
  if (s0) {
    set("dim-tab-n", s0.tabMode === "manual" ? (s0.tabPts || []).length : s0.tabN ?? 0);
    set("dim-tab-w", s0.tabLen); set("dim-tab-h", s0.tabH);
    const m = document.getElementById("dim-tab-mode") as HTMLSelectElement | null;
    if (m) m.value = s0.tabMode === "manual" ? "manual" : "auto";
  }
}
