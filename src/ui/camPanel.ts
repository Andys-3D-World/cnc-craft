/**
 * ZEICHEN-OBERFLÄCHE (wie LightBurn):
 *   - renderCamPanel():      schmale Leiste links mit den Zeichenwerkzeugen
 *   - renderEditorToolbar(): Werkzeugleiste über der Zeichenfläche
 *                            (Datei, Bearbeiten, Drehen/Spiegeln, Ausrichten, Fang-Optionen)
 * Seltener gebrauchte, zusammengehörige Knöpfe stecken in aufklappenden Gruppen (ui/flyout.ts).
 *
 * Knöpfe mit data-tool="..." wählen ein Werkzeug (siehe toolsHandler.ts),
 * Knöpfe mit data-cmd="..." führen einen Befehl aus (siehe editor/commands.ts).
 */
import { icon } from "./icons";
import { tip, T } from "../i18n/i18n";
import { placeButtonHtml } from "./stockPanel";
import { MATERIALS } from "../materialView";
import { flyTools, flyCmds } from "./flyout";

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
    ${flyTools("shapes", [["line", "line", "tip.tool.line"], ["rect", "rect", "tip.tool.rect"], ["ellipse", "ellipse", "tip.tool.ellipse"],
      ["polygon", "polygon", "tip.tool.polygon"], ["arc", "arc", "tip.tool.arc"]])}
    ${tool("text", "text", "tip.tool.text")}
    ${flyTools("curves", [["pen", "pen", "tip.tool.pen"], ["node", "node", "tip.tool.node"]])}
    ${flyTools("measure", [["measure", "measure", "tip.tool.measure"], ["dim", "dim", "tip.tool.dim"]])}
    <div class="strip-sep"></div>
    ${flyCmds("extras", "boxgen", [["nest", "nest", "tip.cmd.nest"], ["boxgen", "boxgen", "tip.cmd.boxgen"], ["shapeLib", "shapeLib", "tip.cmd.shapeLib"], ["nameGen", "nameGen", "tip.cmd.nameGen"],
      ["materialTest", "materialTest", "tip.cmd.materialTest"],
      ["qrCode", "qrCode", "tip.cmd.qrCode"], ["serial", "serial", "tip.cmd.serial"], ["view3d", "view3d", "tip.cmd.view3d"], ["stlExport", "stlExport", "tip.cmd.stlExport"], ["nodeGraph", "nodeGraph", "tip.cmd.nodeGraph"]], "left", 20)}
    <div class="strip-sep strip-push"></div>
    ${action("generate-gcode", "gcode", "rp.genGcodeTip")}
    ${action("save-gcode", "gcodeSave", "rp.saveGcodeTip")}
    ${action("simulate", "simulate", "rp.simulateTip")}
    ${action("cost", "cost", "cost.tip")}
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
      ${cmd("duplicateDialog", "duplicate", "tip.cmd.duplicateDialog")}
      ${cmd("delete", "delete", "tip.cmd.delete")}
      ${cmd("selectAll", "selectAll", "tip.cmd.selectAll")}
    </div>
    <div class="tb-group">
      ${cmd("group", "group", "tip.cmd.group")}
      ${cmd("ungroup", "ungroup", "tip.cmd.ungroup")}
    </div>
    <div class="tb-group">
      ${flyCmds("combine", "boolUnion", [["boolUnion", "boolUnion", "tip.cmd.boolUnion"], ["boolSubtract", "boolSubtract", "tip.cmd.boolSubtract"],
        ["boolIntersect", "boolIntersect", "tip.cmd.boolIntersect"], ["splitByLine", "splitByLine", "tip.cmd.splitByLine"], ["weldScore", "weldScore", "tip.cmd.weldScore"]])}
      ${flyCmds("edit", "offset", [["offset", "offset", "tip.cmd.offset"], ["fillet", "fillet", "tip.cmd.fillet"], ["patternFill", "patternFill", "tip.cmd.patternFill"],
        ["centerFix", "centerFix", "tip.cmd.centerFix"], ["tiles", "tiles", "tip.cmd.tiles"], ["splitParts", "splitParts", "tip.cmd.splitParts"],
        ["thickness", "thickness", "tip.cmd.thickness"], ["dogbone", "dogbone", "tip.cmd.dogbone"]])}
      ${flyCmds("image", "imageMask", [["imageMask", "imageMask", "tip.cmd.imageMask"], ["imageSplit", "imageSplit", "tip.cmd.imageSplit"]])}
      ${flyCmds("transform", "rotateLeft", [["rotateLeft", "rotateLeft", "tip.cmd.rotateLeft"], ["rotateRight", "rotateRight", "tip.cmd.rotateRight"],
        ["mirrorH", "mirrorH", "tip.cmd.mirrorH"], ["mirrorV", "mirrorV", "tip.cmd.mirrorV"]])}
      ${flyCmds("align", "alignCenterH", [["alignLeft", "alignLeft", "tip.cmd.alignLeft"], ["alignCenterH", "alignCenterH", "tip.cmd.alignCenterH"],
        ["alignRight", "alignRight", "tip.cmd.alignRight"], ["alignTop", "alignTop", "tip.cmd.alignTop"], ["alignCenterV", "alignCenterV", "tip.cmd.alignCenterV"],
        ["alignBottom", "alignBottom", "tip.cmd.alignBottom"]])}
    </div>
    <div class="tb-group">
      ${cmd("zoomFit", "zoomFit", "tip.cmd.zoomFit")}
      ${placeButtonHtml()}
      <button id="btn-clear-canvas" class="btn-cmd btn-cmd-danger" ${tip("tip.clearAll")}>${icon("clear")}</button>
    </div>
    <div class="tb-group tb-options">
      <label class="tb-opt" ${tip("tip.material")}>🪵
        <select id="opt-material" class="tb-sel">
          <option value="off">${T("mat3d.off")}</option>
          ${MATERIALS.map(m => `<option value="${m.id}">${T("mat3d." + m.id)}</option>`).join("")}
        </select></label>
      <label class="tb-opt" ${tip("tip.showTools")}>
        <input type="checkbox" id="opt-show-tools">${icon("endmill", 16)}</label>
      <label class="tb-opt" ${tip("tip.snapObjects")}>
        <input type="checkbox" id="opt-snap-objects">${icon("magnet", 16)}</label>
      <label class="tb-opt" ${tip("tip.snapGrid")}>
        <input type="checkbox" id="opt-snap-grid">${icon("grid", 16)}
        <input type="number" id="opt-grid-step" min="0.1" step="0.5" class="tb-num"></label>
      <label class="tb-opt tb-opt-tool" data-for="rect" ${tip("tip.rectRadius")}>
        ${icon("rect", 16)}<span class="tb-lbl">R</span><input type="number" id="opt-rect-radius" min="0" step="0.5" class="tb-num"></label>
      <label class="tb-opt tb-opt-tool" data-for="polygon" ${tip("tip.polySides")}>
        ${icon("polygon", 16)}<input type="number" id="opt-poly-sides" min="3" max="100" step="1" class="tb-num"></label>
    </div>
  `;
  // Eckenradius / Anzahl Ecken nur zeigen, solange Rechteck bzw. Vieleck gewählt ist (spart Platz in der Leiste)
  const showToolOpts = (name: string) => container.querySelectorAll<HTMLElement>(".tb-opt-tool").forEach(el => {
    el.style.display = el.dataset.for === name ? "" : "none";
  });
  window.addEventListener("cnc-tool-changed", e => showToolOpts(String((e as CustomEvent).detail)));
  showToolOpts("select");
}
