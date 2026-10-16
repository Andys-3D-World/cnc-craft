/**
 * ANSCHLUSSPLAN (Reiter „Anschlüsse“)
 *
 * Board wählen (CNC Shield V3, MKS DLC32 V2.1, MKS DLC32 MAX), dann ein Bauteil
 * (Netzteil, Motoren, Endschalter, Taster/WLS, Laser, Spindel, Plasma, Luft, Not-Aus, Tür):
 *   - Zeichnung: Board mit Steckern + Bauteile mit farbigen Drähten an die richtigen Pins
 *   - Einsteiger: Schritt-für-Schritt-Anleitung, Warnungen, was danach einzustellen ist
 *   - Profi: Pin-Tabelle (Beschriftung, Controller-Pin, Funktion) + technische Hinweise
 *   - Übersicht: alle Stecker farbig nach Bauteil, Klick wählt das Bauteil
 * Die Zeichnung zoomt automatisch auf Board + Bauteile.
 * Daten: src/wiring/boards.ts
 */
import { t } from "../i18n/i18n";
import { BOARDS, COMPS, CompId, Board, BConn, Part, Hookup, getBoard } from "../wiring/boards";

const KEY_BOARD = "cnc_craft_wiring_board";
const KEY_LEVEL = "cnc_craft_wiring_level";
const KEY_COMP = "cnc_craft_wiring_comp";

const BX = 260, BY = 170;   // linke obere Ecke der Board-Fläche in der Zeichnung (Größe: board.w × board.h)
const GAP = 86;             // Abstand Bauteile <-> Board
const PIN = 13;

const COMP_COLOR: Record<CompId, string> = {
  psu: "#e5484d", motors: "#3e7bfa", limits: "#f5c518", probe: "#f08c00", laser: "#ff5db1",
  spindle: "#9b5de5", plasma: "#00b4d8", air: "#30a46c", estop: "#ff3b3b", door: "#a3a3a3"
};
const COMP_ICON: Record<CompId, string> = {
  psu: "🔌", motors: "⚙️", limits: "🛑", probe: "📍", laser: "🔦", spindle: "🌀", plasma: "⚡", air: "💨", estop: "🚨", door: "🚪"
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
function get(k: string, d: string): string { try { return localStorage.getItem(k) || d; } catch { return d; } }
function put(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* egal */ } }
const n = (v: number) => Math.round(v * 10) / 10;

/** Funktions-Texte der Pins (in boards.ts deutsch) -> übersetzt */
const FN_KEYS: Record<string, string> = {
  "Spindel-Richtung": "wr.fn.spdir", "Spindel/Laser PWM (GRBL 1.1)": "wr.fn.pwm11", "Taster": "wr.fn.probe", "Taster (Probe)": "wr.fn.probe",
  "Tür": "wr.fn.door", "Flammen-Sensor": "wr.fn.flame", "Kühlung M8": "wr.fn.cool", "Spindel (MOSFET)": "wr.fn.spmos",
  "Reset/Abbruch": "wr.fn.abort", "Nebel M7 (Option)": "wr.fn.mist", "Arduino-Reset": "wr.fn.ardreset", "Z-Limit (GRBL 1.1)": "wr.fn.zlim11"
};
function fnText(fn: string): string { const k = FN_KEYS[fn]; return k ? t(k) : fn; }

/** Board aus dem, was das Programm schon weiß (zuletzt verbundenes Board / Flash-Seite) */
function guessBoard(): string {
  try {
    const raw = localStorage.getItem("cnc_craft_board_info");
    const name = raw ? String(JSON.parse(raw).name || "") : "";
    if (/DLC32\s*MAX/i.test(name)) return "mks-dlc32-max";
    if (/DLC32/i.test(name)) return "mks-dlc32-v21";
    const fl = localStorage.getItem("cnc_craft_flash_board") || "";
    if (fl === "mks-dlc32-max") return "mks-dlc32-max";
    if (fl === "mks-dlc32") return "mks-dlc32-v21";
  } catch { /* egal */ }
  return "cnc-shield-v3";
}

// ---------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------

function pinPos(c: BConn, i: number): { x: number; y: number } {
  return c.dir === "h" ? { x: BX + c.x + i * PIN, y: BY + c.y } : { x: BX + c.x, y: BY + c.y + i * PIN };
}
function boardPin(b: Board, ref: string): { x: number; y: number; c: BConn; i: number } | null {
  const [cid, pk] = ref.split(".");
  const c = b.conns.find(x => x.id === cid);
  if (!c) return null;
  const i = c.pins.findIndex(p => p.k === pk);
  if (i < 0) return null;
  return { ...pinPos(c, i), c, i };
}

interface Placed { part: Part; x: number; y: number; w: number; h: number; pins: Record<string, { x: number; y: number }> }
interface Box { x0: number; y0: number; x1: number; y1: number }

/** Zusatz-Pins auf der Außenseite (Relais-Kontakte) */
function outerPins(p: Part): string[] {
  if (p.kind === "relay") return ["COM", "NO"];
  return [];
}

function placeParts(b: Board, parts: Part[]): Placed[] {
  const SVG_W = BX + b.w + GAP + 174, SVG_H = BY + b.h + GAP + 76;
  const bySide: Record<string, Part[]> = { left: [], right: [], top: [], bottom: [] };
  parts.forEach(p => bySide[p.side].push(p));
  const out: Placed[] = [];
  const target = (p: Part) => {
    const w = p.wires.find(x => !x.to.startsWith("@"));
    const bp = w ? boardPin(b, w.to) : null;
    return bp ? bp : { x: BX + b.w / 2, y: BY + b.h / 2 };
  };
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const list = bySide[side];
    if (!list.length) continue;
    const vertical = side === "left" || side === "right";
    const sizes = list.map(p => {
      const np = Math.max(p.pins.length, outerPins(p).length);
      return vertical ? { w: 150, h: Math.max(58, np * 16 + 26) } : { w: Math.max(118, np * 24 + 34), h: 62 };
    });
    // nach Ziel sortiert, dann ohne Überlappung verteilen
    const idx = list.map((_, i) => i).sort((a, c) => vertical ? target(list[a]).y - target(list[c]).y : target(list[a]).x - target(list[c]).x);
    const gap = 10;
    const lo = 12, hi = vertical ? SVG_H - 12 : SVG_W - 12;
    const len = (i: number) => vertical ? sizes[i].h : sizes[i].w;
    const pos: number[] = [];
    let cur = lo;
    for (const i of idx) {
      const want = (vertical ? target(list[i]).y : target(list[i]).x) - len(i) / 2;
      cur = Math.max(cur, want);
      pos[i] = cur;
      cur += len(i) + gap;
    }
    // ragt hinten raus -> nach vorne schieben
    if (cur - gap > hi) {
      for (let k = idx.length - 1; k >= 0; k--) {
        const i = idx[k];
        const next = k < idx.length - 1 ? pos[idx[k + 1]] - gap - len(i) : hi - len(i);
        pos[i] = Math.max(lo, Math.min(pos[i], next));
      }
    }
    list.forEach((p, i) => {
      const s = sizes[i];
      const x = side === "left" ? BX - GAP - s.w : side === "right" ? BX + b.w + GAP : pos[i];
      const y = side === "top" ? BY - GAP - s.h : side === "bottom" ? BY + b.h + GAP : pos[i];
      const pins: Placed["pins"] = {};
      const putPins = (names: string[], edge: "in" | "out") => names.forEach((nm, k) => {
        const m = names.length;
        if (vertical) {
          const py = y + 26 + (s.h - 30) * (m === 1 ? 0.5 : k / (m - 1)) * 0.8;
          const atBoard = side === "left" ? x + s.w : x;
          pins[nm] = { x: edge === "in" ? atBoard : (side === "left" ? x : x + s.w), y: py };
        } else {
          const px = x + 18 + (s.w - 36) * (m === 1 ? 0.5 : k / (m - 1));
          const atBoard = side === "top" ? y + s.h : y;
          pins[nm] = { x: px, y: edge === "in" ? atBoard : (side === "top" ? y : y + s.h) };
        }
      });
      if (p.outer) putPins(p.pins, "out"); else putPins(p.pins, "in");
      putPins(outerPins(p), "out");
      out.push({ part: p, x, y, w: s.w, h: s.h, pins });
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Zeichnen
// ---------------------------------------------------------------------

function partName(p: Part): string {
  const base = t("wr.part." + p.kind);
  return p.name ? `${base} ${p.name}` : base;
}

function partGlyph(pl: Placed): string {
  const { part: p, x, y, w, h } = pl;
  const cx = x + w / 2, cy = y + h / 2 + 4;
  switch (p.kind) {
    case "motor": return `<rect x="${n(cx - 15)}" y="${n(cy - 13)}" width="30" height="26" rx="4" fill="#3a3f47" stroke="#8a929c"/><circle cx="${n(cx)}" cy="${n(cy)}" r="8" fill="#22262b" stroke="#8a929c"/><circle cx="${n(cx)}" cy="${n(cy)}" r="2.5" fill="#cfd5dc"/>`;
    case "switch": return `<line x1="${n(cx - 16)}" y1="${n(cy + 6)}" x2="${n(cx + 12)}" y2="${n(cy - 6)}" stroke="#cfd5dc" stroke-width="2.5"/><circle cx="${n(cx - 16)}" cy="${n(cy + 6)}" r="3" fill="#cfd5dc"/><circle cx="${n(cx + 16)}" cy="${n(cy + 6)}" r="3" fill="#cfd5dc"/>`;
    case "estop": return `<circle cx="${n(cx)}" cy="${n(cy)}" r="14" fill="#f5c518"/><circle cx="${n(cx)}" cy="${n(cy)}" r="10" fill="#e5484d" stroke="#8b1d20"/>`;
    case "psu": return `<text x="${n(cx)}" y="${n(cy + 6)}" text-anchor="middle" class="wr-glyph">⎓</text>`;
    default: return `<text x="${n(cx)}" y="${n(cy + 6)}" text-anchor="middle" class="wr-glyph">${{
      probe: "📍", wls: "🎯", laser: "🔦", relay: "🔁", vfd: "〰", plasma: "⚡", thc: "↕", pump: "💨", door: "🚪", extdrv: "▤"
    }[p.kind as string] || "■"}</text>`;
  }
}

function boardSvg(b: Board, active: Set<string>, connComp: Map<string, CompId> | null): string {
  let s = `<rect x="${BX - 8}" y="${BY - 8}" width="${b.w + 16}" height="${b.h + 16}" rx="14" class="wr-board"/>`;
  s += `<text x="${BX + b.w / 2}" y="${BY + b.h + 34}" text-anchor="middle" class="wr-board-name">${esc(b.name)}</text>`;
  for (const d of b.deco) {
    s += `<rect x="${BX + d.x}" y="${BY + d.y}" width="${d.w}" height="${d.h}" rx="4" class="wr-deco wr-deco-${d.kind}"/>`;
    s += `<text x="${BX + d.x + d.w / 2}" y="${BY + d.y + d.h / 2 + 5}" text-anchor="middle" class="wr-deco-t">${esc(d.label)}</text>`;
  }
  for (const c of b.conns) {
    const on = active.has(c.id);
    const cc = connComp?.get(c.id);
    const len = (c.pins.length - 1) * PIN;
    const x0 = BX + c.x - 7, y0 = BY + c.y - 7;
    const w = c.dir === "h" ? len + 14 : 14, h = c.dir === "h" ? 14 : len + 14;
    const stroke = cc ? COMP_COLOR[cc] : on ? "var(--accent-color)" : "#56606b";
    s += `<g class="wr-conn${on ? " on" : ""}${connComp ? " pick" : ""}" data-conn="${c.id}"${cc ? ` data-comp="${cc}"` : ""}>`;
    s += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="3" fill="#15181c" stroke="${stroke}" stroke-width="${on || cc ? 2 : 1}"/>`;
    c.pins.forEach((p, i) => {
      const pp = pinPos(c, i);
      const tipTxt = `${c.label} · ${p.label}${p.mcu ? " · " + p.mcu : ""}${p.fn ? " · " + fnText(p.fn) : ""}`;
      s += `<circle cx="${pp.x}" cy="${pp.y}" r="4.3" class="wr-pin"><title>${esc(tipTxt)}</title></circle>`;
      // Pin-Beschriftung
      if (c.dir === "h") s += `<text x="${pp.x}" y="${c.labelPos === "above" ? pp.y + 18 : pp.y - 10}" text-anchor="middle" class="wr-pinlbl">${esc(p.label)}</text>`;
      else {
        const right = c.labelPos !== "left" && c.x < b.w / 2;
        s += `<text x="${right ? pp.x + 11 : pp.x - 11}" y="${pp.y + 3.5}" text-anchor="${right ? "start" : "end"}" class="wr-pinlbl">${esc(p.label)}</text>`;
      }
    });
    // Stecker-Name
    const lp = c.labelPos || "above";
    if (c.dir === "h") {
      const ty = lp === "below" ? y0 + h + 22 : y0 - 6;
      s += `<text x="${x0 + w / 2}" y="${ty}" text-anchor="middle" class="wr-connlbl">${esc(c.label)}</text>`;
    } else {
      const right = c.x < b.w / 2;
      if (lp === "above") s += `<text x="${x0 + w / 2}" y="${y0 - 6}" text-anchor="middle" class="wr-connlbl">${esc(c.label)}</text>`;
      else {
        // Abstand nach der längsten Pin-Beschriftung, damit nichts übereinander liegt
        const off = 20 + Math.max(...c.pins.map(p => p.label.length)) * 5.8;
        s += `<text x="${n(right ? x0 + w + off : x0 - off)}" y="${y0 + h / 2 + 4}" text-anchor="${right ? "start" : "end"}" class="wr-connlbl">${esc(c.label)}</text>`;
      }
    }
    s += `</g>`;
  }
  return s;
}

function drawHookup(b: Board, hk: Hookup, box: Box): string {
  const placed = placeParts(b, hk.parts);
  for (const pl of placed) {
    box.x0 = Math.min(box.x0, pl.x - 12); box.y0 = Math.min(box.y0, pl.y - 12);
    box.x1 = Math.max(box.x1, pl.x + pl.w + 12); box.y1 = Math.max(box.y1, pl.y + pl.h + 12);
    // außen herum laufende Drähte brauchen Platz
    if (pl.part.outer || outerPins(pl.part).length) {
      if (pl.part.side === "right") box.x1 = Math.max(box.x1, pl.x + pl.w + 56);
      if (pl.part.side === "left") box.x0 = Math.min(box.x0, pl.x - 56);
      if (pl.part.side === "bottom") box.y1 = Math.max(box.y1, pl.y + pl.h + 56);
      if (pl.part.side === "top") box.y0 = Math.min(box.y0, pl.y - 56);
    }
  }
  const byId = new Map(placed.map(p => [p.part.id, p]));
  let wires = "", parts = "";
  const curve = (a: { x: number; y: number }, z: { x: number; y: number }, side: string) => {
    const d = 60;
    const v = side === "left" || side === "right";
    const sx = side === "left" ? d : side === "right" ? -d : 0, sy = side === "top" ? d : side === "bottom" ? -d : 0;
    const c1 = v ? { x: a.x + sx, y: a.y } : { x: a.x, y: a.y + sy };
    const c2 = v ? { x: z.x - sx * 0.6, y: z.y } : { x: z.x, y: z.y - sy * 0.6 };
    return `M${n(a.x)},${n(a.y)} C${n(c1.x)},${n(c1.y)} ${n(c2.x)},${n(c2.y)} ${n(z.x)},${n(z.y)}`;
  };
  const wire = (d: string, color: string) =>
    `<path d="${d}" stroke="#0008" stroke-width="5" fill="none"/><path d="${d}" stroke="${color}" stroke-width="3" fill="none" class="wr-wire"/>`;
  for (const pl of placed) {
    for (const w of pl.part.wires) {
      const a = pl.pins[w.from];
      if (!a) continue;
      let z: { x: number; y: number } | null = null;
      if (w.to.startsWith("@")) {
        const [pid, pn] = w.to.slice(1).split(".");
        z = byId.get(pid)?.pins[pn] || null;
      } else z = boardPin(b, w.to);
      if (!z) continue;
      if (w.to.startsWith("@") && pl.part.outer) {
        // zwischen zwei Bauteilen außen herum (z. B. Plasmaschneider/Pumpe an den Relais-Kontakt)
        const side = pl.part.side, o = 46;
        const ox = side === "left" ? -o : side === "right" ? o : 0, oy = side === "top" ? -o : side === "bottom" ? o : 0;
        wires += wire(`M${n(a.x)},${n(a.y)} C${n(a.x + ox)},${n(a.y + oy)} ${n(z.x + ox)},${n(z.y + oy)} ${n(z.x)},${n(z.y)}`, w.color);
        continue;
      }
      wires += wire(curve(a, z, pl.part.side), w.color);
      if (!w.to.startsWith("@")) wires += `<circle cx="${n(z.x)}" cy="${n(z.y)}" r="3.4" fill="${w.color}"/>`;
    }
  }
  for (const pl of placed) {
    parts += `<g class="wr-part"><rect x="${pl.x}" y="${pl.y}" width="${pl.w}" height="${pl.h}" rx="9" class="wr-partbox"/>`;
    parts += `<text x="${n(pl.x + pl.w / 2)}" y="${pl.y + 15}" text-anchor="middle" class="wr-partname">${esc(partName(pl.part))}</text>`;
    parts += partGlyph(pl);
    for (const [nm, p] of Object.entries(pl.pins)) {
      parts += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="4" class="wr-ppin"/>`;
      const side = pl.part.side;
      const outer = outerPins(pl.part).includes(nm) || !!pl.part.outer;
      let tx = p.x, ty = p.y, anchor = "middle";
      if (side === "left" || side === "right") {
        const towardsInside = (side === "left") !== outer;
        tx = towardsInside ? p.x - 8 : p.x + 8; ty = p.y + 3.5; anchor = towardsInside ? "end" : "start";
      } else {
        const below = (side === "top") !== outer;
        ty = below ? p.y - 7 : p.y + 14;
      }
      parts += `<text x="${n(tx)}" y="${n(ty)}" text-anchor="${anchor}" class="wr-ppinlbl">${esc(nm)}</text>`;
    }
    parts += `</g>`;
  }
  return wires + parts;
}

// ---------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------

export function initWiringPage() {
  const root = document.getElementById("wiring-page");
  if (!root) return;
  let boardId = get(KEY_BOARD, "");
  if (!BOARDS.some(b => b.id === boardId)) boardId = guessBoard();
  let level = get(KEY_LEVEL, "beginner") === "pro" ? "pro" : "beginner";
  let comp = get(KEY_COMP, "overview") as CompId | "overview";

  const render = () => {
    const b = getBoard(boardId);
    if (comp !== "overview" && !COMPS.includes(comp)) comp = "overview";
    const hk = comp === "overview" ? null : b.hookups[comp] || null;

    // aktive Stecker
    const active = new Set<string>();
    let connComp: Map<string, CompId> | null = null;
    if (hk) hk.parts.forEach(p => p.wires.forEach(w => { if (!w.to.startsWith("@")) active.add(w.to.split(".")[0]); }));
    else {
      connComp = new Map();
      for (const c of COMPS) b.hookups[c]?.parts.forEach(p => p.wires.forEach(w => {
        if (!w.to.startsWith("@")) { const id = w.to.split(".")[0]; if (!connComp!.has(id)) connComp!.set(id, c); }
      }));
    }

    const boardCards = BOARDS.map(x => `
      <button class="wr-boardbtn${x.id === b.id ? " active" : ""}" data-board="${x.id}">
        <b>${esc(x.name)}</b><span>${esc(x.mcu)} · ${esc(x.volt)}</span></button>`).join("");
    const chips = [`<button class="wr-chip${comp === "overview" ? " active" : ""}" data-comp="overview">🗺️ ${esc(t("wr.overview"))}</button>`]
      .concat(COMPS.map(c => {
        const h = b.hookups[c];
        const na = !h || !!h.unavailable;
        return `<button class="wr-chip${comp === c ? " active" : ""}${na ? " na" : ""}" data-comp="${c}" style="--cc:${COMP_COLOR[c]}">${COMP_ICON[c]} ${esc(t("wr.comp." + c))}</button>`;
      })).join("");

    // Ausschnitt: Board (+ Beschriftungen) und alle gezeichneten Bauteile
    const box: Box = { x0: BX - 40, y0: BY - 30, x1: BX + b.w + 40, y1: BY + b.h + 50 };
    let svgInner = boardSvg(b, active, connComp);
    if (hk && !hk.unavailable) svgInner += drawHookup(b, hk, box);
    const vb = `${n(box.x0)} ${n(box.y0)} ${n(box.x1 - box.x0)} ${n(box.y1 - box.y0)}`;
    const svg = `<svg class="wr-svg" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${svgInner}</svg>`;

    // rechte Spalte
    const tx = (s: { k: string; p?: Record<string, string> }) => esc(t(s.k, s.p));
    let side = "";
    if (!hk) {
      side += `<h3>🗺️ ${esc(t("wr.overview"))}</h3><p class="wr-p">${esc(t("wr.overviewText"))}</p>`;
      side += `<div class="wr-legend">${COMPS.filter(c => b.hookups[c] && !b.hookups[c]!.unavailable).map(c => `<span style="--cc:${COMP_COLOR[c]}"><i></i>${esc(t("wr.comp." + c))}</span>`).join("")}</div>`;
      side += `<div class="wr-facts"><div><b>${esc(t("wr.fact.mcu"))}</b> ${esc(b.mcu)}</div><div><b>${esc(t("wr.fact.volt"))}</b> ${esc(b.volt)}</div><div><b>${esc(t("wr.fact.fw"))}</b> ${esc(t(b.fw))}</div></div>`;
      side += `<div class="wr-warn">⚡ ${esc(t("wr.safety"))}</div>`;
    } else if (hk.unavailable) {
      side += `<h3>${COMP_ICON[hk.comp]} ${esc(t("wr.comp." + hk.comp))}</h3><div class="wr-note">${esc(t(hk.unavailable))}</div>`;
    } else {
      side += `<h3>${COMP_ICON[hk.comp]} ${esc(t("wr.comp." + hk.comp))}</h3>`;
      if (hk.notes.length) side += hk.notes.map(s => `<div class="wr-note">⚠ ${tx(s)}</div>`).join("");
      if (level === "beginner") {
        side += `<h4>${esc(t("wr.steps"))}</h4><ol class="wr-steps">${hk.steps.map(s => `<li>${tx(s)}</li>`).join("")}</ol>`;
      } else {
        const rows: string[] = [];
        for (const p of hk.parts) for (const w of p.wires) {
          if (w.to.startsWith("@")) continue;
          const bp = boardPin(b, w.to);
          if (!bp) continue;
          const pin = bp.c.pins[bp.i];
          rows.push(`<tr><td><i style="background:${w.color}"></i>${esc(partName(p))} · ${esc(w.from)}</td><td>${esc(bp.c.label)} · ${esc(pin.label)}</td><td>${esc(pin.mcu || "–")}</td><td>${esc(fnText(pin.fn || ""))}</td></tr>`);
        }
        side += `<h4>${esc(t("wr.pinTable"))}</h4><table class="wr-table"><thead><tr><th>${esc(t("wr.col.part"))}</th><th>${esc(t("wr.col.board"))}</th><th>${esc(t("wr.col.mcu"))}</th><th>${esc(t("wr.col.fn"))}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
        if (hk.pro.length) side += `<h4>${esc(t("wr.proNotes"))}</h4><ul class="wr-pro">${hk.pro.map(s => `<li>${tx(s)}</li>`).join("")}</ul>`;
        side += `<details class="wr-details"><summary>${esc(t("wr.steps"))}</summary><ol class="wr-steps">${hk.steps.map(s => `<li>${tx(s)}</li>`).join("")}</ol></details>`;
      }
      if (hk.settings.length) side += `<h4>${esc(t("wr.settings"))}</h4><div class="wr-settings">${hk.settings.map(s => `<code>${esc(s)}</code>`).join("")}</div>`;
      side += `<div class="wr-test">✅ ${esc(t("wr.test"))}</div>`;
    }

    root.innerHTML = `
      <div class="wr">
        <div class="wr-top">
          <div class="wr-boards">${boardCards}</div>
          <div class="wr-level" role="group">
            <button data-level="beginner" class="${level === "beginner" ? "active" : ""}">🙂 ${esc(t("wr.level.beginner"))}</button>
            <button data-level="pro" class="${level === "pro" ? "active" : ""}">🛠️ ${esc(t("wr.level.pro"))}</button>
          </div>
        </div>
        <div class="wr-chips">${chips}</div>
        <div class="wr-body">
          <div class="wr-draw">${svg}</div>
          <div class="wr-side">${side}</div>
        </div>
        <div class="wr-foot">ℹ️ ${esc(t(b.source))}</div>
      </div>`;
  };

  root.addEventListener("click", (e) => {
    const el = e.target as Element;
    const bb = el.closest("[data-board]") as HTMLElement | null;
    if (bb) { boardId = bb.dataset.board!; put(KEY_BOARD, boardId); render(); return; }
    const lv = el.closest("[data-level]") as HTMLElement | null;
    if (lv) { level = lv.dataset.level === "pro" ? "pro" : "beginner"; put(KEY_LEVEL, level); render(); return; }
    const cc = el.closest("[data-comp]") as HTMLElement | null;
    if (cc) { comp = cc.dataset.comp as any; put(KEY_COMP, comp); render(); return; }
  });
  window.addEventListener("cnc-language-changed", render);
  render();
}
