/**
 * BEARBEITEN-BEFEHLE + TASTENKÜRZEL (wie in LightBurn)
 *
 *  Strg+Z / Strg+Y      Rückgängig / Wiederholen (auch Strg+Shift+Z)
 *  Strg+C / X / V       Kopieren / Ausschneiden / Einfügen
 *  Strg+D               Duplizieren
 *  Strg+A               Alles auswählen
 *  Strg+G / Strg+U      Gruppieren / Gruppe auflösen
 *  Strg+Shift+U         In Teile aufteilen (Kontur + Löcher = ein Teil)
 *  Entf / Rücktaste     Löschen
 *  Pfeiltasten          1 mm verschieben (Shift = 10 mm, Alt = 0,1 mm)
 *  V H L R E P A T M    Werkzeuge
 *  Strg+I               Datei importieren (SVG, DXF, PDF, STL, Bild ...)
 *  Strg+O / Strg+S      Projekt öffnen / speichern (Strg+Shift+S = speichern unter)
 *  F                    Alles zeigen (Zoom auf Bett)
 *  Leertaste halten     Ansicht verschieben
 */
import { openShapeLibrary } from "./shapeLibrary";
import { openView3D } from "../ui/view3dDialog";
import { openStlExport } from "../ui/stlExportDialog";
import { openNodeEditor } from "../nodes/nodeEditor";
import { app, bedSizeMm, ToolName } from "./editorState";
import { undo, redo, checkpoint } from "./history";
import { combine, splitByLines, roundCorners, patternFill, weldAndScore, tileShapes, BoolOp, OpResult, PatternOptions, Tile } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { centerOn } from "./dims";
import { toImageUV, splitImage } from "../raster/imageShape";
import { selectedShapes, selectionBounds } from "./selection";
import { setTool, onToolKey, live, updateCursor } from "./tools";
import {
  MM_TO_PIXEL, Bounds, groupBounds, translateShape, scaleShape, rotateShape, cloneShape, newId,
  shapeToPaths, isClosedShape, createPolyline, pathArea, pointInPath
} from "../shapeTransform";
import { offsetPolygon } from "../polyOffset";
import { openBoxDialog } from "./boxGen";
import { openMaterialTestDialog } from "./materialTest";
import { openQrDialog } from "./qrTool";
import { openSerialDialog } from "./serial";
import { openThicknessDialog } from "./thickness";
import { openDogboneDialog } from "./dogbone";
import { openNameGenerator } from "./nameGen";
import { nestShapes, NestOptions, NestAnchor, NestDir, NEST_ANCHORS, nestDirAllowed } from "./nest";
import { activeBed, addBed, allBedsBounds, bedCount, bedName, bedShapes, moveToBed, switchBed } from "./beds";
import { assignPartGroups } from "./parts";
import { updateDimensionInputs } from "../uiInputs";
import { importWithDialog, openProjectWithDialog, saveProject } from "../importers/importManager";
import { t } from "../i18n/i18n";

let redrawFn: () => void = () => {};
let log: (t: string) => void = () => {};
let canvasEl: HTMLCanvasElement;
let clipboard: any[] = [];
let pasteCount = 0;

const TOOL_KEYS: Record<string, ToolName> = {
  v: "select", h: "pan", l: "line", r: "rect", e: "ellipse", p: "polygon", a: "arc", t: "text", m: "measure",
  n: "node", b: "pen", d: "dim"
};

function done() {
  updateDimensionInputs(null);
  redrawFn();
}

// =====================================================================
// BEFEHLE
// =====================================================================

export const commands: Record<string, () => void> = {
  undo: () => { if (undo()) done(); else log(t("edit.nothingToUndo")); },
  redo: () => { if (redo()) done(); },

  copy: () => {
    const sel = selectedShapes();
    if (!sel.length) return;
    clipboard = sel.map(cloneShape);
    pasteCount = 0;
    log(t("edit.copied", { n: sel.length }));
  },
  cut: () => { commands.copy(); commands.delete(); },
  paste: () => {
    if (!clipboard.length) return;
    pasteCount++;
    insertCopies(clipboard, 5 * MM_TO_PIXEL * pasteCount);
  },
  duplicate: () => {
    const sel = selectedShapes();
    if (!sel.length) return;
    insertCopies(sel, 5 * MM_TO_PIXEL);
  },
  delete: () => {
    const st = app();
    const n = st.selectedShapeIds.length;
    if (!n) return;
    const ids = new Set(st.selectedShapeIds);
    st.shapes = st.shapes.filter((s: any) => !ids.has(s.id));
    st.selectedShapeIds = [];
    log(t("edit.deleted", { n }));
    done();
  },
  selectAll: () => {
    const st = app();
    st.selectedShapeIds = st.shapes.map((s: any) => s.id);
    done();
  },

  group: () => {
    const sel = selectedShapes();
    if (sel.length < 2) { log(t("edit.groupNeedTwo")); return; }
    const gid = "grp-" + newId();
    sel.forEach(s => { s.groupId = gid; });
    log(t("edit.grouped", { n: sel.length }));
    done();
  },
  ungroup: () => {
    const sel = selectedShapes();
    let n = 0;
    sel.forEach(s => { if (s.groupId) { delete s.groupId; n++; } });
    if (n) log(t("edit.ungrouped", { n }));
    done();
  },

  splitParts: () => {
    const st = app();
    const sel = selectedShapes();
    const list = sel.length ? sel : st.shapes;
    if (!list.length) return;
    const n = assignPartGroups(list);
    log(t("edit.splitParts", { n }));
    st.selectedShapeIds = [];
    done();
  },

  mirrorH: () => transformSelection((s, c) => scaleShape(s, c.x, c.y, -1, 1)),
  mirrorV: () => transformSelection((s, c) => scaleShape(s, c.x, c.y, 1, -1)),
  rotateLeft: () => transformSelection((s, c) => rotateShape(s, c.x, c.y, Math.PI / 2)),
  rotateRight: () => transformSelection((s, c) => rotateShape(s, c.x, c.y, -Math.PI / 2)),

  alignLeft: () => align("left"),
  alignCenterH: () => align("centerH"),
  alignRight: () => align("right"),
  alignTop: () => align("top"),
  alignCenterV: () => align("centerV"),
  alignBottom: () => align("bottom"),

  offset: () => openOffsetDialog(),
  boolUnion: () => runCombine("union"),
  boolSubtract: () => runCombine("subtract"),
  boolIntersect: () => runCombine("intersect"),
  splitByLine: () => applyOp(splitByLines(selectedShapes()), "ops.splitDone"),
  fillet: () => openFilletDialog(),
  imageMask: () => imageMask(),
  imageSplit: () => { imageSplit(); },
  patternFill: () => openPatternDialog(),
  weldScore: () => weldScore(),
  centerFix: () => centerFix(),
  nest: () => openNestDialog(),
  boxgen: () => openBoxDialog(log, () => { done(); checkpoint(); }),
  shapeLib: () => openShapeLibrary(log),
  nameGen: () => openNameGenerator(log, () => { done(); checkpoint(); }),
  materialTest: () => openMaterialTestDialog(log, () => { done(); checkpoint(); }),
  qrCode: () => openQrDialog(log, () => { done(); checkpoint(); }),
  serial: () => openSerialDialog(log, () => { done(); checkpoint(); }),
  thickness: () => openThicknessDialog(log, () => { done(); checkpoint(); }),
  dogbone: () => openDogboneDialog(log, () => { done(); checkpoint(); }),
  view3d: () => openView3D(),
  stlExport: () => openStlExport(log),
  nodeGraph: () => openNodeEditor(log),
  tiles: () => openTileDialog(),
  duplicateDialog: () => openDuplicateDialog(),
  importFile: () => { importWithDialog(); },
  openProject: () => { openProjectWithDialog(); },
  saveProject: () => { saveProject(false); },
  saveProjectAs: () => { saveProject(true); },
  zoomFit: () => zoomFit(),

  toolSelect: () => setTool("select"),
  toolPan: () => setTool("pan"),
  toolLine: () => setTool("line"),
  toolRect: () => setTool("rect"),
  toolEllipse: () => setTool("ellipse"),
  toolPolygon: () => setTool("polygon"),
  toolArc: () => setTool("arc"),
  toolText: () => setTool("text"),
  toolMeasure: () => setTool("measure")
};

/** Kopien mit neuen IDs und eigenen Gruppen, um offsetPx nach rechts unten versetzt */
function makeCopies(source: any[], offsetPx: number): any[] {
  const groupMap = new Map<string, string>();
  return source.map(s => {
    const c = cloneShape(s);
    c.id = newId();
    delete c.ngOut; // Kopie gehört nicht mehr zum Ergebnis des Knotengraphen
    if (c.groupId) {
      if (!groupMap.has(c.groupId)) groupMap.set(c.groupId, "grp-" + newId());
      c.groupId = groupMap.get(c.groupId);
    }
    translateShape(c, offsetPx, -offsetPx);
    return c;
  });
}

function insertCopies(source: any[], offsetPx: number) {
  const st = app();
  const copies = makeCopies(source, offsetPx);
  st.shapes = [...st.shapes, ...copies];
  st.selectedShapeIds = copies.map(c => c.id);
  log(t("edit.pasted", { n: copies.length }));
  done();
}

function transformSelection(fn: (s: any, center: { x: number; y: number }) => void) {
  const b = selectionBounds();
  if (!b) return;
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  selectedShapes().forEach(s => fn(s, c));
  done();
}

/**
 * Ausrichten: Mehrere Teile (Gruppen zählen als ein Teil) an der Auswahl ausrichten.
 * Ist nur ein Teil ausgewählt, wird es am Arbeitsbereich (Bett) ausgerichtet.
 */
function align(kind: "left" | "centerH" | "right" | "top" | "centerV" | "bottom") {
  const sel = selectedShapes();
  if (!sel.length) return;

  // In Teile aufteilen
  const units = new Map<string, any[]>();
  sel.forEach(s => {
    const key = s.groupId || s.id;
    if (!units.has(key)) units.set(key, []);
    units.get(key)!.push(s);
  });

  let ref: Bounds;
  if (units.size === 1) {
    const bed = bedSizeMm();
    ref = { minX: 0, minY: 0, maxX: bed.w * MM_TO_PIXEL, maxY: bed.h * MM_TO_PIXEL };
  } else {
    ref = groupBounds(sel)!;
  }

  units.forEach(members => {
    const b = groupBounds(members)!;
    let dx = 0, dy = 0;
    if (kind === "left") dx = ref.minX - b.minX;
    if (kind === "right") dx = ref.maxX - b.maxX;
    if (kind === "centerH") dx = (ref.minX + ref.maxX) / 2 - (b.minX + b.maxX) / 2;
    if (kind === "bottom") dy = ref.minY - b.minY;
    if (kind === "top") dy = ref.maxY - b.maxY;
    if (kind === "centerV") dy = (ref.minY + ref.maxY) / 2 - (b.minY + b.maxY) / 2;
    members.forEach(s => translateShape(s, dx, dy));
  });
  done();
}

/** Ansicht so zoomen, dass Bett und alle Formen sichtbar sind */
export function zoomFit() {
  const st = app();
  const bed = bedSizeMm();
  // alle Betten zeigen (bei mehreren liegen sie nebeneinander), oben Platz für die Bett-Namen
  let b: Bounds = allBedsBounds();
  if (bedCount() > 1) b.maxY += 24 / Math.max(0.05, st.scale);
  const sb = groupBounds(st.shapes);
  if (sb) b = { minX: Math.min(b.minX, sb.minX), minY: Math.min(b.minY, sb.minY), maxX: Math.max(b.maxX, sb.maxX), maxY: Math.max(b.maxY, sb.maxY) };
  const W = canvasEl.width, H = canvasEl.height - 22;
  const margin = 40;
  const scale = Math.min((W - margin * 2) / (b.maxX - b.minX), (H - margin * 2) / (b.maxY - b.minY));
  st.scale = scale;
  const bedH = bed.h * MM_TO_PIXEL;
  // Mitte der Box in die Mitte des Canvas
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  st.offsetX = W / 2 - cx * scale;
  st.offsetY = H / 2 - (bedH - cy) * scale;
  redrawFn();
}

// =====================================================================
// VERSATZ-DIALOG (Offset): neue Kontur im Abstand um die Auswahl
// =====================================================================

function openOffsetDialog() {
  const sel = selectedShapes().filter(isClosedShape);
  if (!sel.length) { log(t("offset.selectFirst")); return; }

  document.getElementById("offset-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "offset-dialog-overlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
  ov.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border-color);border-radius:12px;padding:18px;width:340px;color:var(--text-main);display:flex;flex-direction:column;gap:10px;font-family:var(--font-ui);">
      <h3 style="margin:0;font-size:1rem;">⧉ ${t("offset.title")}</h3>
      <label style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;">${t("offset.distance")}
        <input id="off-dist" type="number" value="2" min="0.01" step="0.5" style="width:90px;"></label>
      <label style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;">${t("offset.direction")}
        <select id="off-dir" style="width:120px;">
          <option value="out">${t("offset.out")}</option>
          <option value="in">${t("offset.in")}</option>
          <option value="both">${t("offset.both")}</option>
        </select></label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;"><input id="off-del" type="checkbox"> ${t("offset.deleteOriginal")}</label>
      <div style="display:flex;gap:8px;">
        <button id="off-cancel" class="btn-secondary" style="flex:1;">${t("dlg.cancel")}</button>
        <button id="off-ok" class="btn-primary" style="flex:2;">✔ ${t("offset.create")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") (ov.querySelector("#off-ok") as HTMLElement).click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#off-cancel") as HTMLElement).onclick = close;
  (ov.querySelector("#off-ok") as HTMLElement).onclick = () => {
    const dist = parseFloat((ov.querySelector("#off-dist") as HTMLInputElement).value) || 0;
    const dir = (ov.querySelector("#off-dir") as HTMLSelectElement).value;
    const del = (ov.querySelector("#off-del") as HTMLInputElement).checked;
    close();
    if (dist <= 0) return;
    makeOffsets(sel, dist * MM_TO_PIXEL, dir, del);
  };
  setTimeout(() => (ov.querySelector("#off-dist") as HTMLInputElement).select(), 0);
}

/**
 * Löcher werden "andersherum" versetzt: Nach außen = Teil wird größer, also Löcher kleiner.
 */
function makeOffsets(sel: any[], d: number, dir: string, deleteOriginal: boolean) {
  const st = app();
  const paths = sel.map(s => shapeToPaths(s)[0]).filter(p => p && p.closed && p.pts.length >= 3);
  const areas = paths.map(p => Math.abs(pathArea(p.pts)));
  const created: any[] = [];
  const gid = "offs-" + newId();

  paths.forEach((p, i) => {
    let depth = 0;
    paths.forEach((q, j) => { if (j !== i && areas[j] > areas[i] && pointInPath(p.pts[0].x, p.pts[0].y, q.pts)) depth++; });
    const sign = depth % 2 === 1 ? -1 : 1;
    const dists = dir === "both" ? [d, -d] : dir === "in" ? [-d] : [d];
    dists.forEach(dd => {
      for (const loop of offsetPolygon(p.pts, dd * sign, 0.02)) {
        created.push(createPolyline(loop, true, depth % 2 === 1 ? "inside" : "outside", { groupId: gid }));
      }
    });
  });

  if (deleteOriginal) {
    const ids = new Set(sel.map(s => s.id));
    st.shapes = st.shapes.filter((s: any) => !ids.has(s.id));
  }
  st.shapes = [...st.shapes, ...created];
  st.selectedShapeIds = created.map(c => c.id);
  log(created.length ? t("offset.created", { n: created.length }) : t("offset.none"));
  done();
}

// =====================================================================
// VERSCHACHTELN-DIALOG: Teile eng aufs Bett legen (Abstand einstellbar)
// =====================================================================

const NEST_KEY = "cnc_craft_nest";
const NEST_DIRS: NestDir[] = ["left", "up", "down", "right"];
const NEST_ARROW: Record<NestDir, string> = { left: "←", up: "↑", down: "↓", right: "→" };

function loadNestOptions(): NestOptions {
  const def: NestOptions = { gapMm: 3, marginMm: 3, rotate: "90", holes: false, anchor: "bl", dir: "right" };
  try {
    const s = JSON.parse(localStorage.getItem(NEST_KEY) || "{}");
    const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
      gapMm: num(s.gapMm, def.gapMm),
      marginMm: num(s.marginMm, def.marginMm),
      rotate: ["none", "90", "45", "auto"].includes(s.rotate) ? s.rotate : def.rotate,
      holes: !!s.holes,
      anchor: NEST_ANCHORS.includes(s.anchor) ? s.anchor : def.anchor,
      dir: NEST_DIRS.includes(s.dir) ? s.dir : def.dir
    };
  } catch { return def; }
}

function overflowPref(): boolean {
  try { return JSON.parse(localStorage.getItem(NEST_KEY) || "{}").overflow === true; } catch { return false; }
}

/**
 * Was nicht aufs aktive Bett gepasst hat, kommt aufs nächste Bett (gibt es keins, wird eins angelegt) und wird
 * dort verschachtelt – so lange, bis alles liegt. Passt ein Teil nicht mal auf ein leeres Bett, ist es zu groß.
 */
function spillToBeds(opts: NestOptions, failedIds: string[], placedHere: number) {
  const start = activeBed();
  const used = [`${bedName(start)} (${placedHere})`];
  let left = failedIds;
  for (let guard = 0; left.length && guard < 100; guard++) {
    const target = activeBed() + 1 < bedCount() ? activeBed() + 1 : addBed();
    const wasEmpty = bedShapes(target).length === 0;
    const ids = new Set(left);
    moveToBed(left, target);
    switchBed(target);
    const r = nestShapes(opts, app().shapes.filter((s: any) => ids.has(s.id)));
    if (r.placed) used.push(`${bedName(target)} (${r.placed})`);
    if (!r.placed && wasEmpty) { log(t("nest.tooBig", { n: r.failed, name: bedName() })); break; }
    left = r.failedIds;
  }
  switchBed(start);
  zoomFit();
  log(t("nest.spread", { list: used.join(", ") }));
}

/**
 * Umrandung fürs Verschachteln in einer eigenen Kontur: die größte ausgewählte geschlossene Form –
 * aber nur, wenn außer ihr (und ihrer Gruppe) noch etwas anderes ausgewählt ist
 */
function nestContainer(): any | null {
  const sel = selectedShapes();
  let best: any = null, bestA = 0;
  for (const s of sel) {
    const p = shapeToPaths(s).find(q => q.closed && q.pts.length >= 3);
    if (!p) continue;
    const a = Math.abs(pathArea(p.pts));
    if (a > bestA) { bestA = a; best = s; }
  }
  if (!best) return null;
  const others = sel.filter((s: any) => s !== best && !(best.groupId && s.groupId === best.groupId));
  return others.length ? best : null;
}

function openNestDialog() {
  const st = app();
  if (!st.shapes.length) { log(t("nest.empty")); return; }
  const o = loadNestOptions();
  const n = st.selectedShapeIds.length;
  const container = nestContainer();

  document.getElementById("nest-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "nest-dialog-overlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
  const row = "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:0.85rem;";
  ov.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border-color);border-radius:12px;padding:18px;width:360px;color:var(--text-main);display:flex;flex-direction:column;gap:10px;font-family:var(--font-ui);">
      <h3 style="margin:0;font-size:1rem;">▦ ${t("nest.title")}</h3>
      <div style="font-size:0.8rem;color:var(--text-muted);">${n ? t("nest.scopeSel", { n }) : t("nest.scopeAll")}</div>
      <label style="${row}">${t("nest.gap")}
        <input id="nest-gap" type="number" value="${o.gapMm}" min="0" step="0.5" style="width:90px;"></label>
      <label style="${row}">${t("nest.margin")}
        <input id="nest-margin" type="number" value="${o.marginMm}" min="0" step="0.5" style="width:90px;"></label>
      <label style="${row}">${t("nest.rotate")}
        <select id="nest-rot" style="width:150px;">
          <option value="none">${t("nest.rotNone")}</option>
          <option value="90">90°</option>
          <option value="45">45°</option>
          <option value="auto">${t("nest.rotAuto")}</option>
        </select></label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;"><input id="nest-holes" type="checkbox" ${o.holes ? "checked" : ""}> ${t("nest.holes")}</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;" title="${t("nest.overflowTip")}"><input id="nest-overflow" type="checkbox" ${overflowPref() ? "checked" : ""}> ${t("nest.overflow")}</label>
      ${container ? `<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;" title="${t("nest.insideTip")}"><input id="nest-inside" type="checkbox" checked> ${t("nest.inside")}</label>` : ""}
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:0.85rem;">
        <div style="display:flex;flex-direction:column;gap:6px;">${t("nest.start")}
          <div style="display:grid;grid-template-columns:repeat(3,28px);gap:4px;padding:5px;border:1px dashed var(--border-color);border-radius:6px;width:max-content;">
            ${NEST_ANCHORS.map(a => `<button type="button" class="nest-pick" data-anchor="${a}" title="${t("nest.a." + a)}" aria-label="${t("nest.a." + a)}">●</button>`).join("")}
          </div></div>
        <div style="display:flex;flex-direction:column;gap:6px;">${t("nest.dir")}
          <div style="display:grid;grid-template-columns:repeat(3,28px);grid-template-rows:repeat(2,28px);gap:4px;">
            <span></span><button type="button" class="nest-pick" data-dir="up" title="${t("nest.d.up")}" aria-label="${t("nest.d.up")}">${NEST_ARROW.up}</button><span></span>
            <button type="button" class="nest-pick" data-dir="left" title="${t("nest.d.left")}" aria-label="${t("nest.d.left")}">${NEST_ARROW.left}</button>
            <button type="button" class="nest-pick" data-dir="down" title="${t("nest.d.down")}" aria-label="${t("nest.d.down")}">${NEST_ARROW.down}</button>
            <button type="button" class="nest-pick" data-dir="right" title="${t("nest.d.right")}" aria-label="${t("nest.d.right")}">${NEST_ARROW.right}</button>
          </div></div>
      </div>
      <div class="only-mill" style="font-size:0.78rem;color:var(--text-muted);">${t("nest.millHint")}</div>
      <div style="display:flex;gap:8px;">
        <button id="nest-cancel" class="btn-secondary" style="flex:1;">${t("dlg.cancel")}</button>
        <button id="nest-ok" class="btn-primary" style="flex:2;">✔ ${t("nest.run")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  (ov.querySelector("#nest-rot") as HTMLSelectElement).value = o.rotate;
  // Startpunkt + Richtung: gewählter Knopf leuchtet, Pfeile in die Wand sind gesperrt
  let anchor: NestAnchor = o.anchor, dir: NestDir = o.dir;
  const paint = () => {
    if (!nestDirAllowed(anchor, dir)) dir = NEST_DIRS.find(d => nestDirAllowed(anchor, d) && (d === "right" || d === "left"))!;
    ov.querySelectorAll<HTMLButtonElement>(".nest-pick").forEach(b => {
      const on = b.dataset.anchor ? b.dataset.anchor === anchor : b.dataset.dir === dir;
      b.disabled = !!b.dataset.dir && !nestDirAllowed(anchor, b.dataset.dir as NestDir);
      b.style.cssText = `width:28px;height:28px;padding:0;border-radius:5px;cursor:pointer;font-size:${b.dataset.anchor ? "0.6rem" : "0.95rem"};`
        + `border:1px solid ${on ? "var(--accent-color)" : "var(--border-color)"};background:${on ? "var(--accent-color)" : "transparent"};`
        + `color:${on ? "#fff" : "var(--text-muted)"};opacity:${b.disabled ? 0.25 : 1};`;
    });
  };
  ov.querySelectorAll<HTMLButtonElement>(".nest-pick").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.anchor) anchor = b.dataset.anchor as NestAnchor; else dir = b.dataset.dir as NestDir;
    paint();
  }));
  paint();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") (ov.querySelector("#nest-ok") as HTMLElement).click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#nest-cancel") as HTMLElement).onclick = close;
  (ov.querySelector("#nest-ok") as HTMLElement).onclick = () => {
    const num = (id: string) => Math.max(0, parseFloat((ov.querySelector(id) as HTMLInputElement).value) || 0);
    const opts: NestOptions = {
      gapMm: num("#nest-gap"),
      marginMm: num("#nest-margin"),
      rotate: (ov.querySelector("#nest-rot") as HTMLSelectElement).value as NestOptions["rotate"],
      holes: (ov.querySelector("#nest-holes") as HTMLInputElement).checked,
      anchor, dir
    };
    const overflow = (ov.querySelector("#nest-overflow") as HTMLInputElement).checked;
    try { localStorage.setItem(NEST_KEY, JSON.stringify({ ...opts, overflow })); } catch { /* egal */ }
    close();
    // In eigener Kontur: die größte ausgewählte geschlossene Form ist die Umrandung, der Rest wird hineingelegt
    const inside = container && (ov.querySelector("#nest-inside") as HTMLInputElement | null)?.checked;
    if (inside) {
      const keep = new Set(st.shapes.filter((s: any) => s === container || (container.groupId && s.groupId === container.groupId)));
      const parts = selectedShapes().filter((s: any) => !keep.has(s));
      const r = nestShapes({ ...opts, container }, parts);
      if (!r.total) log(t("nest.empty"));
      else if (r.failed) log(t("nest.insidePartial", { n: r.placed, total: r.total, failed: r.failed }));
      else log(t("nest.insideDone", { n: r.placed }));
      done();
      checkpoint();
      return;
    }
    const r = nestShapes(opts);
    if (!r.total) log(t("nest.empty"));
    else if (r.failed && overflow) { checkpoint(); spillToBeds(opts, r.failedIds, r.placed); }
    else if (r.failed) log(t("nest.partial", { n: r.placed, total: r.total, failed: r.failed }));
    else log(t("nest.done", { n: r.placed }));
    done();
    checkpoint();
  };
  setTimeout(() => (ov.querySelector("#nest-gap") as HTMLInputElement).select(), 0);
}

// =====================================================================
// FORMEN KOMBINIEREN / ZERSCHNEIDEN / ECKEN ABRUNDEN (Rechnung in shapeOps.ts)
// =====================================================================

function runCombine(op: BoolOp) {
  const sel = selectedShapes();
  if (sel.length < 2) { log(t("ops.needTwo")); return; }
  applyOp(combine(op, sel), "ops." + op + "Done");
}

/** Ergebnis übernehmen: alte Formen raus, neue rein und auswählen */
function applyOp(r: OpResult, doneKey: string) {
  if (r.error) { log(t(r.error)); return; }
  const st = app();
  const gone = new Set(r.remove);
  st.shapes = [...st.shapes.filter((s: any) => !gone.has(s)), ...r.add];
  st.selectedShapeIds = r.add.map((s: any) => s.id);
  log(t(doneKey, { n: r.remove.length, m: r.add.length }));
  done();
  checkpoint();
}

/**
 * Bildmaske: ein Bild + geschlossene Kontur(en) auswählen → das Bild wird nur innerhalb graviert.
 * Die Kontur bleibt stehen (zum Ausschneiden). Nur das Bild ausgewählt → Maske wieder weg.
 */
function imageMask() {
  const sel = selectedShapes();
  const imgs = sel.filter((s: any) => s.type === "image");
  if (imgs.length !== 1) { log(t("mask.selectOne")); return; }
  const im = imgs[0];
  const rings = sel.filter((s: any) => s !== im).flatMap((s: any) => shapeToPaths(s).filter(p => p.closed && p.pts.length >= 3).map(p => p.pts));
  if (!rings.length) {
    if (im.img?.mask) { delete im.img.mask; log(t("mask.removed")); done(); checkpoint(); }
    else log(t("mask.needContour"));
    return;
  }
  im.img = { ...im.img, mask: rings.map(r => r.map(q => toImageUV(im, q))) };
  app().selectedShapeIds = [im.id];
  log(t("mask.done", { n: rings.length }));
  done();
  checkpoint();
}

/** Bild teilen: Bild + gerade Linien auswählen; fast senkrechte Linien teilen links/rechts, fast waagerechte oben/unten */
async function imageSplit() {
  const sel = selectedShapes();
  const imgs = sel.filter((s: any) => s.type === "image");
  if (imgs.length !== 1) { log(t("isplit.select")); return; }
  const im = imgs[0];
  const lines = sel.filter((s: any) => s !== im && shapeToPaths(s).some(p => !p.closed && p.pts.length >= 2));
  if (!lines.length) { log(t("isplit.needLine")); return; }
  const cu: number[] = [], cv: number[] = [];
  for (const l of lines) {
    const p = shapeToPaths(l).find(q => !q.closed)!.pts;
    const a = toImageUV(im, p[0]), b = toImageUV(im, p[p.length - 1]);
    if (Math.abs(b.u - a.u) < Math.abs(b.v - a.v)) cu.push((a.u + b.u) / 2); else cv.push((a.v + b.v) / 2);
  }
  const pieces = await splitImage(im, cu, cv);
  if (pieces.length < 2) { log(t("isplit.outside")); return; }
  const st = app();
  const gone = new Set([im, ...lines]);
  st.shapes = [...st.shapes.filter((s: any) => !gone.has(s)), ...pieces];
  st.selectedShapeIds = pieces.map(p => p.id);
  log(t("isplit.done", { n: pieces.length }));
  done();
  checkpoint();
}

/** Verbinden und Anritzen: Ritzlinien kommen in die schwächste Linien-Ebene (Laser) bzw. werden flach graviert (Fräse) */
function weldScore() {
  const sel = selectedShapes();
  const mark = getLayers().filter(l => l.mode === "line").sort((a, b) => a.power - b.power)[0];
  const r = weldAndScore(sel, { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3 });
  if (r.error) { log(t(r.error)); return; }
  applyOp(r, "weld.done");
  log(t("weld.scores", { n: r.scores || 0 }));
}

/** Mittig fixieren: die größte ausgewählte geschlossene Form ist der Bezug, alle anderen bleiben darauf mittig */
function centerFix() {
  const sel = selectedShapes();
  let ref: any = null, best = 0;
  for (const s of sel) {
    const p = shapeToPaths(s).find(q => q.closed && q.pts.length >= 3);
    const a = p ? Math.abs(pathArea(p.pts)) : 0;
    if (a > best) { best = a; ref = s; }
  }
  const n = ref ? centerOn(ref, sel) : 0;
  if (!n) { log(t("dims.needTwo")); return; }
  log(t("dims.centered", { n }));
  done();
  checkpoint();
}

// =====================================================================
// KACHELN: großes Motiv in bettgroße Stücke teilen (jede Kachel auf ein eigenes Bett)
// =====================================================================

const TILE_KEY = "cnc_craft_tiles";
interface TileOptions { w: number; h: number; beds: boolean; marks: boolean }

function openTileDialog() {
  const sel = selectedShapes();
  if (!sel.length) { log(t("tile.select")); return; }
  const bed = bedSizeMm();
  let o: TileOptions = { w: bed.w, h: bed.h, beds: true, marks: true };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(TILE_KEY) || "{}") }; } catch { /* egal */ }
  const sb = groupBounds(sel)!;
  const sw = (sb.maxX - sb.minX) / MM_TO_PIXEL, sh = (sb.maxY - sb.minY) / MM_TO_PIXEL;
  document.getElementById("tile-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "tile-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:380px;">
      <h3>🧩 ${t("tile.title")}</h3>
      <div class="dlg-hint">${t("tile.desc", { w: sw.toFixed(1), h: sh.toFixed(1) })}</div>
      <label class="prop-row">${t("tile.w")}<input id="tile-w" type="number" step="1" min="5" class="prop-input" style="width:90px;"></label>
      <label class="prop-row">${t("tile.h")}<input id="tile-h" type="number" step="1" min="5" class="prop-input" style="width:90px;"></label>
      <button type="button" id="tile-bed" class="btn-secondary btn-compact">${t("tile.useBed", { w: bed.w, h: bed.h })}</button>
      <label class="prop-row" style="cursor:pointer;"><span>${t("tile.beds")}</span><input id="tile-beds" type="checkbox" style="width:auto;"></label>
      <label class="prop-row" style="cursor:pointer;"><span>${t("tile.marks")}</span><input id="tile-marks" type="checkbox" style="width:auto;"></label>
      <div class="tool-info" id="tile-info"></div>
      <div class="dlg-buttons">
        <button id="tile-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="tile-ok" class="btn-primary">✔ ${t("tile.run")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  $("tile-w").value = String(o.w); $("tile-h").value = String(o.h); $("tile-beds").checked = o.beds; $("tile-marks").checked = o.marks;
  const read = (): TileOptions => ({ w: Math.max(5, parseFloat($("tile-w").value) || bed.w), h: Math.max(5, parseFloat($("tile-h").value) || bed.h), beds: $("tile-beds").checked, marks: $("tile-marks").checked });
  const info = () => { const r = read(); const c = Math.max(1, Math.ceil(sw / r.w - 1e-6)), n = Math.max(1, Math.ceil(sh / r.h - 1e-6)); $("tile-info").textContent = t("tile.info", { c, r: n, n: c * n }); };
  ov.querySelectorAll("input").forEach(i => i.addEventListener("input", info));
  $("tile-bed").onclick = () => { $("tile-w").value = String(bed.w); $("tile-h").value = String(bed.h); info(); };
  info();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $("tile-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("tile-cancel").onclick = close;
  $("tile-ok").onclick = () => {
    const opts = read();
    try { localStorage.setItem(TILE_KEY, JSON.stringify(opts)); } catch { /* egal */ }
    close();
    runTiles(sel, opts);
  };
}

async function runTiles(sel: any[], o: TileOptions) {
  const W = o.w * MM_TO_PIXEL, H = o.h * MM_TO_PIXEL;
  const r = tileShapes(sel, W, H);
  if (r.error) { log(t(r.error)); return; }
  const tiles = r.tiles;
  const tileAt = (x: number, y: number): Tile | undefined =>
    tiles.find(tl => x >= tl.x0 - 1e-6 && x <= tl.x1 + 1e-6 && y >= tl.y0 - 1e-6 && y <= tl.y1 + 1e-6);
  // Bilder an den Kachelgrenzen teilen (nur nicht gedrehte; gedrehte bleiben ganz in der Kachel ihrer Mitte)
  for (const im of sel.filter((s: any) => s.type === "image")) {
    const [p0, p1, , p3] = im.points;
    const straight = Math.abs(p1.y - p0.y) < 1e-6 && Math.abs(p3.x - p0.x) < 1e-6;
    let pieces: any[] = [cloneShape(im)];
    if (straight) {
      const xs = [...new Set(tiles.map(tl => tl.x0))], ys = [...new Set(tiles.map(tl => tl.y0))];
      const cu = xs.map(x => toImageUV(im, { x, y: p0.y }).u), cv = ys.map(y => toImageUV(im, { x: p0.x, y }).v);
      pieces = await splitImage(im, cu, cv);
    } else log(t("tile.imageRotated"));
    for (const pc of pieces) {
      const cx = pc.points.reduce((a: number, q: any) => a + q.x, 0) / 4, cy = pc.points.reduce((a: number, q: any) => a + q.y, 0) / 4;
      (tileAt(cx, cy) || tiles[0]).shapes.push(pc);
    }
  }
  const used = tiles.filter(tl => tl.shapes.length);
  if (!used.length) { log(t("tile.select")); return; }
  // Passermarken: kleine Winkel in den Kachel-Ecken (schwächste Linien-Ebene bzw. flach graviert)
  if (o.marks && tiles.length > 1) {
    const mark = getLayers().filter(l => l.mode === "line").sort((a, b) => a.power - b.power)[0];
    const extra = { ...(mark ? { laserLayerId: mark.id } : {}), millingDepth: -0.3 };
    const L = 4 * MM_TO_PIXEL;
    for (const tl of used) {
      for (const [x, y, sx, sy] of [[tl.x0, tl.y0, 1, 1], [tl.x1, tl.y0, -1, 1], [tl.x1, tl.y1, -1, -1], [tl.x0, tl.y1, 1, -1]]) {
        tl.shapes.push(createPolyline([{ x: x + sx * L, y }, { x, y }, { x, y: y + sy * L }], false, "on-line", { ...extra }));
      }
    }
  }
  const st = app();
  const gone = new Set(sel.flatMap((s: any) => s.groupId ? st.shapes.filter((q: any) => q.groupId === s.groupId) : [s]));
  st.shapes = st.shapes.filter((s: any) => !gone.has(s));
  st.selectedShapeIds = [];
  if (o.beds && used.length > 1) {
    // jede Kachel an den Nullpunkt, Kachel 1 bleibt auf diesem Bett, die anderen bekommen je ein neues Bett
    used.forEach((tl, i) => {
      tl.shapes.forEach(s => translateShape(s, -tl.x0, -tl.y0));
      st.shapes = [...st.shapes, ...tl.shapes];
      if (i > 0) moveToBed(tl.shapes.map(s => s.id), addBed());
    });
    log(t("tile.doneBeds", { n: used.length }));
    zoomFit();
  } else {
    // auf demselben Bett etwas auseinanderziehen, damit man die Kacheln sieht
    const gap = 8 * MM_TO_PIXEL;
    for (const tl of used) {
      tl.shapes.forEach(s => translateShape(s, tl.col * gap, tl.row * gap));
      st.shapes = [...st.shapes, ...tl.shapes];
    }
    st.selectedShapeIds = used.flatMap(tl => tl.shapes.map(s => s.id));
    log(t("tile.done", { n: used.length }));
  }
  done();
  checkpoint();
}

const PATTERN_KEY = "cnc_craft_pattern";

function openPatternDialog() {
  const sel = selectedShapes();
  if (sel.length < 2) { log(t("pat.select")); return; }
  let o: PatternOptions = { gapX: 3, gapY: 3, brick: false, clip: false };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(PATTERN_KEY) || "{}") }; } catch { /* egal */ }
  document.getElementById("pattern-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "pattern-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:360px;">
      <h3>▦ ${t("pat.title")}</h3>
      <div class="dlg-hint">${t("pat.desc")}</div>
      <label class="prop-row">${t("pat.gapX")}<input id="pat-gx" type="number" step="0.5" min="0" class="prop-input" style="width:90px;"></label>
      <label class="prop-row">${t("pat.gapY")}<input id="pat-gy" type="number" step="0.5" min="0" class="prop-input" style="width:90px;"></label>
      <label class="prop-row" style="cursor:pointer;"><span>${t("pat.brick")}</span><input id="pat-brick" type="checkbox" style="width:auto;"></label>
      <label class="prop-row" style="cursor:pointer;"><span>${t("pat.clip")}</span><input id="pat-clip" type="checkbox" style="width:auto;"></label>
      <div class="dlg-buttons">
        <button id="pat-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="pat-ok" class="btn-primary">✔ ${t("pat.run")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;
  $("pat-gx").value = String(o.gapX); $("pat-gy").value = String(o.gapY); $("pat-brick").checked = o.brick; $("pat-clip").checked = o.clip;
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $("pat-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("pat-cancel").onclick = close;
  $("pat-ok").onclick = () => {
    const num = (id: string) => Math.max(0, parseFloat($(id).value) || 0);
    const opts: PatternOptions = { gapX: num("pat-gx"), gapY: num("pat-gy"), brick: $("pat-brick").checked, clip: $("pat-clip").checked };
    try { localStorage.setItem(PATTERN_KEY, JSON.stringify(opts)); } catch { /* egal */ }
    close();
    const r = patternFill(sel, opts);
    if (r.error) { log(t(r.error)); return; }
    const st = app();
    st.shapes = [...st.shapes, ...r.add];
    st.selectedShapeIds = r.add.map((s: any) => s.id);
    log(t("pat.done", { n: new Set(r.add.map((s: any) => s.groupId || s.id)).size }));
    done();
    checkpoint();
  };
  setTimeout(() => $("pat-gx").select(), 0);
}

const FILLET_KEY = "cnc_craft_fillet";

function openFilletDialog() {
  const sel = selectedShapes().filter((s: any) => s.type === "rect" || (s.type === "polyline" && s.closed));
  if (!sel.length) { log(t("ops.filletSelect")); return; }
  let o = { r: 3, chamfer: false };
  try { o = { ...o, ...JSON.parse(localStorage.getItem(FILLET_KEY) || "{}") }; } catch { /* egal */ }
  document.getElementById("fillet-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "fillet-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:340px;">
      <h3>◜ ${t("ops.filletTitle")}</h3>
      <div class="dlg-hint">${t("ops.filletDesc", { n: sel.length })}</div>
      <label class="prop-row">${t("ops.filletKind")}
        <select id="fil-kind" class="prop-input" style="width:auto;">
          <option value="round">${t("ops.filletRound")}</option><option value="chamfer">${t("ops.filletChamfer")}</option>
        </select></label>
      <label class="prop-row">${t("ops.filletRadius")}
        <input id="fil-r" type="number" min="0.1" step="0.5" class="prop-input" style="width:90px;"></label>
      <div class="dlg-buttons">
        <button id="fil-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="fil-ok" class="btn-primary">✔ ${t("ops.filletApply")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const rIn = ov.querySelector("#fil-r") as HTMLInputElement, kind = ov.querySelector("#fil-kind") as HTMLSelectElement;
  rIn.value = String(o.r); kind.value = o.chamfer ? "chamfer" : "round";
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") (ov.querySelector("#fil-ok") as HTMLElement).click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#fil-cancel") as HTMLElement).onclick = close;
  (ov.querySelector("#fil-ok") as HTMLElement).onclick = () => {
    const r = parseFloat(rIn.value), chamfer = kind.value === "chamfer";
    close();
    if (!(r > 0)) return;
    try { localStorage.setItem(FILLET_KEY, JSON.stringify({ r, chamfer })); } catch { /* egal */ }
    let corners = 0;
    for (const s of sel) corners += roundCorners(s, r * MM_TO_PIXEL, chamfer);
    log(corners ? t("ops.filletDone", { n: corners, r }) : t("ops.filletNone"));
    done();
    checkpoint();
  };
  setTimeout(() => rIn.select(), 0);
}

// =====================================================================
// DUPLIZIEREN-DIALOG: Anzahl Kopien oder Bett voll, auf Wunsch gleich verschachtelt
// =====================================================================

/** Fläche, die ein Satz der Auswahl mindestens belegt (Löcher abgezogen, plus etwas Abstand) – zum Schätzen */
function occupiedArea(sel: any[], gapPx: number): number {
  const paths = sel.flatMap(s => shapeToPaths(s));
  const closed = paths.filter(p => p.closed && p.pts.length >= 3);
  let area = 0, perim = 0;
  closed.forEach((p, i) => {
    const depth = closed.filter((q, j) => j !== i && pointInPath(p.pts[0].x, p.pts[0].y, q.pts)).length;
    area += (depth % 2 ? -1 : 1) * Math.abs(pathArea(p.pts));
  });
  for (const p of paths) for (let i = 1; i < p.pts.length; i++) perim += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
  return Math.max(0, area) + (perim * gapPx) / 4;
}

function openDuplicateDialog() {
  const sel = selectedShapes();
  if (!sel.length) { log(t("dup.selectFirst")); return; }
  const o = loadNestOptions();

  document.getElementById("dup-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "dup-dialog-overlay";
  ov.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
  const row = "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:0.85rem;";
  ov.innerHTML = `
    <div style="background:var(--bg-panel);border:1px solid var(--border-color);border-radius:12px;padding:18px;width:360px;color:var(--text-main);display:flex;flex-direction:column;gap:10px;font-family:var(--font-ui);">
      <h3 style="margin:0;font-size:1rem;">⧉ ${t("dup.title")}</h3>
      <div style="font-size:0.8rem;color:var(--text-muted);">${t("dup.scope", { n: sel.length })}</div>
      <label style="${row}"><span><input type="radio" name="dup-mode" value="count" checked> ${t("dup.count")}</span>
        <input id="dup-count" type="number" value="1" min="1" max="999" step="1" style="width:90px;"></label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;"><input type="radio" name="dup-mode" value="fill"> ${t("dup.fill")}</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;"><input id="dup-nest" type="checkbox" checked> ${t("dup.nest")}</label>
      <div id="dup-nest-opts" style="display:flex;flex-direction:column;gap:8px;padding-left:22px;">
        <label style="${row}">${t("nest.gap")}
          <input id="dup-gap" type="number" value="${o.gapMm}" min="0" step="0.5" style="width:90px;"></label>
        <label style="${row}">${t("nest.margin")}
          <input id="dup-margin" type="number" value="${o.marginMm}" min="0" step="0.5" style="width:90px;"></label>
        <div style="font-size:0.78rem;color:var(--text-muted);">${t("dup.nestHint")}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="dup-cancel" class="btn-secondary" style="flex:1;">${t("dlg.cancel")}</button>
        <button id="dup-ok" class="btn-primary" style="flex:2;">✔ ${t("dup.run")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <T extends HTMLElement>(q: string) => ov.querySelector(q) as T;
  const mode = () => (ov.querySelector('input[name="dup-mode"]:checked') as HTMLInputElement).value;
  // „Bett voll“ geht nur mit Verschachteln
  const sync = () => {
    const fill = mode() === "fill";
    if (fill) $<HTMLInputElement>("#dup-nest").checked = true;
    $<HTMLInputElement>("#dup-nest").disabled = fill;
    $<HTMLInputElement>("#dup-count").disabled = fill;
    $<HTMLElement>("#dup-nest-opts").style.opacity = $<HTMLInputElement>("#dup-nest").checked ? "1" : "0.4";
  };
  ov.querySelectorAll("input").forEach(i => i.addEventListener("change", sync));
  $<HTMLInputElement>("#dup-count").addEventListener("focus", () => { ($<HTMLInputElement>('input[value="count"]')).checked = true; sync(); });
  sync();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); if (e.key === "Enter") $<HTMLElement>("#dup-ok").click(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("#dup-cancel").onclick = close;
  $<HTMLElement>("#dup-ok").onclick = () => {
    const num = (id: string) => Math.max(0, parseFloat($<HTMLInputElement>(id).value) || 0);
    const fill = mode() === "fill";
    const nest = $<HTMLInputElement>("#dup-nest").checked;
    const opts: NestOptions = { ...loadNestOptions(), gapMm: num("#dup-gap"), marginMm: num("#dup-margin") };
    close();
    if (nest) { try { localStorage.setItem(NEST_KEY, JSON.stringify(opts)); } catch { /* egal */ } }
    duplicateMany(sel, fill, Math.min(999, Math.max(1, Math.round(num("#dup-count")))), nest, opts);
  };
  setTimeout(() => $<HTMLInputElement>("#dup-count").select(), 0);
}

function duplicateMany(sel: any[], fill: boolean, count: number, nest: boolean, opts: NestOptions) {
  const st = app();
  let want = count;
  if (fill) {
    // Obergrenze schätzen: freie Fläche ÷ Fläche eines Satzes (zu viele Kopien werden danach wieder entfernt)
    const bed = bedSizeMm();
    const m = 2 * opts.marginMm;
    const free = Math.max(0, bed.w - m) * Math.max(0, bed.h - m) * MM_TO_PIXEL * MM_TO_PIXEL;
    const one = occupiedArea(sel, opts.gapMm * MM_TO_PIXEL);
    want = Math.min(999, one > 0 ? Math.floor(free / one) : 999);
  }
  const sets: any[][] = [sel];
  for (let i = 1; i <= want; i++) sets.push(makeCopies(sel, nest ? 0 : 5 * MM_TO_PIXEL * i));
  const copies = sets.slice(1).flat();
  st.shapes = [...st.shapes, ...copies];

  let made = want;
  if (nest && copies.length) {
    const r = nestShapes(opts, undefined, sets);
    // Kopien, die nicht mehr aufs Bett passen, wieder weg (die Originale bleiben immer)
    const failed = new Set(r.failedIds);
    const gone = copies.filter(c => failed.has(c.id));
    if (gone.length) {
      const goneIds = new Set(gone.map(c => c.id));
      st.shapes = st.shapes.filter((s: any) => !goneIds.has(s.id));
      made = Math.max(0, Math.round(want - gone.length / sel.length));
    }
  }
  const kept = new Set(st.shapes.map((s: any) => s.id));
  st.selectedShapeIds = [...sel.map(s => s.id), ...copies.map(c => c.id).filter(id => kept.has(id))];
  if (!made) log(t("dup.none"));
  else if (fill) log(t("dup.full", { n: made }));
  else if (made < count) log(t("dup.partial", { n: made, want: count }));
  else log(t("dup.done", { n: made }));
  done();
  checkpoint();
}

// =====================================================================
// INITIALISIERUNG: Knöpfe + Tastatur
// =====================================================================

export function initCommands(canvas: HTMLCanvasElement, redraw: () => void, appendToConsole: (t: string) => void) {
  canvasEl = canvas;
  redrawFn = redraw;
  log = appendToConsole;

  // „Stege setzen“ im Panel (Fräs-Parameter) schaltet das Werkzeug ein
  document.getElementById("btn-tab-tool")?.addEventListener("click", () => setTool("tab"));

  // Alle Knöpfe mit data-cmd="..." verbinden
  document.querySelectorAll<HTMLElement>("[data-cmd]").forEach(btn => {
    const name = btn.dataset.cmd!;
    if (!commands[name]) return;
    btn.addEventListener("click", () => { commands[name](); checkpoint(); });
  });

  // Nach dem Klick auf einen Knopf den Fokus entfernen, sonst löst die Leertaste ihn erneut aus
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest?.("button");
    if (btn) (btn as HTMLButtonElement).blur();
  });

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    if (typing) return;
    if (document.querySelector("#text-dialog-overlay, #stl-dialog-overlay, #offset-dialog-overlay, #nest-dialog-overlay, #dup-dialog-overlay, #box-dialog-overlay, #fillet-dialog-overlay, #pattern-dialog-overlay, #eng-dialog-overlay, #imguse-overlay, #tool-dialog-overlay, #stock-dialog-overlay")) return;
    // Nur reagieren, wenn der CAM-Tab sichtbar ist
    const camTab = document.getElementById("tab-cam");
    if (camTab && !camTab.classList.contains("active")) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (e.key === " ") {
      if (!live.spaceDown) { live.spaceDown = true; updateCursor(); }
      e.preventDefault();
      return;
    }
    if (onToolKey(e)) { e.preventDefault(); return; }

    let handled = true;
    if (ctrl && key === "z" && !e.shiftKey) commands.undo();
    else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) commands.redo();
    else if (ctrl && key === "c") commands.copy();
    else if (ctrl && key === "x") commands.cut();
    else if (ctrl && key === "v") commands.paste();
    else if (ctrl && key === "d") commands.duplicate();
    else if (ctrl && key === "a") commands.selectAll();
    else if (ctrl && key === "g") commands.group();
    else if (ctrl && key === "u" && e.shiftKey) commands.splitParts();
    else if (ctrl && key === "u") commands.ungroup();
    else if (ctrl && key === "i") commands.importFile();
    else if (ctrl && key === "o") commands.openProject();
    else if (ctrl && key === "s") (e.shiftKey ? commands.saveProjectAs : commands.saveProject)();
    else if (!ctrl && (e.key === "Delete" || e.key === "Backspace")) commands.delete();
    else if (!ctrl && e.key.startsWith("Arrow")) nudge(e);
    else if (!ctrl && !e.altKey && key === "f") zoomFit();
    else if (!ctrl && !e.altKey && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
    else handled = false;

    if (handled) e.preventDefault();
  });

  window.addEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === " " && live.spaceDown) { live.spaceDown = false; updateCursor(); }
  });
}

function nudge(e: KeyboardEvent) {
  const sel = selectedShapes();
  if (!sel.length) return;
  const stepMm = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  const d = stepMm * MM_TO_PIXEL;
  const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
  const dy = e.key === "ArrowDown" ? -d : e.key === "ArrowUp" ? d : 0;
  sel.forEach(s => translateShape(s, dx, dy));
  done();
}
