/**
 * RECHTSKLICK-MENÜ AUF DER ZEICHENFLÄCHE
 *
 * Auf einer Form (bzw. in der Auswahl): Ausschneiden, Kopieren, Einfügen, Duplizieren, Löschen, Gruppieren,
 * Reihenfolge, Drehen/Spiegeln, Ausrichten, In Pfad umwandeln, Verbinden, Laser-Ebene bzw. Bearbeitungsart,
 * Auswahl exportieren. Auf leerer Fläche: Einfügen, Importieren, Alles auswählen, Alles exportieren, Alles zeigen.
 *
 * Die Einträge rufen dieselben Befehle wie die Knöpfe (editor/commands.ts, data-cmd) – keine eigene Logik.
 * Das Menü wird nur mit textContent gebaut (Ebenen-Namen kommen aus Importen/Bibliotheken).
 * Öffnen: tools.ts merkt beim Rechtsklick, ob gerade nichts gezeichnet wird (live.menuOk), mouseEngine.ts zeigt es.
 */
import { t } from "../i18n/i18n";
import { icon } from "./icons";
import { app } from "../editor/editorState";
import { hitTest, clickSelect, selectedShapes, insideSelectionBox } from "../editor/selection";
import { commands, hasClipboard } from "../editor/commands";
import { checkpoint } from "../editor/history";
import { getLayers } from "../laserLayers";
import { isLaser, isPlasma } from "../machineMode";
import { refreshLaserPanel } from "./laserPanel";
import { EXPORT_FORMATS, exportDrawing, formatLabel } from "./exportMenu";

export interface MenuItem {
  label: string;
  key?: string;          // Tastenkürzel (nur Anzeige)
  ico?: string;          // Symbol aus icons.ts
  swatch?: string;       // Farbfeld (Laser-Ebene)
  disabled?: boolean;
  run?: () => void;
  sub?: MenuEntry[];
}
export type MenuEntry = MenuItem | "sep";

let redrawFn: () => void = () => {};
let log: (s: string) => void = () => {};
const open: HTMLElement[] = []; // offene Menüs (Haupt- + Untermenüs)

export function initCanvasMenu(redraw: () => void, appendToConsole: (s: string) => void) {
  redrawFn = redraw;
  log = appendToConsole;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const ctrl = (k: string) => MAC ? `⌘${k}` : `Ctrl+${k}`;

// =====================================================================
// MENÜ ANZEIGEN
// =====================================================================

export function closeMenus() {
  while (open.length) open.pop()!.remove();
  window.removeEventListener("mousedown", onOutside, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeMenus);
  window.removeEventListener("resize", closeMenus);
  window.removeEventListener("wheel", closeMenus, true);
}

function onOutside(e: MouseEvent) {
  if (!open.some(m => m.contains(e.target as Node))) closeMenus();
}

function onKey(e: KeyboardEvent) {
  const menu = open[open.length - 1];
  if (!menu) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>("button.ctx-item:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  let handled = true;
  if (e.key === "Escape") { if (open.length > 1) { open.pop()!.remove(); (open[open.length - 1].querySelector(".ctx-item.open") as HTMLElement | null)?.focus(); } else closeMenus(); }
  else if (e.key === "ArrowDown") items[(at + 1) % items.length]?.focus();
  else if (e.key === "ArrowUp") items[(at - 1 + items.length) % items.length]?.focus();
  else if (e.key === "ArrowRight" && at >= 0 && items[at].classList.contains("has-sub")) items[at].click();
  else if (e.key === "ArrowLeft" && open.length > 1) { open.pop()!.remove(); (open[open.length - 1].querySelector(".ctx-item.open") as HTMLElement | null)?.focus(); }
  else if (e.key === "Enter" && at >= 0) items[at].click();
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

/** Menü an Bildschirm-Position (clientX/Y) zeigen – bleibt immer im Fenster */
export function showMenu(entries: MenuEntry[], x: number, y: number) {
  closeMenus();
  const m = buildMenu(entries, 0);
  place(m, x, y, x);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeMenus);
  window.addEventListener("resize", closeMenus);
  window.addEventListener("wheel", closeMenus, true);
}

/** Menü bei (x, y) zeigen; passt es nicht nach rechts/unten, nach links (bis altX) bzw. oben schieben */
function place(m: HTMLElement, x: number, y: number, altX: number) {
  document.body.appendChild(m);
  open.push(m);
  const r = m.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  let left = x, top = y;
  if (left + r.width > W - 4) left = Math.max(4, altX - r.width);
  if (top + r.height > H - 4) top = Math.max(4, H - 4 - r.height);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

function buildMenu(entries: MenuEntry[], level: number): HTMLElement {
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.setAttribute("role", "menu");
  m.addEventListener("contextmenu", e => e.preventDefault());
  // überflüssige Trennlinien weglassen (am Anfang, am Ende, doppelt)
  const list = entries.filter((e, i, a) => e !== "sep" || (i > 0 && i < a.length - 1 && a[i - 1] !== "sep"));
  for (const e of list) {
    if (e === "sep") { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ctx-item" + (e.sub ? " has-sub" : "");
    b.setAttribute("role", "menuitem");
    b.disabled = !!e.disabled || (!!e.sub && !e.sub.some(s => s !== "sep" && !s.disabled));
    const ico = document.createElement("span");
    ico.className = "ctx-ico";
    if (e.swatch) { const sw = document.createElement("span"); sw.className = "ctx-swatch"; sw.style.background = /^#[0-9a-f]{3,8}$/i.test(e.swatch) ? e.swatch : "#888"; ico.appendChild(sw); }
    else if (e.ico) ico.innerHTML = icon(e.ico, 16); // eigene Symbole, kein fremder Text
    const lbl = document.createElement("span");
    lbl.className = "ctx-label";
    lbl.textContent = e.label;
    const key = document.createElement("span");
    key.className = "ctx-key";
    key.textContent = e.sub ? "▸" : e.key || "";
    b.append(ico, lbl, key);

    const openSub = () => {
      // Untermenüs dieser Ebene und tiefer schließen
      while (open.length > level + 1) open.pop()!.remove();
      m.querySelectorAll(".ctx-item.open").forEach(o => o.classList.remove("open"));
      if (!e.sub || b.disabled) return;
      b.classList.add("open");
      const r = b.getBoundingClientRect();
      const sm = buildMenu(e.sub, level + 1);
      place(sm, r.right - 2, r.top - 4, r.left + 2);
      (sm.querySelector("button.ctx-item:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });
    };
    b.addEventListener("mouseenter", () => {
      if (e.sub) openSub();
      else { while (open.length > level + 1) open.pop()!.remove(); m.querySelectorAll(".ctx-item.open").forEach(o => o.classList.remove("open")); }
    });
    b.addEventListener("click", () => {
      if (b.disabled) return;
      if (e.sub) { openSub(); return; }
      closeMenus();
      e.run?.();
    });
    m.appendChild(b);
  }
  return m;
}

// =====================================================================
// INHALT
// =====================================================================

/** Befehl wie über den Knopf ausführen (mit Rückgängig-Punkt) */
const cmd = (name: string) => () => { commands[name]?.(); checkpoint(); };

function exportEntries(all: boolean): MenuEntry[] {
  return EXPORT_FORMATS.map(f => ({ label: formatLabel(f), run: () => { exportDrawing(f, all, log); } }));
}

function layerEntries(): MenuEntry[] {
  if (isPlasma()) return [];
  const sel = selectedShapes();
  if (isLaser()) {
    const layers = getLayers();
    const one = new Set(sel.map(s => s.laserLayerId));
    return [{
      label: t("cm.layer"), ico: "layers",
      sub: layers.map(l => ({
        label: l.name + (one.size === 1 && one.has(l.id) ? "  ✓" : ""), swatch: l.color,
        run: () => { sel.forEach(s => { s.laserLayerId = l.id; }); refreshLaserPanel(true); redrawFn(); checkpoint(); }
      }))
    }];
  }
  // Fräse: die Knöpfe „Bahn-Korrektur“ im rechten Panel (offsetModes.ts) auslösen
  const modes = ["part", "hole", "engrave", "pocket", "vcarve", "drill", "face"].filter(m => document.getElementById(`cam-mode-${m}`));
  if (!modes.length) return [];
  return [{
    label: t("cm.milling"), ico: "endmill",
    sub: modes.map(m => ({ label: t(`mode.${m}`), run: () => { document.getElementById(`cam-mode-${m}`)?.click(); checkpoint(); } }))
  }];
}

function shapeMenu(): MenuEntry[] {
  const sel = selectedShapes();
  const n = sel.length;
  const units = new Set(sel.map(s => s.groupId || s.id)).size;
  const grouped = sel.some(s => s.groupId);
  const convertible = sel.some(s => s.type !== "polyline" && s.type !== "image");
  return [
    { label: t("cm.cut"), ico: "cut", key: ctrl("X"), run: cmd("cut") },
    { label: t("cm.copy"), ico: "copy", key: ctrl("C"), run: cmd("copy") },
    { label: t("cm.paste"), ico: "paste", key: ctrl("V"), run: cmd("paste"), disabled: !hasClipboard() },
    { label: t("cm.duplicate"), ico: "duplicate", key: ctrl("D"), run: cmd("duplicate") },
    { label: t("cm.delete"), ico: "delete", key: t("cm.keyDel"), run: cmd("delete") },
    "sep",
    { label: t("cm.group"), ico: "group", key: ctrl("G"), run: cmd("group"), disabled: n < 2 },
    { label: t("cm.ungroup"), ico: "ungroup", key: ctrl("U"), run: cmd("ungroup"), disabled: !grouped },
    { label: t("cm.front"), ico: "toFront", run: cmd("toFront") },
    { label: t("cm.back"), ico: "toBack", run: cmd("toBack") },
    "sep",
    {
      label: t("cm.transform"), ico: "rotateLeft", sub: [
        { label: t("cm.rotateLeft"), ico: "rotateLeft", run: cmd("rotateLeft") },
        { label: t("cm.rotateRight"), ico: "rotateRight", run: cmd("rotateRight") },
        { label: t("cm.mirrorH"), ico: "mirrorH", run: cmd("mirrorH") },
        { label: t("cm.mirrorV"), ico: "mirrorV", run: cmd("mirrorV") }
      ]
    },
    {
      // ein Teil allein wird am Bett ausgerichtet, mehrere aneinander
      label: units > 1 ? t("cm.align") : t("cm.alignBed"), ico: "alignCenterH", sub: [
        { label: t("cm.alignLeft"), ico: "alignLeft", run: cmd("alignLeft") },
        { label: t("cm.alignCenterH"), ico: "alignCenterH", run: cmd("alignCenterH") },
        { label: t("cm.alignRight"), ico: "alignRight", run: cmd("alignRight") },
        { label: t("cm.alignTop"), ico: "alignTop", run: cmd("alignTop") },
        { label: t("cm.alignCenterV"), ico: "alignCenterV", run: cmd("alignCenterV") },
        { label: t("cm.alignBottom"), ico: "alignBottom", run: cmd("alignBottom") }
      ]
    },
    {
      label: t("cm.combine"), ico: "boolUnion", sub: [
        { label: t("cm.union"), ico: "boolUnion", run: cmd("boolUnion"), disabled: n < 2 },
        { label: t("cm.subtract"), ico: "boolSubtract", run: cmd("boolSubtract"), disabled: n < 2 },
        { label: t("cm.intersect"), ico: "boolIntersect", run: cmd("boolIntersect"), disabled: n < 2 },
        "sep",
        { label: t("cm.offset"), ico: "offset", run: cmd("offset") }
      ]
    },
    { label: t("cm.toPath"), ico: "node", run: cmd("toPath"), disabled: !convertible },
    ...layerEntries(),
    "sep",
    { label: t("cm.exportSel", { n }), ico: "export", sub: exportEntries(false) }
  ];
}

function canvasMenu(): MenuEntry[] {
  const any = app().shapes.length > 0;
  return [
    { label: t("cm.paste"), ico: "paste", key: ctrl("V"), run: cmd("paste"), disabled: !hasClipboard() },
    { label: t("cm.import"), ico: "import", key: ctrl("I"), run: cmd("importFile") },
    "sep",
    { label: t("cm.selectAll"), ico: "selectAll", key: ctrl("A"), run: cmd("selectAll"), disabled: !any },
    { label: t("cm.exportAll"), ico: "export", sub: exportEntries(true), disabled: !any },
    "sep",
    { label: t("cm.zoomFit"), ico: "zoomFit", key: "F", run: cmd("zoomFit") }
  ];
}

/**
 * Rechtsklick auf der Zeichenfläche: Form unter der Maus auswählen (falls noch nicht ausgewählt) und das
 * passende Menü zeigen. sx/sy = Canvas-Pixel, wx/wy = Welt-Pixel
 */
export function openCanvasMenu(clientX: number, clientY: number, sx: number, sy: number, wx: number, wy: number) {
  const st = app();
  const hit = hitTest(wx, wy);
  if (hit && !st.selectedShapeIds.includes(hit.id)) { clickSelect(hit, false, false); redrawFn(); }
  const onSel = !!hit || (st.selectedShapeIds.length > 0 && insideSelectionBox(sx, sy));
  showMenu(onSel ? shapeMenu() : canvasMenu(), clientX, clientY);
}

/** Export-Formate unter einem Knopf zeigen (Datei-Leiste, Strg+E) */
export function openExportMenu(anchor: HTMLElement | null) {
  const n = selectedShapes().length;
  const r = anchor?.getBoundingClientRect();
  const entries: MenuEntry[] = n
    ? [...exportEntries(false), "sep", { label: t("cm.exportAll"), ico: "export", sub: exportEntries(true) }]
    : exportEntries(true);
  const x = r ? r.left : window.innerWidth / 2, y = r ? r.bottom + 2 : window.innerHeight / 3;
  showMenu(entries, x, y);
  (open[0]?.querySelector("button.ctx-item:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });
}
