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
import { app, bedSizeMm, ToolName } from "./editorState";
import { undo, redo, checkpoint } from "./history";
import { selectedShapes, selectionBounds } from "./selection";
import { setTool, onToolKey, live, updateCursor } from "./tools";
import {
  MM_TO_PIXEL, Bounds, groupBounds, translateShape, scaleShape, rotateShape, cloneShape, newId,
  shapeToPaths, isClosedShape, createPolyline, pathArea, pointInPath
} from "../shapeTransform";
import { offsetPolygon } from "../polyOffset";
import { nestShapes, NestOptions, NestAnchor, NestDir, NEST_ANCHORS, nestDirAllowed } from "./nest";
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
  v: "select", h: "pan", l: "line", r: "rect", e: "ellipse", p: "polygon", a: "arc", t: "text", m: "measure"
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
  nest: () => openNestDialog(),
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
  let b: Bounds = { minX: 0, minY: 0, maxX: bed.w * MM_TO_PIXEL, maxY: bed.h * MM_TO_PIXEL };
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

function openNestDialog() {
  const st = app();
  if (!st.shapes.length) { log(t("nest.empty")); return; }
  const o = loadNestOptions();
  const n = st.selectedShapeIds.length;

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
    try { localStorage.setItem(NEST_KEY, JSON.stringify(opts)); } catch { /* egal */ }
    close();
    const r = nestShapes(opts);
    if (!r.total) log(t("nest.empty"));
    else if (r.failed) log(t("nest.partial", { n: r.placed, total: r.total, failed: r.failed }));
    else log(t("nest.done", { n: r.placed }));
    done();
    checkpoint();
  };
  setTimeout(() => (ov.querySelector("#nest-gap") as HTMLInputElement).select(), 0);
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
    if (document.querySelector("#text-dialog-overlay, #stl-dialog-overlay, #offset-dialog-overlay, #nest-dialog-overlay, #dup-dialog-overlay, #tool-dialog-overlay, #stock-dialog-overlay")) return;
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
