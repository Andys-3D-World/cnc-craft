/**
 * Verbindet die Werkzeug-Knöpfe (data-tool) und die Werkzeug-Optionen im linken Panel.
 */
import { setTool } from "./editor/tools";
import { options, loadOptions, saveOptions, ToolName } from "./editor/editorState";

export function setupToolsHandler(_state: any) {
  document.querySelectorAll<HTMLElement>(".btn-tool-icon[data-tool]").forEach(btn => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool as ToolName));
  });

  loadOptions();
  const bindCheck = (id: string, key: "snapObjects" | "snapGrid" | "showTools") => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.checked = options[key];
    el.addEventListener("change", () => {
      options[key] = el.checked;
      saveOptions();
      window.dispatchEvent(new Event("cnc-redraw"));
    });
  };
  const bindNum = (id: string, key: "gridStep" | "rectRadius" | "polygonSides", min: number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.value = String(options[key]);
    el.addEventListener("change", () => {
      const v = parseFloat(el.value);
      options[key] = Number.isFinite(v) ? Math.max(min, key === "polygonSides" ? Math.round(v) : v) : options[key];
      el.value = String(options[key]);
      saveOptions();
    });
  };
  bindCheck("opt-snap-objects", "snapObjects");
  bindCheck("opt-snap-grid", "snapGrid");
  bindCheck("opt-show-tools", "showTools");
  bindNum("opt-grid-step", "gridStep", 0.01);
  bindNum("opt-rect-radius", "rectRadius", 0);
  bindNum("opt-poly-sides", "polygonSides", 3);
}
