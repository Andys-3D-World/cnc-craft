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
    }

    updateDimensionInputs(null);
    redraw();
  };

  [dimX, dimY, dimW, dimH, dimAngle, dimDepth].forEach(input => {
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
}
