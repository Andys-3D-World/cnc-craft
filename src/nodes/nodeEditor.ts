/**
 * KNOTEN-EDITOR: Abläufe zusammenstecken statt Schritt für Schritt klicken
 *
 *  links:  Liste der Knoten (anklicken oder aufs Feld ziehen)
 *  Mitte:  Feld mit Knoten und Leitungen – Ausgang (rechts am Knoten) auf Eingang (links) ziehen.
 *          Leeres Feld ziehen / rechte Maustaste = verschieben, Rad = Zoom, Entf = Knoten löschen,
 *          Leitung anklicken = entfernen, Eingang wegziehen = Leitung lösen
 *  rechts: Einstellungen des gewählten Knotens + große Vorschau
 *  „Aufs Bett“ legt das Ergebnis aller Ausgabe-Knoten auf das Bett (ersetzt das vorige Ergebnis).
 *
 * Der Graph wird beim Arbeiten gemerkt (localStorage); im Projekt gespeichert wird er später.
 */
import { t } from "../i18n/i18n";
import {
  Graph, GraphNode, NodeDef, NodeResult, ParamDef, PortType, allNodeDefs, connect, createNode, evaluate, nodeDef,
  nodeInputs, removeNode
} from "./graph";
import { registerAllNodes, NODE_CATS, fresh } from "./nodeDefs";
import { currentGraph, rememberGraph } from "./graphStore";
import { openRecipePanel, closeRecipePanel } from "./recipePanel";
import { app } from "../editor/editorState";
import { selectedShapes } from "../editor/selection";
import { checkpoint } from "../editor/history";
import { activeBed, addBed, bedCount, bedShapes, moveToBed } from "../editor/beds";
import { MM_TO_PIXEL, groupBounds, shapeToPaths, translateShape } from "../shapeTransform";
import { drawImageShape, imageSizeMm } from "../raster/imageShape";
import { layerForShape } from "../laserLayers";
import { updateDimensionInputs } from "../uiInputs";

const PORT_COLOR: Record<PortType, string> = { shapes: "#4dabf7", image: "#f59f00", number: "#69db7c" };
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Meldungen aus dem Protokoll ohne „[Bereich] “ davor */
const plain = (s: string) => s.replace(/^\[[^\]]*\]\s*/, "");

const cache = new Map<string, NodeResult>();

export function openNodeEditor(log: (s: string) => void) {
  registerAllNodes();
  const g = currentGraph();
  document.getElementById("ng-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "ng-overlay";
  ov.className = "dlg-overlay";
  const defsByCat = (c: NodeDef["cat"]) => allNodeDefs().filter(d => d.cat === c);
  ov.innerHTML = `
    <div class="dlg-box ng-box" role="dialog" aria-label="${t("ng.title")}">
      <div class="ng-top">
        <h3>🔗 ${t("ng.title")}</h3>
        <span class="dlg-hint ng-help">${t("ng.hint")}</span>
        <button id="ng-fit" class="btn-secondary" title="${t("ng.fit")}">⤢</button>
        <button id="ng-tpl-btn" class="btn-secondary">📚 ${t("ng.tpl.title")}</button>
        <button id="ng-clear" class="btn-secondary">${t("ng.clear")}</button>
        <button id="ng-apply" class="btn-primary" title="${t("ng.applyTip")}">▶ ${t("ng.apply")}</button>
        <button id="ng-close" class="btn-secondary">${t("dlg.close")}</button>
      </div>
      <div class="ng-main">
        <div class="ng-pal">
          ${NODE_CATS.map(c => `<div class="ng-cat">${t("ng.cat." + c)}</div>
            ${defsByCat(c).map(d => `<button class="ng-add" draggable="true" data-type="${d.type}" title="${t("ng.d." + d.type)}"><span>${d.icon}</span>${t("ng.n." + d.type)}</button>`).join("")}`).join("")}
        </div>
        <div class="ng-view" tabindex="0">
          <div class="ng-world">
            <svg class="ng-wires" width="1" height="1"></svg>
            <div class="ng-nodes"></div>
          </div>
        </div>
        <div class="ng-side"></div>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = <E extends HTMLElement = HTMLElement>(sel: string) => ov.querySelector(sel) as E;
  const view = q(".ng-view"), world = q(".ng-world"), nodesEl = q(".ng-nodes"), side = q(".ng-side");
  const svg = ov.querySelector(".ng-wires") as SVGSVGElement;
  const cam = { x: 0, y: 0, z: 1 };
  let selected: string | null = g.nodes[0]?.id || null;
  let results = new Map<string, NodeResult>();
  let evalId = 0, evalTimer = 0;

  // -------------------------------------------------------------------
  // Darstellung
  // -------------------------------------------------------------------

  const applyCam = () => { world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; };

  const portLabel = (d: NodeDef, name: string) => d.inputs.some(p => p.name === name) || d.outputs.some(p => p.name === name)
    ? t("ng.port." + name) : t("ng.p." + name);

  function nodeHtml(n: GraphNode): string {
    const d = nodeDef(n.type)!;
    const ins = nodeInputs(d).map(p => `<div class="ng-pin in" data-node="${n.id}" data-port="${p.name}" data-type="${p.type}">
        <i style="--pc:${PORT_COLOR[p.type]}"></i><span>${portLabel(d, p.name)}</span></div>`).join("");
    const outs = d.outputs.map(p => `<div class="ng-pin out" data-node="${n.id}" data-port="${p.name}" data-type="${p.type}">
        <span>${portLabel(d, p.name)}</span><i style="--pc:${PORT_COLOR[p.type]}"></i></div>`).join("");
    return `<div class="ng-node${n.id === selected ? " sel" : ""} ng-c-${d.cat}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;">
      <div class="ng-head"><span>${d.icon} ${t("ng.n." + n.type)}</span><button class="ng-del" title="${t("ng.del")}" aria-label="${t("ng.del")}">✕</button></div>
      <div class="ng-ports"><div>${ins}</div><div class="ng-outs">${outs}</div></div>
      <canvas class="ng-thumb" width="180" height="96"></canvas>
      <div class="ng-stat"></div>
    </div>`;
  }

  function renderNodes() {
    nodesEl.innerHTML = g.nodes.map(nodeHtml).join("");
    refreshResults();
    renderWires();
  }

  /** Mitte eines Anschlusses in Feld-Koordinaten */
  function pinPos(nodeId: string, port: string, dir: "in" | "out"): { x: number; y: number } | null {
    const el = nodesEl.querySelector(`.ng-pin.${dir}[data-node="${nodeId}"][data-port="${port}"] i`);
    if (!el) return null;
    const r = el.getBoundingClientRect(), v = view.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - v.left - cam.x) / cam.z, y: (r.top + r.height / 2 - v.top - cam.y) / cam.z };
  }

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };

  let temp: { from: { x: number; y: number }; to: { x: number; y: number }; type: PortType } | null = null;
  function renderWires() {
    const parts: string[] = [];
    g.links.forEach((l, i) => {
      const a = pinPos(l.from, l.out, "out"), b = pinPos(l.to, l.inp, "in");
      if (!a || !b) return;
      const ty = nodeDef(g.nodes.find(n => n.id === l.from)!.type)!.outputs.find(p => p.name === l.out)!.type;
      parts.push(`<path class="ng-wire-hit" data-link="${i}" d="${curve(a, b)}"/><path class="ng-wire" d="${curve(a, b)}" stroke="${PORT_COLOR[ty]}"/>`);
    });
    if (temp) parts.push(`<path class="ng-wire temp" d="${curve(temp.from, temp.to)}" stroke="${PORT_COLOR[temp.type]}"/>`);
    svg.innerHTML = parts.join("");
  }

  // -------------------------------------------------------------------
  // Vorschau
  // -------------------------------------------------------------------

  function drawPreview(cv: HTMLCanvasElement, shapes: any[], image: any, value: any) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (typeof value === "number") {
      ctx.fillStyle = "#69db7c"; ctx.font = "600 22px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(+value.toFixed(3)), W / 2, H / 2);
      return;
    }
    const all = [...(image ? [image] : []), ...shapes];
    const b = groupBounds(all);
    if (!b) return;
    const pad = 6, bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    const ox = (W - bw * k) / 2, oy = (H - bh * k) / 2;
    const sx = (x: number) => ox + (x - b.minX) * k, sy = (y: number) => H - oy - (y - b.minY) * k;
    if (image) drawImageShape(ctx, image, sx, sy);
    ctx.lineWidth = 1;
    for (const s of shapes) {
      ctx.strokeStyle = layerForShape(s)?.color || "#4dabf7";
      ctx.beginPath();
      for (const p of shapeToPaths(s)) {
        p.pts.forEach((q, i) => (i ? ctx.lineTo(sx(q.x), sy(q.y)) : ctx.moveTo(sx(q.x), sy(q.y))));
        if (p.closed) ctx.closePath();
      }
      ctx.stroke();
    }
  }

  /** Was zeigt die Vorschau eines Knotens? Ausgabe: das, was ankommt */
  function shown(n: GraphNode): { shapes: any[]; image: any; value: any } {
    const r = results.get(n.id);
    const o = r?.out || {};
    const shapes: any[] = Object.values(o).filter(Array.isArray).flat();
    const image = Object.values(o).find((v: any) => v && v.type === "image") || null;
    const value = Object.values(o).find(v => typeof v === "number");
    return { shapes, image, value };
  }

  function statusText(n: GraphNode): { text: string; cls: string } {
    const r = results.get(n.id);
    if (!r) return { text: "…", cls: "" };
    if (r.error) return { text: "⚠ " + t("ng.error", { e: r.error }), cls: "err" };
    if (r.warn) return { text: "⚠ " + plain(t(r.warn.key, r.warn.vars)), cls: "warn" };
    const s = shown(n);
    const bits: string[] = [];
    if (s.image) { const m = imageSizeMm(s.image); bits.push(t("ng.imgInfo", { w: m.w.toFixed(0), h: m.h.toFixed(0) })); }
    if (s.shapes.length || (!s.image && s.value === undefined)) {
      const b = groupBounds(s.shapes);
      bits.push(t("ng.count", { n: s.shapes.length }) + (b ? ` · ${((b.maxX - b.minX) / MM_TO_PIXEL).toFixed(0)}×${((b.maxY - b.minY) / MM_TO_PIXEL).toFixed(0)} mm` : ""));
    }
    if (r.ms > 50) bits.push(`${Math.round(r.ms)} ms`);
    return { text: bits.join(" · "), cls: "" };
  }

  function refreshResults() {
    for (const n of g.nodes) {
      const el = nodesEl.querySelector<HTMLElement>(`.ng-node[data-id="${n.id}"]`);
      if (!el) continue;
      const s = shown(n);
      drawPreview(el.querySelector("canvas")!, s.shapes, s.image, s.value);
      const st = statusText(n);
      const se = el.querySelector<HTMLElement>(".ng-stat")!;
      se.textContent = st.text;
      se.className = "ng-stat " + st.cls;
    }
    const big = side.querySelector<HTMLCanvasElement>(".ng-big");
    const sn = g.nodes.find(n => n.id === selected);
    if (big && sn) { const s = shown(sn); drawPreview(big, s.shapes, s.image, s.value); }
  }

  // -------------------------------------------------------------------
  // Einstellungen (rechts)
  // -------------------------------------------------------------------

  const linked = (n: GraphNode, key: string) => g.links.some(l => l.to === n.id && l.inp === key);

  function paramHtml(n: GraphNode, p: ParamDef): string {
    const label = `<span>${t("ng.p." + p.key)}</span>`;
    const v = n.params[p.key];
    if (p.kind === "button") {
      const cnt = Array.isArray(n.params.shapes) ? n.params.shapes.length : 0;
      return `<button class="btn-secondary ng-take" data-key="${p.key}">📥 ${t("ng.take")}</button>
        <div class="dlg-hint">${cnt ? t("ng.taken", { n: cnt }) : t("ng.takeNone")}</div>`;
    }
    if (p.kind === "check") return `<label class="eng-ck"><input type="checkbox" data-key="${p.key}" ${v ? "checked" : ""}> ${t("ng.p." + p.key)}</label>`;
    if (p.kind === "select") {
      const opts = typeof p.options === "function" ? p.options() : (p.options || []).map(o => ({ value: o, label: t(`ng.p.${p.key}.${o}`) }));
      return `<label class="ng-row">${label}<select class="prop-input" data-key="${p.key}">
        ${opts.map(o => `<option value="${esc(o.value)}" ${o.value === v ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`;
    }
    if (p.kind === "number") {
      if (p.port && linked(n, p.key)) return `<label class="ng-row">${label}<span class="dlg-hint">← ${t("ng.linked")}</span></label>`;
      return `<label class="ng-row">${label}<input type="number" class="prop-input" data-key="${p.key}" value="${esc(String(v))}"
        ${p.min !== undefined ? `min="${p.min}"` : ""} ${p.max !== undefined ? `max="${p.max}"` : ""} step="${p.step ?? "any"}"></label>`;
    }
    return "";
  }

  function renderSide() {
    const n = g.nodes.find(x => x.id === selected);
    if (!n) { side.innerHTML = `<div class="dlg-hint">${t("ng.noSel")}</div>`; return; }
    const d = nodeDef(n.type)!;
    const ps = d.params.filter(p => p.kind !== "data" && (!p.when || p.when(n.params)));
    side.innerHTML = `
      <div class="ng-side-title">${d.icon} ${t("ng.n." + n.type)}</div>
      <div class="dlg-hint">${t("ng.d." + n.type)}</div>
      ${ps.map(p => paramHtml(n, p)).join("")}
      <canvas class="ng-big"></canvas>`;
    side.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach(el => {
      if (el instanceof HTMLButtonElement) return;
      el.addEventListener(el instanceof HTMLInputElement && el.type === "number" ? "input" : "change", () => {
        const p = d.params.find(x => x.key === el.dataset.key)!;
        if (p.kind === "number") {
          const v = parseFloat(el.value);
          if (!Number.isFinite(v)) return;
          n.params[p.key] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
        } else if (p.kind === "check") n.params[p.key] = (el as HTMLInputElement).checked;
        else n.params[p.key] = el.value;
        // Einstellungen, die andere ein-/ausblenden (z. B. Verfahren → Zellgröße)
        if (p.kind === "select" && d.params.some(x => x.when)) renderSide();
        changed();
      });
    });
    side.querySelector<HTMLButtonElement>(".ng-take")?.addEventListener("click", () => {
      const sel = selectedShapes().filter((s: any) => !s.ngOut);
      if (!sel.length) { log(t("ng.takeNone")); return; }
      n.params.shapes = fresh(sel).map((c, i) => ({ ...c, id: sel[i].id }));
      renderSide();
      changed();
    });
    refreshResults();
  }

  // -------------------------------------------------------------------
  // Rechnen
  // -------------------------------------------------------------------

  function changed(structure = false) {
    rememberGraph();
    if (structure) renderNodes();
    clearTimeout(evalTimer);
    evalTimer = window.setTimeout(async () => {
      const id = ++evalId;
      const r = await evaluate(g, cache);
      if (id !== evalId || !ov.isConnected) return;
      results = r;
      refreshResults();
    }, 60);
  }

  // -------------------------------------------------------------------
  // Aufs Bett
  // -------------------------------------------------------------------

  async function apply() {
    const outs = g.nodes.filter(n => n.type === "output");
    if (!outs.length) { log(t("ng.noOutput")); return; }
    clearTimeout(evalTimer);
    results = await evaluate(g, cache);
    refreshResults();
    const st = app();
    let placed = 0;
    for (const o of outs) {
      const r = results.get(o.id);
      if (!r || r.error) continue;
      // vorheriges Ergebnis dieses Ausgabe-Knotens auf allen Betten entfernen
      for (let i = 0; i < bedCount(); i++) {
        if (i === activeBed()) st.shapes = st.shapes.filter((s: any) => s.ngOut !== o.id);
        else { const list = bedShapes(i); for (let k = list.length - 1; k >= 0; k--) if (list[k].ngOut === o.id) list.splice(k, 1); }
      }
      // Quellen „live“: Kopie auf den jetzigen Stand bringen (danach dürfen die Originale weg)
      const onBed = new Map<string, any>(st.shapes.map((s: any) => [s.id, s]));
      for (const n of g.nodes) if (n.type === "source" && n.params.live && Array.isArray(n.params.shapes)) {
        n.params.shapes = n.params.shapes.map((s: any) => onBed.has(s.id) ? { ...fresh([onBed.get(s.id)])[0], id: s.id } : s);
      }
      if (o.params.removeSrc) {
        const ids = new Set(g.nodes.filter(n => n.type === "source").flatMap(n => (n.params.shapes || []).map((s: any) => s.id)));
        st.shapes = st.shapes.filter((s: any) => !ids.has(s.id));
      }
      const add = fresh([...(r.out.image ? [r.out.image] : []), ...(r.out.shapes || [])]);
      add.forEach(s => { s.ngOut = o.id; });
      const byBed = new Map<number, any[]>();
      for (const s of add) {
        const k = s.ngBed | 0;
        if (Array.isArray(s.ngShift)) translateShape(s, -s.ngShift[0], -s.ngShift[1]);
        delete s.ngBed; delete s.ngShift;
        if (!byBed.has(k)) byBed.set(k, []);
        byBed.get(k)!.push(s);
      }
      st.shapes = [...st.shapes, ...add];
      const here = activeBed();
      for (const [k, list] of byBed) {
        if (!k) continue;
        const target = here + k < bedCount() ? here + k : addBed();
        moveToBed(list.map(s => s.id), target);
      }
      placed += add.length;
    }
    st.selectedShapeIds = st.shapes.filter((s: any) => s.ngOut && outs.some(o => o.id === s.ngOut)).map((s: any) => s.id);
    log(placed ? t("ng.applied", { n: placed }) : t("ng.nothing"));
    updateDimensionInputs(null);
    window.dispatchEvent(new Event("cnc-redraw"));
    checkpoint();
  }

  // -------------------------------------------------------------------
  // Maus
  // -------------------------------------------------------------------

  const toWorld = (cx: number, cy: number) => {
    const v = view.getBoundingClientRect();
    return { x: (cx - v.left - cam.x) / cam.z, y: (cy - v.top - cam.y) / cam.z };
  };

  function addNode(type: string, x?: number, y?: number) {
    let px = x, py = y;
    if (px === undefined || py === undefined) {
      const v = view.getBoundingClientRect();
      const c = toWorld(v.left + v.width / 2, v.top + v.height / 3);
      px = c.x - 90 + (g.nodes.length % 5) * 14; py = c.y + (g.nodes.length % 5) * 14;
    }
    const n = createNode(type, Math.round(px), Math.round(py));
    if (!n) return;
    g.nodes.push(n);
    selected = n.id;
    changed(true);
    renderSide();
  }

  function deleteNode(id: string) {
    removeNode(g, id);
    if (selected === id) selected = null;
    changed(true);
    renderSide();
  }

  function select(id: string | null) {
    if (selected === id) return;
    selected = id;
    nodesEl.querySelectorAll(".ng-node").forEach(el => el.classList.toggle("sel", (el as HTMLElement).dataset.id === id));
    renderSide();
  }

  ov.querySelectorAll<HTMLButtonElement>(".ng-add").forEach(b => {
    b.addEventListener("click", () => addNode(b.dataset.type!));
    b.addEventListener("dragstart", e => e.dataTransfer?.setData("text/x-ng-node", b.dataset.type!));
  });
  view.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("text/x-ng-node")) e.preventDefault(); });
  view.addEventListener("drop", e => {
    const type = e.dataTransfer?.getData("text/x-ng-node");
    if (!type) return;
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    addNode(type, p.x - 90, p.y - 14);
  });

  type Drag =
    | { kind: "pan"; sx: number; sy: number; cx: number; cy: number }
    | { kind: "node"; node: GraphNode; dx: number; dy: number; el: HTMLElement }
    | { kind: "wire"; node: string; port: string; dir: "in" | "out"; type: PortType };
  let drag: Drag | null = null;

  view.addEventListener("mousedown", e => {
    const tgt = e.target as HTMLElement;
    view.focus({ preventScroll: true });
    if (tgt.closest(".ng-del")) return;
    const pin = tgt.closest<HTMLElement>(".ng-pin");
    if (pin && e.button === 0) {
      e.preventDefault();
      let node = pin.dataset.node!, port = pin.dataset.port!, dir: "in" | "out" = pin.classList.contains("in") ? "in" : "out";
      const type = pin.dataset.type as PortType;
      if (dir === "in") {
        // Eingang mit Leitung: Leitung lösen und am anderen Ende weiterziehen
        const l = g.links.find(x => x.to === node && x.inp === port);
        if (l) {
          g.links = g.links.filter(x => x !== l);
          node = l.from; port = l.out; dir = "out";
          changed();
          if (selected) renderSide();
        }
      }
      drag = { kind: "wire", node, port, dir, type };
      const a = pinPos(node, port, dir)!;
      temp = dir === "out" ? { from: a, to: toWorld(e.clientX, e.clientY), type } : { from: toWorld(e.clientX, e.clientY), to: a, type };
      renderWires();
      return;
    }
    const nodeEl = tgt.closest<HTMLElement>(".ng-node");
    if (nodeEl && e.button === 0) {
      const n = g.nodes.find(x => x.id === nodeEl.dataset.id)!;
      select(n.id);
      if (tgt.closest(".ng-head")) {
        e.preventDefault();
        const p = toWorld(e.clientX, e.clientY);
        drag = { kind: "node", node: n, dx: p.x - n.x, dy: p.y - n.y, el: nodeEl };
      }
      return;
    }
    const wire = tgt.closest<SVGPathElement>(".ng-wire-hit");
    if (wire && e.button === 0) {
      g.links.splice(+wire.dataset.link!, 1);
      changed();
      renderWires();
      renderSide();
      return;
    }
    e.preventDefault();
    if (e.button === 0 && !nodeEl) select(null);
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
    view.style.cursor = "grabbing";
  });
  view.addEventListener("contextmenu", e => e.preventDefault());

  const onMove = (e: MouseEvent) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      cam.x = drag.cx + e.clientX - drag.sx; cam.y = drag.cy + e.clientY - drag.sy;
      applyCam();
    } else if (drag.kind === "node") {
      const p = toWorld(e.clientX, e.clientY);
      drag.node.x = Math.round(p.x - drag.dx); drag.node.y = Math.round(p.y - drag.dy);
      drag.el.style.left = drag.node.x + "px"; drag.el.style.top = drag.node.y + "px";
      renderWires();
    } else if (temp) {
      const p = toWorld(e.clientX, e.clientY);
      if (drag.dir === "out") temp.to = p; else temp.from = p;
      renderWires();
    }
  };
  const onUp = (e: MouseEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    view.style.cursor = "";
    if (d.kind === "node") { rememberGraph(); return; }
    if (d.kind === "wire") {
      temp = null;
      const pin = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".ng-pin");
      if (pin && ov.contains(pin)) {
        const dir2 = pin.classList.contains("in") ? "in" : "out";
        const ok = d.dir === "out" && dir2 === "in" ? connect(g, d.node, d.port, pin.dataset.node!, pin.dataset.port!)
          : d.dir === "in" && dir2 === "out" ? connect(g, pin.dataset.node!, pin.dataset.port!, d.node, d.port) : false;
        if (ok) { changed(); renderSide(); }
      }
      renderWires();
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  view.addEventListener("wheel", e => {
    e.preventDefault();
    const v = view.getBoundingClientRect();
    const mx = e.clientX - v.left, my = e.clientY - v.top;
    const z = Math.min(2.5, Math.max(0.25, cam.z * Math.exp(-e.deltaY * 0.0015)));
    cam.x = mx - (mx - cam.x) * (z / cam.z); cam.y = my - (my - cam.y) * (z / cam.z);
    cam.z = z;
    applyCam();
  }, { passive: false });

  nodesEl.addEventListener("click", e => {
    const del = (e.target as HTMLElement).closest(".ng-del");
    if (del) deleteNode((del.closest(".ng-node") as HTMLElement).dataset.id!);
  });

  function fit() {
    if (!g.nodes.length) { cam.x = 20; cam.y = 20; cam.z = 1; applyCam(); return; }
    const els = [...nodesEl.querySelectorAll<HTMLElement>(".ng-node")];
    const x0 = Math.min(...g.nodes.map(n => n.x)), y0 = Math.min(...g.nodes.map(n => n.y));
    const x1 = Math.max(...g.nodes.map((n, i) => n.x + (els[i]?.offsetWidth || 200)));
    const y1 = Math.max(...g.nodes.map((n, i) => n.y + (els[i]?.offsetHeight || 200)));
    const v = view.getBoundingClientRect();
    cam.z = Math.min(1.2, Math.max(0.25, Math.min((v.width - 40) / (x1 - x0), (v.height - 40) / (y1 - y0))));
    cam.x = (v.width - (x1 - x0) * cam.z) / 2 - x0 * cam.z;
    cam.y = (v.height - (y1 - y0) * cam.z) / 2 - y0 * cam.z;
    applyCam();
  }

  // -------------------------------------------------------------------
  // Knöpfe, Tasten, Schließen
  // -------------------------------------------------------------------

  q("#ng-apply").onclick = () => { apply(); };
  q("#ng-fit").onclick = fit;
  q("#ng-clear").onclick = () => {
    if (!window.confirm(t("ng.clearConfirm"))) return;
    g.nodes = []; g.links = [];
    selected = null;
    changed(true);
    renderSide();
  };
  // Bilder laden nach; Quellen „live“ rechnen neu, wenn sich auf dem Bett etwas ändert
  const redraw = () => { if (g.nodes.some(n => n.type === "source" && n.params.live)) changed(); else refreshResults(); };
  q("#ng-tpl-btn").onclick = () => openRecipePanel(q(".ng-box"), () => g, (ng: Graph, name: string) => {
    const empty = g.nodes.length <= 2 && !g.nodes.some(n => (n.params.shapes || []).length);
    if (!empty && !window.confirm(t("ng.tpl.confirmLoad", { name }))) return;
    // übernommene Formen der jetzigen Quellen bleiben erhalten (Vorlage auf das gleiche Motiv anwenden)
    const taken = g.nodes.find(n => n.type === "source" && (n.params.shapes || []).length)?.params.shapes;
    g.nodes = ng.nodes; g.links = ng.links;
    if (taken) for (const n of g.nodes) if (n.type === "source" && !(n.params.shapes || []).length) n.params.shapes = taken;
    selected = g.nodes.find(n => n.type === "source")?.id || g.nodes[0]?.id || null;
    changed(true);
    renderSide();
    requestAnimationFrame(() => { fit(); renderWires(); });
    log(t("ng.tpl.loaded", { name }));
  }, log);
  window.addEventListener("cnc-redraw", redraw);
  const close = () => {
    clearTimeout(evalTimer);
    evalId++;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("cnc-redraw", redraw);
    rememberGraph();
    closeRecipePanel();
    ov.remove();
  };
  q("#ng-close").onclick = close;
  ov.addEventListener("keydown", e => {
    e.stopPropagation();
    const inField = (e.target as HTMLElement).closest("input, select, textarea");
    if (e.key === "Escape") { if (!closeRecipePanel()) close(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && !inField && selected) { e.preventDefault(); deleteNode(selected); }
  });

  applyCam();
  renderNodes();
  renderSide();
  requestAnimationFrame(() => { fit(); renderWires(); });
  changed();
}
