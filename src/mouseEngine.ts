/**
 * MAUS-ANBINDUNG DES ARBEITSBEREICHS
 * Zoom mit dem Mausrad (zur Mausposition hin), alles andere übernimmt editor/tools.ts.
 */
import { initTools, onMouseDown, onMouseMove, onMouseUp, onDoubleClick, updateCursor } from "./editor/tools";

export function initMouseEngine(canvas: HTMLCanvasElement, state: any, redraw: () => void) {
  initTools(canvas, redraw);

  const pos = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    // Falls das Canvas per CSS skaliert ist: auf Canvas-Pixel umrechnen
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  };

  canvas.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    const p = pos(e);
    const worldX = (p.x - state.offsetX) / state.scale;
    const worldY = (p.y - state.offsetY) / state.scale;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.scale = Math.min(200, Math.max(0.02, state.scale * factor));
    state.offsetX = p.x - worldX * state.scale;
    state.offsetY = p.y - worldY * state.scale;
    redraw();
  }, { passive: false });

  let pressed = false; // wurde die Maustaste IM Canvas gedrückt?

  canvas.addEventListener("mousedown", (e: MouseEvent) => {
    pressed = true;
    // Eingabefeld verlassen, damit Tastenkürzel wieder funktionieren
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
    const p = pos(e);
    onMouseDown(e, p.x, p.y);
  });

  // Bewegen und Loslassen auch außerhalb des Canvas verfolgen (z.B. beim Ziehen über den Rand)
  window.addEventListener("mousemove", (e: MouseEvent) => {
    const p = pos(e);
    const r = canvas.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside || pressed) onMouseMove(e, p.x, p.y);
  });
  window.addEventListener("mouseup", (e: MouseEvent) => {
    const p = pos(e);
    if (!pressed) return;
    pressed = false;
    onMouseUp(e, p.x, p.y);
  });

  canvas.addEventListener("dblclick", (e: MouseEvent) => {
    const p = pos(e);
    onDoubleClick(e, p.x, p.y);
    redraw();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mouseenter", () => updateCursor());
}
