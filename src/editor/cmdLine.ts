/**
 * BEFEHLSZEILE (wie in AutoCAD): Enter auf der leeren Zeichenfläche oder der Knopf in der Werkzeugleiste öffnet sie.
 * Befehl tippen (L, REC, C, M …), dann Punkte tippen oder klicken. Was die Eingabe heißt, steht in cmdParse.ts.
 *
 *   Zeichnen (L, REC, EL, POL, STAR, SLOT, RING, A, ARCC, T, DI)   schaltet das Werkzeug ein, getippte Punkte wirken wie Klicks
 *   Kreis (C)          Mittelpunkt, dann Radius, D… = Durchmesser, oder ein Punkt auf dem Kreis
 *   Verschieben (M), Kopieren (CO)   Basispunkt, Zielpunkt – für die Auswahl
 *   Drehen (RO)        Drehpunkt, Winkel – für die Auswahl
 *   E, U, REDO, O, F, TR, MI, Z, V   löschen, rückgängig, wiederholen, Versatz, Verrunden, Stutzen, Spiegeln, Alles zeigen, Auswahl
 *   ?                  alle Befehle
 *
 * Enter auf leerer Zeile: Linie fertig bzw. Befehl beenden, ohne Befehl den letzten wiederholen. Esc: abbrechen, dann schließen.
 * Punkte für Kreis/Verschieben/Drehen nimmt auch die Maus (tools.ts → pick), mit Fang.
 */
import { t } from "../i18n/i18n";
import { isInch, fmtLenU } from "../units";
import { MM_TO_PIXEL, Pt, convertToPolyline, createCircle, makeRectPoints, rotateShape, scaleShape, shapeBounds, translateShape, updatePolylineBounds } from "../shapeTransform";
import { inBox, refFactor, stretchPoints, type Box } from "./joinExplode";
import { syncPoints } from "./bezier";
import { app, options, saveOptions, ToolName } from "./editorState";
import { addShapes, cancelCurrent, currentTool, drawingBase, finishLine, live, pick, placePoint, setTool } from "./tools";
import { selectedShapes } from "./selection";
import { aliasesOf, CmdName, parseCommand, parseConKind, parsePoint } from "./cmdParse";
import { calc, typedAngle, typedLen } from "./typedValues";
import { commands, makeCopies } from "./commands";

const DRAW: Partial<Record<CmdName, ToolName>> = {
  line: "line", rect: "rect", ellipse: "ellipse", polygon: "polygon", star: "star", slot: "slot", ring: "ring",
  arc: "arc", arcCenter: "arcCenter", text: "text", measure: "measure"
};
/** Befehle, die einfach einen vorhandenen Knopf-Befehl auslösen */
const SIMPLE: Partial<Record<CmdName, string>> = {
  erase: "delete", undo: "undo", redo: "redo", offset: "offset", mirror: "mirrorH", zoom: "zoomFit",
  extrude: "extrude", body: "body3d", join: "joinLines", explode: "explode", ortho: "ortho"
};

type Mode =
  | { k: "none" }
  | { k: "draw"; tool: ToolName; began: boolean }  // began: es wurde schon etwas angefangen (danach fertig = Befehl aus)
  | { k: "circle"; c?: Pt }
  | { k: "corner" }                                 // Werkzeug „Ecke“: getippte Zahl = neuer Radius
  | { k: "move" | "copy"; base?: Pt }
  | { k: "rotate"; base?: Pt }
  | { k: "stretch"; c1?: Pt; c2?: Pt; base?: Pt }    // Strecken: Rechteck (zwei Ecken), Basispunkt, Zielpunkt
  | { k: "scale"; base?: Pt; step: "factor" | "ref1" | "ref2" | "new"; refA?: Pt; refLen?: number };

let mode: Mode = { k: "none" };
let bar: HTMLDivElement | null = null;
let input: HTMLInputElement | null = null;
let promptEl: HTMLElement | null = null;
let msgEl: HTMLElement | null = null;
let lastCmd: CmdName | null = null;
let lastPt: Pt | null = null;          // zuletzt gesetzter Punkt (Welt-Pixel) – Bezug für „@“
let redraw: () => void = () => {};

export function cmdLineOpen(): boolean { return !!bar; }

export function initCmdLine(redrawFn: () => void) {
  redraw = redrawFn;
  window.addEventListener("resize", place);
  window.addEventListener("cnc-tool-changed", () => setTimeout(refresh, 0));
  // Nach einem Klick auf die Zeichenfläche: Anzeige nachführen und die Zeile wieder bereit zum Tippen
  window.addEventListener("mouseup", e => {
    if (!bar) return;
    setTimeout(() => {
      refresh();
      const a = document.activeElement as HTMLElement | null;
      const onCanvas = (e.target as HTMLElement | null)?.id === "cnc-canvas";
      if (onCanvas && (!a || a === document.body || a.id === "cnc-canvas")) input?.focus();
    }, 0);
  }, true);
}

export function toggleCmdLine() { if (bar) closeCmdLine(); else openCmdLine(); }

/** Befehl von einem Knopf aus starten (Befehlszeile öffnet sich und fragt nach den Punkten) */
export function runCommand(cmd: CmdName) {
  openCmdLine();
  startCommand(cmd);
  refresh();
  redraw();
}

export function openCmdLine() {
  if (bar) { input?.focus(); return; }
  bar = document.createElement("div");
  bar.className = "cmd-line";
  bar.title = t("cl.tip");
  msgEl = document.createElement("div");
  msgEl.className = "cmd-line-msg";
  const row = document.createElement("label");
  row.className = "cmd-line-row";
  promptEl = document.createElement("span");
  promptEl.className = "cmd-line-prompt";
  input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = t("cl.placeholder");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cmd-line-x";
  close.textContent = "×";
  close.title = t("cl.close");
  close.addEventListener("click", closeCmdLine);
  row.append(promptEl, input, close);
  bar.append(msgEl, row);
  document.body.appendChild(bar);
  input.addEventListener("keydown", onKey);
  refresh();
  place();
  input.focus();
}

export function closeCmdLine() {
  endCommand();
  bar?.remove();
  bar = null; input = null; promptEl = null; msgEl = null;
  redraw();
}

/** Unten über der Zeichenfläche, über der Statuszeile */
function place() {
  if (!bar) return;
  const c = document.getElementById("cnc-canvas");
  if (!c) return;
  const r = c.getBoundingClientRect();
  bar.style.left = `${r.left + 8}px`;
  bar.style.width = `${Math.max(260, Math.min(620, r.width - 16))}px`;
  bar.style.top = `${r.bottom - 26 - bar.offsetHeight}px`;
}

function say(text: string) {
  if (!msgEl) return;
  msgEl.textContent = text;
  place();
}

// ---------------------------------------------------------------------
// Was gerade gefragt wird
// ---------------------------------------------------------------------

function drawing(): boolean { return !!drawingBase() || (currentTool() === "line" && live.points.length > 0); }

/** Mit der Maus angefangen, während die Zeile offen ist: dann gilt sie als Zeichenbefehl */
function adopt() {
  if (mode.k === "none" && drawing()) mode = { k: "draw", tool: currentTool(), began: true };
}

function prompt(): string {
  adopt();
  switch (mode.k) {
    case "circle": return t(mode.c ? "cl.radius" : "cl.center");
    case "corner": return t(options.cornerChamfer ? "cl.chamferLen" : "cl.cornerR", { r: fmtLenU(options.cornerSize) });
    case "move": case "copy": return t(mode.base ? "cl.target" : "cl.base");
    case "rotate": return t(mode.base ? "cl.angle" : "cl.pivot");
    case "stretch": return t(!mode.c1 ? "cl.stretch1" : !mode.c2 ? "cl.stretch2" : mode.base ? "cl.target" : "cl.base");
    case "scale":
      if (!mode.base) return t("cl.base");
      return t(mode.step === "factor" ? "cl.scaleFactor" : mode.step === "ref1" ? "cl.refLen" : mode.step === "ref2" ? "cl.refLen2" : "cl.newLen");
    case "draw": {
      const tool = currentTool(), n = live.points.length, started = !!drawingBase();
      if (tool === "line") return t(n ? "cl.nextLine" : "cl.start");
      if (tool === "rect" || tool === "ellipse" || tool === "slot") return t(started ? "cl.corner2" : "cl.corner1");
      if (tool === "polygon" || tool === "star" || tool === "ring") return t(started ? "cl.edge" : "cl.center");
      if (tool === "arc") return t(n === 0 ? "cl.start" : n === 1 ? "cl.arcEnd" : "cl.arcMid");
      if (tool === "arcCenter") return t(n === 0 ? "cl.center" : n === 1 ? "cl.start" : "cl.arcEnd");
      if (tool === "measure") return t(started ? "cl.point2" : "cl.point1");
      if (tool === "text") return t("cl.textPos");
      return t("cl.cmd");
    }
    default: return t("cl.cmd");
  }
}

function refresh() {
  if (!bar || !promptEl) return;
  // Zeichnung fertig (auch per Maus) oder anderes Werkzeug gewählt: wieder Befehl
  if (mode.k === "corner" && currentTool() !== "corner") mode = { k: "none" };
  if (mode.k === "draw") {
    if (currentTool() !== mode.tool) mode = { k: "none" };
    else if (drawing()) mode.began = true;
    else if (mode.began) mode = { k: "none" };
  }
  promptEl.textContent = prompt();
  place();
}

function endCommand() {
  if (mode.k !== "none" && mode.k !== "draw") { pick.hook = null; pick.from = null; pick.move = null; pick.lines = null; }
  mode = { k: "none" };
}

// ---------------------------------------------------------------------
// Eingabe
// ---------------------------------------------------------------------

function onKey(e: KeyboardEvent) {
  e.stopPropagation(); // keine Tastenkürzel der Zeichenfläche
  if (e.key === "Escape") {
    e.preventDefault();
    if (input && input.value) { input.value = ""; return; }
    if (mode.k !== "none" || drawing()) { cancelCurrent(); endCommand(); say(t("cl.cancelled")); refresh(); redraw(); }
    else closeCmdLine();
    return;
  }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const v = input!.value.trim();
  input!.value = "";
  run(v);
  refresh();
  redraw();
}

const toMm = (p: Pt) => ({ x: p.x / MM_TO_PIXEL, y: p.y / MM_TO_PIXEL });
const toPx = (p: { x: number; y: number }) => ({ x: p.x * MM_TO_PIXEL, y: p.y * MM_TO_PIXEL });

/** Punkt lesen: Bezug base (Welt-Pixel), Richtung für reine Längen zur Maus */
function readPoint(v: string, base: Pt | null): Pt | null {
  const b = base ? toMm(base) : null;
  const w = live.world;
  const dir = base && (w.x !== base.x || w.y !== base.y) ? Math.atan2(w.y - base.y, w.x - base.x) : base ? 0 : null;
  const p = parsePoint(v, b, dir, isInch());
  return p ? toPx(p) : null;
}

function run(v: string) {
  adopt();

  if (!v) {
    if (mode.k === "draw") {
      if (currentTool() === "line" && live.points.length >= 2) finishLine(false); else cancelCurrent();
      endCommand();
    } else if (mode.k !== "none") endCommand(); // Enter = Befehl normal beenden (z. B. Kopieren)
    else if (lastCmd) startCommand(lastCmd);
    return;
  }

  switch (mode.k) {
    case "none": {
      const cmd = parseCommand(v);
      if (!cmd) {
        const ck = parseConKind(v);
        if (ck) { // Bedingung: Werkzeug mit dieser Art einschalten
          options.conKind = ck;
          saveOptions();
          const sel = document.getElementById("opt-con-kind") as HTMLSelectElement | null;
          if (sel) sel.value = ck;
          setTool("constrain");
          say(t("con.k." + ck));
          return;
        }
        say(t("cl.unknown", { w: v }));
        return;
      }
      startCommand(cmd);
      return;
    }
    case "draw": return drawInput(v);
    case "corner": {
      // Werkzeug „Ecke“ wartet nur auf Klicks: ein Befehlswort startet gleich den nächsten Befehl
      const cmd = parseCommand(v);
      if (cmd && !Number.isFinite(typedLen(v, isInch()))) { startCommand(cmd); return; }
      if (modeValue(v) === "bad") say(t("cl.badNumber", { w: v }));
      return;
    }
    default: {
      const p = modeValue(v);
      if (p === "bad") say(t("cl.badPoint", { w: v }));
      return;
    }
  }
}

function drawInput(v: string) {
  const tool = currentTool();
  const low = v.toLowerCase();
  if (tool === "line" && (low === "c" || low === "close")) { finishLine(true); endCommand(); return; }
  if (tool === "line" && (low === "u" || low === "undo")) {
    if (live.points.length) live.points.pop();
    if (!live.points.length) live.label = "";
    return;
  }
  const p = readPoint(v, drawingBase() ?? lastPt);
  if (!p) { say(t("cl.badPoint", { w: v })); return; }
  lastPt = p;
  placePoint(p);
}

function startCommand(cmd: CmdName) {
  lastCmd = cmd;
  endCommand();
  const tool = DRAW[cmd];
  if (tool) {
    setTool(tool);
    mode = { k: "draw", tool, began: false };
    say(t("cl.started", { c: aliasesOf(cmd)[0] }));
    return;
  }
  const simple = SIMPLE[cmd];
  if (simple) { lastCmd = null; commands[simple]?.(); say(""); return; }
  switch (cmd) {
    case "trim": setTool("trim"); say(""); return;
    case "extend": setTool("extend"); say(t("hint.extend")); return;
    case "corner": case "chamfer": {
      options.cornerChamfer = cmd === "chamfer";
      saveOptions();
      const box = document.getElementById("opt-corner-chamfer") as HTMLInputElement | null;
      if (box) box.checked = options.cornerChamfer;
      setTool("corner");
      mode = { k: "corner" };
      say(t("hint.corner"));
      return;
    }
    case "select": setTool("select"); say(""); return;
    case "help": lastCmd = null; say(t("cl.help")); return;
    case "circle":
      cancelCurrent();
      mode = { k: "circle" };
      break;
    case "move": case "copy": case "rotate":
      if (!selectedShapes().length) { say(t("cl.selectFirst")); lastCmd = null; return; }
      cancelCurrent();
      mode = { k: cmd };
      break;
    case "scale":
      if (!selectedShapes().length) { say(t("cl.selectFirst")); lastCmd = null; return; }
      cancelCurrent();
      mode = { k: "scale", step: "factor" };
      break;
    case "stretch":
      cancelCurrent();
      mode = { k: "stretch" };
      break;
  }
  pick.from = null;
  pick.hook = p => { modePoint(p); refresh(); redraw(); };
  say("");
}

/** Getippter Wert in Ecke/Kreis/Verschieben/Kopieren/Drehen/Skalieren */
function modeValue(v: string): "ok" | "bad" {
  if (mode.k === "scale" && mode.base) {
    if (mode.step === "factor") {
      if (/^r(ef(erence)?)?$/i.test(v)) { mode.step = "ref1"; return "ok"; }
      const f = calc(v);
      if (!(f > 0)) return "bad";
      doScale(mode.base, f);
      return "ok";
    }
    const len = typedLen(v, isInch());
    if (mode.step === "ref1" && len > 0) { mode.refLen = len * MM_TO_PIXEL; mode.step = "new"; return "ok"; }
    if (mode.step === "new" && len > 0 && mode.refLen) { const f = refFactor(mode.refLen, len * MM_TO_PIXEL); if (f) { doScale(mode.base, f); return "ok"; } }
    if (mode.step === "ref1" || mode.step === "new") return "bad";
  }
  if (mode.k === "corner") {
    const r = typedLen(v, isInch());
    if (!(r > 0)) return "bad";
    options.cornerSize = r;
    saveOptions();
    const f = document.getElementById("opt-corner-size") as HTMLInputElement | null;
    if (f) f.value = String(r);
    say("");
    return "ok";
  }
  if (mode.k === "circle" && mode.c) {
    const d = /^[dø⌀]\s*(.+)$/i.exec(v);
    const r = d ? typedLen(d[1], isInch()) / 2 : typedLen(v, isInch());
    if (Number.isFinite(r) && !/[,;<@]/.test(v)) { if (r <= 0) return "bad"; makeCircle(mode.c, r * MM_TO_PIXEL); return "ok"; }
  }
  if (mode.k === "rotate" && mode.base) {
    const a = typedAngle(v);
    if (Number.isFinite(a)) { doRotate(mode.base, a); return "ok"; }
  }
  const base = mode.k === "circle" ? mode.c : mode.k === "none" || mode.k === "draw" ? undefined : mode.base;
  const p = readPoint(v, base ?? lastPt);
  if (!p) return "bad";
  modePoint(p);
  return "ok";
}

/** Punkt (getippt oder geklickt) in Kreis/Verschieben/Kopieren/Drehen */
function modePoint(p: Pt) {
  lastPt = p;
  switch (mode.k) {
    case "circle":
      if (!mode.c) { mode.c = p; pick.from = p; return; }
      makeCircle(mode.c, Math.hypot(p.x - mode.c.x, p.y - mode.c.y));
      return;
    case "move": case "copy":
      if (!mode.base) { mode.base = p; pick.from = p; return; }
      doMove(mode.k === "copy", p.x - mode.base.x, p.y - mode.base.y);
      return;
    case "rotate":
      if (!mode.base) { mode.base = p; pick.from = p; return; }
      doRotate(mode.base, (Math.atan2(p.y - mode.base.y, p.x - mode.base.x) * 180) / Math.PI);
      return;
    case "stretch": {
      const m = mode;
      if (!m.c1) {
        m.c1 = p;
        // Rechteck als Vorschau, bis die zweite Ecke gesetzt ist
        pick.move = q => { const a = m.c1!; pick.lines = [[a, { x: q.x, y: a.y }, q, { x: a.x, y: q.y }, a]]; };
        return;
      }
      if (!m.c2) { m.c2 = p; pick.move = null; return; }
      if (!m.base) { m.base = p; pick.from = p; return; }
      doStretch({ x0: m.c1.x, y0: m.c1.y, x1: m.c2.x, y1: m.c2.y }, p.x - m.base.x, p.y - m.base.y);
      return;
    }
    case "scale": {
      const m = mode;
      if (!m.base) { m.base = p; pick.from = p; return; }
      if (m.step === "ref1") { m.refA = p; m.step = "ref2"; pick.from = p; return; }
      if (m.step === "ref2" && m.refA) { m.refLen = Math.hypot(p.x - m.refA.x, p.y - m.refA.y); m.step = "new"; pick.from = m.base; return; }
      if (m.step === "new" && m.refLen) { const f = refFactor(m.refLen, Math.hypot(p.x - m.base.x, p.y - m.base.y)); if (f) doScale(m.base, f); return; }
      say(t("cl.scaleFactor"));
      return;
    }
    default:
      placePoint(p);
  }
}

function makeCircle(c: Pt, rPx: number) {
  if (!(rPx > 0)) { say(t("cl.badPoint", { w: "0" })); return; }
  addShapes([createCircle(c.x, c.y, rPx)]);
  say(t("cl.circleDone", { d: fmtLenU((rPx * 2) / MM_TO_PIXEL) }));
  endCommand();
}

function doMove(copy: boolean, dx: number, dy: number) {
  const sel = selectedShapes();
  if (!sel.length) { say(t("cl.selectFirst")); endCommand(); return; }
  if (copy) {
    const copies = makeCopies(sel, 0);
    copies.forEach(c => translateShape(c, dx, dy));
    addShapes(copies);
    // Kopieren bleibt aktiv: weitere Zielpunkte vom selben Basispunkt (wie in CAD), Enter beendet
    app().selectedShapeIds = sel.map((s: any) => s.id);
    say(t("cl.copied", { x: fmtLenU(dx / MM_TO_PIXEL), y: fmtLenU(dy / MM_TO_PIXEL) }));
    return;
  }
  sel.forEach(s => translateShape(s, dx, dy));
  say(t("cl.moved", { x: fmtLenU(dx / MM_TO_PIXEL), y: fmtLenU(dy / MM_TO_PIXEL) }));
  endCommand();
}

function doScale(c: Pt, f: number) {
  const sel = selectedShapes();
  if (!sel.length) { say(t("cl.selectFirst")); endCommand(); return; }
  sel.forEach(s => scaleShape(s, c.x, c.y, f, f));
  say(t("cl.scaled", { f: +f.toFixed(6) }));
  endCommand();
}

/** Strecken: alle Punkte im Rechteck wandern um (dx, dy); Kreise, Texte, Bilder nur ganz, wenn ihre Mitte drin liegt */
function doStretch(box: Box, dx: number, dy: number) {
  let n = 0;
  for (const s of app().shapes as any[]) {
    if (s.type === "rect") { const c = makeRectPoints(s.x, s.y, s.x + s.w, s.y + s.h); if (c.some(p => inBox(p, box))) convertToPolyline(s); else continue; }
    if (s.type === "polyline" && s.bez?.length) {
      // Kurven: Knoten (mit ihren Griffen) verschieben, dann neu glätten
      let hit = false;
      for (const k of s.bez) if (inBox(k, box)) { hit = true; k.x += dx; k.y += dy; if (k.hi) k.hi = { x: k.hi.x + dx, y: k.hi.y + dy }; if (k.ho) k.ho = { x: k.ho.x + dx, y: k.ho.y + dy }; }
      if (hit) { syncPoints(s); delete s.tabPts; n++; }
      continue;
    }
    if (s.type === "polyline") {
      const r = stretchPoints(s.points, box, dx, dy);
      if (r) { s.points = r; delete s.tabPts; updatePolylineBounds(s); n++; }
      continue;
    }
    if (s.type === "line" || s.type === "arc") {
      const a = { x: s.x, y: s.y }, b = { x: s.x + s.w, y: s.y + s.h }, inA = inBox(a, box), inB = inBox(b, box);
      const inM = s.type === "arc" && inBox({ x: s.midX, y: s.midY }, box);
      if (!inA && !inB && !inM) continue;
      if (inA) { s.x += dx; s.y += dy; s.w -= dx; s.h -= dy; }
      if (inB) { s.w += dx; s.h += dy; }
      if (inM) { s.midX += dx; s.midY += dy; }
      n++;
      continue;
    }
    const b = shapeBounds(s);
    if (b && inBox({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, box)) { translateShape(s, dx, dy); n++; }
  }
  app().shapes = [...app().shapes];
  say(t("cl.stretched", { n }));
  endCommand();
}

function doRotate(c: Pt, deg: number) {
  const sel = selectedShapes();
  if (!sel.length) { say(t("cl.selectFirst")); endCommand(); return; }
  sel.forEach(s => rotateShape(s, c.x, c.y, (deg * Math.PI) / 180));
  say(t("cl.rotated", { a: +deg.toFixed(3) }));
  endCommand();
}
