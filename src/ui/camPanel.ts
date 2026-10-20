/**
 * ZEICHEN-OBERFLÄCHE (wie LightBurn):
 *   - renderCamPanel():      schmale Leiste links mit den Zeichenwerkzeugen
 *   - renderEditorToolbar(): Werkzeugleiste über der Zeichenfläche
 *                            (Datei, Bearbeiten, Drehen/Spiegeln, Ausrichten, Fang-Optionen)
 *
 * Knöpfe mit data-tool="..." wählen ein Werkzeug (siehe toolsHandler.ts),
 * Knöpfe mit data-cmd="..." führen einen Befehl aus (siehe editor/commands.ts).
 */
import { icon } from "./icons";
import { tip } from "../i18n/i18n";
import { placeButtonHtml } from "./stockPanel";

const tool = (id: string, ico: string, tipKey: string, active = false) =>
  `<button id="tool-${id}" data-tool="${id}" class="btn-tool-icon${active ? " active" : ""}" ${tip(tipKey)}>${icon(ico, 20)}</button>`;

/** Knopf in der linken Leiste, der den gleichnamigen Knopf "btn-…" im rechten Panel auslöst */
const action = (id: string, ico: string, tipKey: string) =>
  `<button data-click="btn-${id}" class="btn-tool-icon btn-strip-action" ${tip(tipKey)}>${icon(ico, 20)}</button>`;

const cmd = (id: string, ico: string, tipKey: string) =>
  `<button data-cmd="${id}" class="btn-cmd" ${tip(tipKey)}>${icon(ico)}</button>`;

/** Linke Werkzeugleiste */
export function renderCamPanel(container: HTMLElement) {
  container.innerHTML = `
    ${tool("select", "select", "tip.tool.select", true)}
    ${tool("pan", "pan", "tip.tool.pan")}
    <div class="strip-sep"></div>
    ${tool("line", "line", "tip.tool.line")}
    ${tool("rect", "rect", "tip.tool.rect")}
    ${tool("ellipse", "ellipse", "tip.tool.ellipse")}
    ${tool("polygon", "polygon", "tip.tool.polygon")}
    ${tool("arc", "arc", "tip.tool.arc")}
    ${tool("text", "text", "tip.tool.text")}
    <div class="strip-sep"></div>
    ${tool("measure", "measure", "tip.tool.measure")}
    <button data-cmd="nest" class="btn-tool-icon" ${tip("tip.cmd.nest")}>${icon("nest", 20)}</button>
    <div class="strip-sep strip-push"></div>
    ${action("generate-gcode", "gcode", "rp.genGcodeTip")}
    ${action("save-gcode", "gcodeSave", "rp.saveGcodeTip")}
    ${action("simulate", "simulate", "rp.simulateTip")}
  `;
  // Abkürzungen zu den Knöpfen im rechten Panel (G-Code-Bereich) – gleiche Funktion
  container.querySelectorAll<HTMLElement>("[data-click]").forEach(b =>
    b.addEventListener("click", () => document.getElementById(b.dataset.click!)?.click()));
}

/** Werkzeugleiste über der Zeichenfläche */
export function renderEditorToolbar(container: HTMLElement) {
  container.innerHTML = `
    <div class="tb-group">
      ${cmd("importFile", "import", "tip.cmd.importFile")}
      ${cmd("openProject", "open", "tip.cmd.openProject")}
      ${cmd("saveProject", "save", "tip.cmd.saveProject")}
    </div>
    <div class="tb-group">
      ${cmd("undo", "undo", "tip.cmd.undo")}
      ${cmd("redo", "redo", "tip.cmd.redo")}
    </div>
    <div class="tb-group">
      ${cmd("copy", "copy", "tip.cmd.copy")}
      ${cmd("paste", "paste", "tip.cmd.paste")}
      ${cmd("duplicate", "duplicate", "tip.cmd.duplicate")}
      ${cmd("delete", "delete", "tip.cmd.delete")}
      ${cmd("selectAll", "selectAll", "tip.cmd.selectAll")}
    </div>
    <div class="tb-group">
      ${cmd("group", "group", "tip.cmd.group")}
      ${cmd("ungroup", "ungroup", "tip.cmd.ungroup")}
      ${cmd("splitParts", "splitParts", "tip.cmd.splitParts")}
      ${cmd("offset", "offset", "tip.cmd.offset")}
    </div>
    <div class="tb-group">
      ${cmd("rotateLeft", "rotateLeft", "tip.cmd.rotateLeft")}
      ${cmd("rotateRight", "rotateRight", "tip.cmd.rotateRight")}
      ${cmd("mirrorH", "mirrorH", "tip.cmd.mirrorH")}
      ${cmd("mirrorV", "mirrorV", "tip.cmd.mirrorV")}
    </div>
    <div class="tb-group">
      ${cmd("alignLeft", "alignLeft", "tip.cmd.alignLeft")}
      ${cmd("alignCenterH", "alignCenterH", "tip.cmd.alignCenterH")}
      ${cmd("alignRight", "alignRight", "tip.cmd.alignRight")}
      ${cmd("alignTop", "alignTop", "tip.cmd.alignTop")}
      ${cmd("alignCenterV", "alignCenterV", "tip.cmd.alignCenterV")}
      ${cmd("alignBottom", "alignBottom", "tip.cmd.alignBottom")}
    </div>
    <div class="tb-group">
      ${cmd("zoomFit", "zoomFit", "tip.cmd.zoomFit")}
      ${placeButtonHtml()}
      <button id="btn-clear-canvas" class="btn-cmd btn-cmd-danger" ${tip("tip.clearAll")}>${icon("clear")}</button>
    </div>
    <div class="tb-group tb-options">
      <label class="tb-opt" ${tip("tip.showTools")}>
        <input type="checkbox" id="opt-show-tools">${icon("endmill", 16)}</label>
      <label class="tb-opt" ${tip("tip.snapObjects")}>
        <input type="checkbox" id="opt-snap-objects">${icon("magnet", 16)}</label>
      <label class="tb-opt" ${tip("tip.snapGrid")}>
        <input type="checkbox" id="opt-snap-grid">${icon("grid", 16)}
        <input type="number" id="opt-grid-step" min="0.1" step="0.5" class="tb-num"></label>
      <label class="tb-opt" ${tip("tip.rectRadius")}>
        ${icon("rect", 16)}<span class="tb-lbl">R</span><input type="number" id="opt-rect-radius" min="0" step="0.5" class="tb-num"></label>
      <label class="tb-opt" ${tip("tip.polySides")}>
        ${icon("polygon", 16)}<input type="number" id="opt-poly-sides" min="3" max="100" step="1" class="tb-num"></label>
    </div>
  `;
}
