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
import { tip, T, t } from "../i18n/i18n";
import { placeButtonHtml } from "./stockPanel";
import { materialOptionsHtml } from "../materialView";
import { flyTools, flyCmds, flyGroups } from "./flyout";

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
      ["polygon", "polygon", "tip.tool.polygon"], ["star", "star", "tip.tool.star"], ["slot", "slot", "tip.tool.slot"], ["ring", "ring", "tip.tool.ring"],
      ["arc", "arc", "tip.tool.arc"], ["arcCenter", "arcCenter", "tip.tool.arcCenter"]])}
    ${tool("text", "text", "tip.tool.text")}
    ${flyTools("curves", [["pen", "pen", "tip.tool.pen"], ["node", "node", "tip.tool.node"], ["trim", "trim", "tip.tool.trim"]])}
    ${flyTools("measure", [["measure", "measure", "tip.tool.measure"], ["dim", "dim", "tip.tool.dim"], ["lineDim", "lineDim", "tip.tool.lineDim"]])}
    <div class="strip-sep"></div>
    ${flyGroups("generators", "boxgen", [
      ["boxes", [["boxgen", "boxgen", "tip.cmd.boxgen"], ["shapeBox", "shapeBox", "tip.cmd.shapeBox"], ["foldBox", "foldBox", "tip.cmd.foldBox"], ["birdhouse", "birdhouse", "tip.cmd.birdhouse"],
        ["candyHolder", "candyHolder", "tip.cmd.candyHolder"], ["shelf", "shelf", "tip.cmd.shelf"], ["divider", "divider", "tip.cmd.divider"]]],
      ["deco", [["nameGen", "nameGen", "tip.cmd.nameGen"], ["ornament", "ornament", "tip.cmd.ornament"], ["family", "family", "tip.cmd.family"], ["letterTopper", "letterTopper", "tip.cmd.letterTopper"],
        ["wordTiles", "wordTiles", "tip.cmd.wordTiles"], ["birth", "birth", "tip.cmd.birth"], ["shadowBox", "shadowBox", "tip.cmd.shadowBox"], ["slotOrnament", "slotOrnament", "tip.cmd.slotOrnament"],
        ["mandala", "mandala", "tip.cmd.mandala"], ["puzzle", "puzzle", "tip.cmd.puzzle"]]],
      ["tech", [["gear", "gear", "tip.cmd.gear"], ["hinge", "hinge", "tip.cmd.hinge"], ["joint", "joint", "tip.cmd.joint"], ["scale", "scale", "tip.cmd.scale"], ["vent", "vent", "tip.cmd.vent"], ["qrCode", "qrCode", "tip.cmd.qrCode"]]]
    ], 20)}
    ${flyGroups("extras", "extras", [
      ["prep", [["nest", "nest", "tip.cmd.nest"], ["surface", "surface", "tip.cmd.surface"], ["shapeLib", "shapeLib", "tip.cmd.shapeLib"], ["serial", "serial", "tip.cmd.serial"], ["nodeGraph", "nodeGraph", "tip.cmd.nodeGraph"], ["printCut", "printCut", "tip.cmd.printCut"]]],
      ["check", [["materialTest", "materialTest", "tip.cmd.materialTest"], ["testCard", "testCard", "tip.cmd.testCard"], ["view3d", "view3d", "tip.cmd.view3d"], ["stlExport", "stlExport", "tip.cmd.stlExport"]]]
    ], 20)}
    <div class="strip-sep strip-push"></div>
    ${action("to-machine", "gcode", "rp.toMachineTip")}
    ${action("save-gcode", "gcodeSave", "rp.saveGcodeTip")}
    ${action("simulate", "simulate", "rp.simulateTip")}
    ${action("cost", "cost", "cost.tip")}
  `;
  // Abkürzungen zu den Knöpfen rechts – gleiche Funktion
  container.querySelectorAll<HTMLElement>("[data-click]").forEach(b =>
    b.addEventListener("click", () => document.getElementById(b.dataset.click!)?.click()));
}

/** Werkzeugleiste über der Zeichenfläche */
export function renderEditorToolbar(container: HTMLElement) {
  container.innerHTML = `
    <div class="tb-group">
      ${flyCmds("file", "open", [["importFile", "import", "tip.cmd.importFile"], ["openProject", "open", "tip.cmd.openProject"],
        ["saveProject", "save", "tip.cmd.saveProject"], ["exportVector", "export", "tip.cmd.exportVector"]], "down", 18, {
        label: T("fly.fileLabel"),
        extra: `<div class="fly-sep"></div><button id="btn-clear-canvas" class="btn-cmd fly-item fly-danger" ${tip("tip.clearAll")}><span class="fly-chip">${icon("clear", 18)}</span><span class="fly-lbl"></span><kbd class="fly-kbd"></kbd></button>`
      })}
      <button id="btn-cmd-search" class="btn-cmd" ${tip("tip.cmdSearch")}>${icon("search")}</button>
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
      ${flyCmds("selectSim", "selectSim", [["selectOpen", "selectOpen", "tip.cmd.selectOpen"], ["selectSameLayer", "layers", "tip.cmd.selectSameLayer"], ["selectSameSize", "selectSameSize", "tip.cmd.selectSameSize"]])}
    </div>
    <div class="tb-group">
      ${cmd("group", "group", "tip.cmd.group")}
      ${cmd("ungroup", "ungroup", "tip.cmd.ungroup")}
    </div>
    <div class="tb-group">
      ${flyCmds("combine", "boolUnion", [["boolUnion", "boolUnion", "tip.cmd.boolUnion"], ["boolSubtract", "boolSubtract", "tip.cmd.boolSubtract"],
        ["boolIntersect", "boolIntersect", "tip.cmd.boolIntersect"], ["splitByLine", "splitByLine", "tip.cmd.splitByLine"], ["weldScore", "weldScore", "tip.cmd.weldScore"]])}
      ${flyGroups("edit", "offset", [
        ["outline", [["offset", "offset", "tip.cmd.offset"], ["fillet", "fillet", "tip.cmd.fillet"], ["heal", "heal", "tip.cmd.heal"], ["thickness", "thickness", "tip.cmd.thickness"], ["dogbone", "dogbone", "tip.cmd.dogbone"], ["centerFix", "centerFix", "tip.cmd.centerFix"]]],
        ["parts", [["array", "array", "tip.cmd.array"], ["patternFill", "patternFill", "tip.cmd.patternFill"], ["tiles", "tiles", "tip.cmd.tiles"], ["splitParts", "splitParts", "tip.cmd.splitParts"], ["relief", "relief", "tip.cmd.relief"], ["keepOut", "keepOut", "tip.cmd.keepOut"]]],
        ["paths", [["textOnPath", "textOnPath", "tip.cmd.textOnPath"], ["simplify", "simplify", "tip.cmd.simplify"], ["dedupe", "dedupe", "tip.cmd.dedupe"], ["cutStart", "cutStart", "tip.cmd.cutStart"], ["reverseDir", "reverseDir", "tip.cmd.reverseDir"]]]
      ], 18, "down")}
      ${flyCmds("image", "imageMask", [["imageMask", "imageMask", "tip.cmd.imageMask"], ["imageSplit", "imageSplit", "tip.cmd.imageSplit"], ["toImage", "toImage", "tip.cmd.toImage"]])}
      ${flyCmds("transform", "rotateLeft", [["rotateLeft", "rotateLeft", "tip.cmd.rotateLeft"], ["rotateRight", "rotateRight", "tip.cmd.rotateRight"],
        ["mirrorH", "mirrorH", "tip.cmd.mirrorH"], ["mirrorV", "mirrorV", "tip.cmd.mirrorV"], ["shear", "shear", "tip.cmd.shear"]])}
      ${flyCmds("align", "alignCenterH", [["alignLeft", "alignLeft", "tip.cmd.alignLeft"], ["alignCenterH", "alignCenterH", "tip.cmd.alignCenterH"],
        ["alignRight", "alignRight", "tip.cmd.alignRight"], ["alignTop", "alignTop", "tip.cmd.alignTop"], ["alignCenterV", "alignCenterV", "tip.cmd.alignCenterV"],
        ["alignBottom", "alignBottom", "tip.cmd.alignBottom"], ["distributeH", "distributeH", "tip.cmd.distributeH"], ["distributeV", "distributeV", "tip.cmd.distributeV"]])}
    </div>
    <div class="tb-group">
      ${cmd("zoomFit", "zoomFit", "tip.cmd.zoomFit")}
      ${placeButtonHtml()}
    </div>
    <div class="tb-group tb-options">
      <label class="tb-opt" ${tip("tip.material")}>🪵
        <select id="opt-material" class="tb-sel">
          <option value="off">${T("mat3d.off")}</option>
          ${materialOptionsHtml(t)}
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
      <label class="tb-opt tb-opt-tool" data-for="star" ${tip("tip.starTips")}>
        ${icon("star", 16)}<input type="number" id="opt-star-tips" min="3" max="100" step="1" class="tb-num"></label>
      <label class="tb-opt tb-opt-tool" data-for="star" ${tip("tip.starInner")}>
        <span class="tb-lbl">%</span><input type="number" id="opt-star-inner" min="5" max="95" step="5" class="tb-num"></label>
      <label class="tb-opt tb-opt-tool" data-for="ring" ${tip("tip.ringWall")}>
        ${icon("ring", 16)}<input type="number" id="opt-ring-wall" min="0.01" step="0.5" class="tb-num"></label>
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
