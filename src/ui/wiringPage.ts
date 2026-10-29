/**
 * ANSCHLUSSPLAN (Reiter „Anschlüsse“)
 *
 * Board aus der Liste wählen (wie beim Board-Flashen, nach Hersteller gruppiert), dann ein Bauteil
 * (Netzteil, Motoren, Endschalter, Taster/WLS, Laser, Spindel, Plasma, Luft, Not-Aus, Tür):
 *   - Zeichnung: Board mit Steckern + Bauteile mit farbigen Drähten an die richtigen Pins
 *   - Einsteiger: Schritt-für-Schritt-Anleitung, Warnungen, was danach einzustellen ist
 *   - Profi: Pin-Tabelle (Beschriftung, Controller-Pin, Funktion) + technische Hinweise
 *   - Übersicht: alle Stecker farbig nach Bauteil, Klick wählt das Bauteil
 * Die Zeichnung zoomt automatisch auf Board + Bauteile.
 * Daten: src/wiring/boards.ts
 */
import { t } from "../i18n/i18n";
import { BOARDS, COMPS, OPTIONAL_COMPS, CompId, Board, BConn, Deco, Part, Hookup, getBoard, sensorHookup, SensorType, SensorVolt } from "../wiring/boards";
import { DRIVERS, getDriver, msFor, Ms } from "../wiring/drivers";

const KEY_BOARD = "cnc_craft_wiring_board";
const KEY_LEVEL = "cnc_craft_wiring_level";
const KEY_COMP = "cnc_craft_wiring_comp";
const KEY_MS = "cnc_craft_wiring_ms";   // Treiber, Mikroschritte, A-Klon (Shield) – {drv, div, clone}
const KEY_SEN = "cnc_craft_wiring_sensor";   // Endschalter/Längensensor: {type: mech|npn|pnp, volt: 5|12|24}

/** Ansicht „Schrittmotoren“: Jumper/DIP-Stellung und A-Klon, die gezeichnet werden (sonst null) */
let msView: { m: Ms; clone: string } | null = null;

const BX = 260, BY = 170;   // linke obere Ecke der Board-Fläche in der Zeichnung (Größe: board.w × board.h)
const GAP = 86;             // Abstand Bauteile <-> Board
const PIN = 13;

const COMP_COLOR: Record<CompId, string> = {
  psu: "#e5484d", motors: "#3e7bfa", extdrv: "#7c8cff", limits: "#f5c518", probe: "#f08c00", laser: "#ff5db1", rotary: "#ffa94d",
  spindle: "#9b5de5", modbus: "#b388ff", plasma: "#00b4d8", air: "#30a46c", estop: "#ff3b3b", door: "#a3a3a3", display: "#7dd3fc", io: "#2dd4bf"
};
const COMP_ICON: Record<CompId, string> = {
  psu: "🔌", motors: "⚙️", extdrv: "🎛️", limits: "🛑", probe: "📍", laser: "🔦", rotary: "🔄", spindle: "🌀", modbus: "🔗", plasma: "⚡", air: "💨", estop: "🚨", door: "🚪", display: "🖥️", io: "🔘"
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
    if (/V5\.?88/i.test(name) || fl === "pibot-v588-ultra") return "pibot-v588-ultra";
    if (/PiBot|V49PB/i.test(name) || fl === "pibot-v496-pro") return "pibot-v496-pro";
  } catch { /* egal */ }
  return "cnc-shield-v3";
}

// ---------------------------------------------------------------------
// Geometrie
// ---------------------------------------------------------------------

function pinPos(c: BConn, i: number): { x: number; y: number } {
  const p = c.pitch ?? PIN;
  return c.dir === "h" ? { x: BX + c.x + i * p, y: BY + c.y } : { x: BX + c.x, y: BY + c.y + i * p };
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
  if (p.outerPins) return p.outerPins;
  if (p.kind === "relay") return ["COM", "NO"];
  if (p.kind === "extdrv") return ["A+", "A−", "B+", "B−", "VCC", "GND"];
  // 0–10-V-Wandler: eigene Versorgung 12–24 V, Ausgang an den Analog-Eingang des Umrichters (AVI/ACM)
  if (p.kind === "vfd") return ["+24V", "0V", "AVI", "ACM"];
  // CO2-Laser-Netzteil: Netz (230 V) und Hochspannung zur Röhre (Anode +, Kathode −)
  if (p.kind === "lpsu") return ["AC L", "AC N", "Anode", "Kathode"];
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
    case "motor": case "rotary": return `<rect x="${n(cx - 15)}" y="${n(cy - 13)}" width="30" height="26" rx="4" fill="#3a3f47" stroke="#8a929c"/><circle cx="${n(cx)}" cy="${n(cy)}" r="8" fill="#22262b" stroke="#8a929c"/><circle cx="${n(cx)}" cy="${n(cy)}" r="2.5" fill="#cfd5dc"/>`;
    case "switch": return `<line x1="${n(cx - 16)}" y1="${n(cy + 6)}" x2="${n(cx + 12)}" y2="${n(cy - 6)}" stroke="#cfd5dc" stroke-width="2.5"/><circle cx="${n(cx - 16)}" cy="${n(cy + 6)}" r="3" fill="#cfd5dc"/><circle cx="${n(cx + 16)}" cy="${n(cy + 6)}" r="3" fill="#cfd5dc"/>`;
    case "estop": return `<circle cx="${n(cx)}" cy="${n(cy)}" r="14" fill="#f5c518"/><circle cx="${n(cx)}" cy="${n(cy)}" r="10" fill="#e5484d" stroke="#8b1d20"/>`;
    case "prox":
      // M12-Sensor: Gewindehülse, schwarze Stirnfläche, orange LED
      return `<rect x="${n(cx - 18)}" y="${n(cy - 7)}" width="30" height="14" rx="2" fill="#b8bdc4" stroke="#7d828a"/>` +
        [0, 1, 2, 3, 4].map(k => `<line x1="${n(cx - 15 + k * 6)}" y1="${n(cy - 7)}" x2="${n(cx - 15 + k * 6)}" y2="${n(cy + 7)}" stroke="#7d828a"/>`).join("") +
        `<rect x="${n(cx + 12)}" y="${n(cy - 6)}" width="6" height="12" rx="2" fill="#2b2b2b"/><circle cx="${n(cx - 21)}" cy="${n(cy)}" r="2.5" fill="#f08c00"/>`;
    case "opto":
      return `<rect x="${n(cx - 16)}" y="${n(cy - 9)}" width="32" height="18" rx="2" fill="#1b1d21" stroke="#56606b"/><text x="${n(cx)}" y="${n(cy + 4)}" text-anchor="middle" class="wr-glyph" style="font-size:10px">→|</text>`;
    case "psu": return `<text x="${n(cx)}" y="${n(cy + 6)}" text-anchor="middle" class="wr-glyph">⎓</text>`;
    default: return `<text x="${n(cx)}" y="${n(cy + 6)}" text-anchor="middle" class="wr-glyph">${{
      probe: "📍", wls: "🎯", laser: "🔦", relay: "🔁", vfd: "〰", inv: "〰", plasma: "⚡", thc: "↕", pump: "💨", door: "🚪", extdrv: "▤", lpsu: "⚡", flow: "💧", foot: "🦶", button: "🔘", lamp: "💡", flame: "🔥", buzzer: "🔔", pbtn: "🔘", lcd: "🖥️", router: "🌀"
    }[p.kind as string] || "■"}</text>`;
  }
}

/** Gehäuse-Rand eines Steckers je Bauform (Schraubklemme, Hohlstecker … sind größer als die Pins) */
function connPad(c: BConn): { px: number; py: number } {
  const across = c.style === "screw" ? 11 : c.style === "barrel" ? 22 : c.style === "xt" ? 6 : 0;
  const along = c.style === "screw" || c.style === "xt" ? 4 : c.style === "barrel" ? 12 : 0;
  return c.dir === "h" ? { px: along, py: across } : { px: across, py: along };
}

/** Platinen-Optik (Treibersockel, Funkmodul, USB …) – nur Zeichnung, ohne Funktion */
function decoSvg(d: Deco): string {
  const x = BX + d.x, y = BY + d.y, w = d.w, h = d.h;
  const label = (cls = "wr-deco-t", dy = 0) => d.label ? `<text x="${n(x + w / 2)}" y="${n(y + h / 2 + 4 + dy)}" text-anchor="middle" class="${cls}">${esc(d.label)}</text>` : "";
  switch (d.kind) {
    case "socket": {
      // grüne Stiftleiste links, schwarze rechts, Kondensator, rote DIP-Schalter, Achsbuchstabe
      let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#0d0e10" stroke="#2a2d33"/>`;
      s += `<rect x="${x + 1}" y="${y + 1}" width="11" height="${h - 2}" fill="#3fcf7a"/><rect x="${x + w - 12}" y="${y + 1}" width="11" height="${h - 2}" fill="#1b1d21"/>`;
      for (let py = y + 9; py < y + h - 4; py += 13) {
        s += `<rect x="${x + 4}" y="${py - 2.5}" width="5" height="5" fill="#0d0e10"/><circle cx="${x + w - 6.5}" cy="${py}" r="2.4" fill="#8a8f96"/>`;
      }
      s += `<circle cx="${n(x + w * 0.38)}" cy="${y + 26}" r="13" fill="#c9ccd1" stroke="#7d828a"/><path d="M${n(x + w * 0.38 - 13)},${y + 31} A13,13 0 0,0 ${n(x + w * 0.38 + 13)},${y + 31} Z" fill="#2f9e8f"/>`;
      const dw = w - 38, dx = x + 19, dy = y + h - 52;
      s += `<rect x="${n(dx)}" y="${n(dy)}" width="${n(dw)}" height="38" rx="2" fill="#d23a3f"/>`;
      for (let k = 0; k < 3; k++) {
        const sx = dx + 6 + k * (dw - 12) / 3, sw = (dw - 12) / 3 - 5;
        if (!msView) { s += `<rect x="${n(sx)}" y="${n(dy + 7)}" width="${n(sw)}" height="16" rx="1.5" fill="#f4f4f4"/>`; continue; }
        // Schlitz + weißer Schieber: oben = ON
        s += `<rect x="${n(sx)}" y="${n(dy + 7)}" width="${n(sw)}" height="16" rx="1.5" fill="#7a1418"/>`;
        s += `<rect x="${n(sx)}" y="${n(msView.m[k] ? dy + 7 : dy + 16)}" width="${n(sw)}" height="7" rx="1.5" class="wr-dip${msView.m[k] ? " on" : ""}"/>`;
      }
      s += `<text x="${n(dx + dw / 2)}" y="${n(dy + 34)}" text-anchor="middle" class="wr-silk" style="font-size:8px">ON  1 2 3</text>`;
      s += `<text x="${x + w - 24}" y="${y + 24}" text-anchor="middle" class="wr-silk" style="font-size:19px">${esc(d.label)}</text>`;
      return s;
    }
    case "esp": {
      // Funkmodul: silberne Abschirmung, Antenne oben
      let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#0f1012" stroke="#3a3e45"/>`;
      s += `<rect x="${x + 6}" y="${n(y + h * 0.24)}" width="${w - 12}" height="${n(h * 0.72)}" rx="3" fill="#b8bdc4" stroke="#8b9097"/>`;
      s += `<path d="M${x + 10},${y + 14} h${w - 30} v8 h-${w - 38} v8 h${w - 38}" fill="none" stroke="#c9a33a" stroke-width="2"/>`;
      s += `<text x="${n(x + w / 2)}" y="${n(y + h * 0.62)}" text-anchor="middle" class="wr-esp-t">${esc(d.label)}</text>`;
      return s;
    }
    case "usb":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#c3c7cd" stroke="#858a92"/><rect x="${x + w * 0.22}" y="${y + h * 0.3}" width="${w * 0.56}" height="${h * 0.42}" rx="3" fill="#3b3f45"/>` + label("wr-metal-t", -h * 0.3);
    case "sd":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#c3c7cd" stroke="#858a92"/><rect x="${x + 8}" y="${y + 6}" width="${w - 16}" height="10" rx="2" fill="#6d727a"/>` + label("wr-metal-t", 8);
    case "fuse":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#d8343a" opacity="0.85"/><rect x="${x + 7}" y="${y + 10}" width="${w - 14}" height="${h - 20}" rx="2" fill="#f07a7e" opacity="0.7"/>`;
    case "exp": {
      let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#0d0e10" stroke="#3a3e45"/><rect x="${n(x + w / 2 - 10)}" y="${y + h - 5}" width="20" height="5" fill="#2a2d33"/>`;
      for (let r = 0; r < 2; r++) for (let k = 0; k < 5; k++) s += `<circle cx="${n(x + 28 + k * (w - 56) / 4)}" cy="${n(y + h * 0.36 + r * 16)}" r="3" fill="#c9a33a"/>`;
      return s + `<text x="${x + w - 4}" y="${y - 4}" text-anchor="end" class="wr-silk" style="font-size:9px">${esc(d.label)}</text>`;
    }
    case "rj":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#0d0e10" stroke="#4a4e55"/><rect x="${x + 8}" y="${y + 6}" width="${w - 16}" height="12" fill="#8b9097"/>` + label("wr-silk", 10);
    case "text": {
      const tx = d.align === "start" ? x : d.align === "end" ? x + w : x + w / 2;
      const ty = y + h / 2 + (d.size || 12) * 0.35;
      const rot = d.rot ? ` transform="rotate(-90 ${n(tx)} ${n(y + h / 2)})"` : "";
      return `<text x="${n(tx)}" y="${n(ty)}" text-anchor="${d.align || "middle"}"${rot} class="wr-silk" style="font-size:${d.size || 12}px">${esc(d.label)}</text>`;
    }
    case "pins": {
      // Raster aus Stiften (nur Optik), oval = Lötaugen
      let s = "";
      const g = d.gap ?? PIN;
      for (let r = 0; r < (d.rows ?? 1); r++) for (let k = 0; k < (d.cols ?? 1); k++) {
        const cx = x + k * g, cy = y + r * g;
        s += d.oval
          ? `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="6" ry="9.5" fill="#e3c25a" stroke="#8a6d1c"/><circle cx="${n(cx)}" cy="${n(cy)}" r="2.6" fill="#3a2a10"/>`
          : `<rect x="${n(cx - 6)}" y="${n(cy - 6)}" width="12" height="12" fill="#1b1b1d"/><rect x="${n(cx - 2.6)}" y="${n(cy - 2.6)}" width="5.2" height="5.2" fill="#d4af37"/>`;
      }
      return s;
    }
    case "button":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="#e9e9e9" stroke="#999"/><rect x="${x + w * 0.22}" y="${y + h * 0.18}" width="${w * 0.56}" height="${h * 0.64}" rx="3" fill="#2b2b2d"/><circle cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" r="${n(Math.min(w, h) * 0.2)}" fill="#111"/>`;
    case "shsock": {
      // Treiber-Steckplatz auf dem Shield: gelbe Buchsenleisten, Mikroschritt-Brücken M0 M1 M2
      let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="none" stroke="#f5f5f5" stroke-width="2"/>`;
      s += `<rect x="${x + 6}" y="${y + 6}" width="14" height="${h - 12}" fill="#f2cf1d"/><rect x="${x + w - 20}" y="${y + 6}" width="14" height="${h - 12}" fill="#f2cf1d"/>`;
      for (let k = 0; k < 8; k++) {
        const py = y + 16 + k * ((h - 32) / 7);
        s += `<rect x="${x + 10}" y="${n(py - 3)}" width="6" height="6" fill="#222"/><rect x="${x + w - 16}" y="${n(py - 3)}" width="6" height="6" fill="#222"/>`;
      }
      const jx = x + w / 2 - 34, jy = y + h - 58;
      for (let k = 0; k < 3; k++) {
        s += `<rect x="${n(jx + k * 24)}" y="${n(jy)}" width="22" height="44" fill="none" stroke="#ffd2d2" stroke-width="1.6"/>`;
        s += `<rect x="${n(jx + k * 24 + 7)}" y="${n(jy + 6)}" width="8" height="8" fill="#d4af37"/><rect x="${n(jx + k * 24 + 7)}" y="${n(jy + 28)}" width="8" height="8" fill="#d4af37"/>`;
        s += `<text x="${n(jx + k * 24 + 11)}" y="${n(jy - 4)}" text-anchor="middle" class="wr-silk" style="font-size:9px">M${k}</text>`;
        if (msView?.m[k]) s += `<rect x="${n(jx + k * 24 + 3)}" y="${n(jy + 3)}" width="16" height="36" rx="3" class="wr-jumper"/>`;
      }
      return s + `<text x="${x + 28}" y="${y + 20}" class="wr-silk" style="font-size:9px">EN</text>`;
    }
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" class="wr-deco wr-deco-${d.kind}"/>` + label();
  }
}

/** Gehäuse eines Steckers je Bauform */
function connBody(c: BConn, x0: number, y0: number, w: number, h: number, stroke: string, sw: number): string {
  if (c.style === "barrel") {
    // Hohlstecker-Buchse: schwarzer Block mit runder Öffnung, Pins darin
    return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="4" fill="#111214" stroke="${stroke}" stroke-width="${sw}"/><circle cx="${n(x0 + w / 2)}" cy="${n(y0 + h * 0.3)}" r="9" fill="#2a2d32" stroke="#555a61"/>`;
  }
  if (c.style === "screw") {
    return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="3" fill="${c.body || "#1c1e22"}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  if (c.style === "pads") return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="7" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="3 2"/>`;
  const fill = c.style === "xt" ? "#e0a21e" : c.body || "#15181c";
  return `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

function boardSvg(b: Board, active: Set<string>, connComp: Map<string, CompId> | null): string {
  const pcb = b.pcb;
  let s = pcb && b.outline
    ? `<path d="M${b.outline.map(([px, py]) => `${BX + px},${BY + py}`).join(" L")} Z" fill="${pcb.fill}" stroke="${pcb.edge}" stroke-width="2" stroke-linejoin="round"/>`
    : pcb
      ? `<rect x="${BX - 8}" y="${BY - 8}" width="${b.w + 16}" height="${b.h + 16}" rx="16" fill="${pcb.fill}" stroke="${pcb.edge}" stroke-width="2"/>`
      : `<rect x="${BX - 8}" y="${BY - 8}" width="${b.w + 16}" height="${b.h + 16}" rx="14" class="wr-board"/>`;
  s += `<text x="${BX + b.w / 2}" y="${BY + b.h + 34}" text-anchor="middle" class="wr-board-name">${esc(b.name)}</text>`;
  for (const hl of b.holes || []) {
    s += `<circle cx="${BX + hl.x}" cy="${BY + hl.y}" r="${hl.r}" fill="#d5d8dc"/><circle cx="${BX + hl.x}" cy="${BY + hl.y}" r="${n(hl.r * 0.55)}" fill="#0f1215"/>`;
  }
  for (const d of b.deco) s += decoSvg(d);
  // Shield: Jumper für die A-Achse (klont X/Y/Z): in der Reihe der Achse links A.STP, rechts A.DIR
  if (msView?.clone && b.id === "cnc-shield-v3") {
    const blk = b.deco.find(d => d.kind === "pins" && d.cols === 4 && d.rows === 4);
    const r = "XYZ".indexOf(msView.clone);
    if (blk && r >= 0) {
      const g = blk.gap ?? PIN, y = BY + blk.y + r * g;
      for (const c0 of [0, 2]) s += `<rect x="${n(BX + blk.x + c0 * g - 9)}" y="${n(y - 8)}" width="${n(g + 18)}" height="16" rx="4" class="wr-jumper"/>`;
    }
  }
  for (const c of b.conns) {
    const on = active.has(c.id);
    const cc = connComp?.get(c.id);
    const len = (c.pins.length - 1) * (c.pitch ?? PIN);
    const pad = connPad(c);
    const x0 = BX + c.x - 7 - pad.px, y0 = BY + c.y - 7 - pad.py;
    const w = (c.dir === "h" ? len + 14 : 14) + 2 * pad.px, h = (c.dir === "h" ? 14 : len + 14) + 2 * pad.py;
    const mark = cc ? COMP_COLOR[cc] : on ? "var(--accent-color)" : "";
    // Stecker mit echter Gehäusefarbe: Markierung als Rahmen außen herum, damit die Farbe erkennbar bleibt
    const real = !!(c.body || c.style);
    const stroke = real ? "#000a" : mark || "#56606b";
    const sw = !real && mark ? 2 : 1;
    s += `<g class="wr-conn${on ? " on" : ""}${connComp ? " pick" : ""}" data-conn="${c.id}"${cc ? ` data-comp="${cc}"` : ""}>`;
    if (real && mark) s += `<rect x="${x0 - 3.5}" y="${y0 - 3.5}" width="${w + 7}" height="${h + 7}" rx="5" fill="none" stroke="${mark}" stroke-width="2.2" class="wr-mark"/>`;
    s += connBody(c, x0, y0, w, h, stroke, sw);
    c.pins.forEach((p, i) => {
      const pp = pinPos(c, i);
      const tipTxt = `${c.label} · ${p.label}${p.mcu ? " · " + p.mcu : ""}${p.fn ? " · " + fnText(p.fn) : ""}`;
      const screw = c.style === "screw";
      s += `<circle cx="${pp.x}" cy="${pp.y}" r="${screw ? 5.6 : 4.3}" class="wr-pin${screw ? " wr-pin-screw" : ""}" data-end="b:${esc(c.id)}.${esc(p.k)}"><title>${esc(tipTxt)}</title></circle>`;
      if (screw) s += `<line x1="${pp.x - 3.5}" y1="${pp.y}" x2="${pp.x + 3.5}" y2="${pp.y}" stroke="#555" stroke-width="1.4" pointer-events="none"/>`;
      if (c.pinLbl === false) return;
      // Pin-Beschriftung
      if (c.dir === "h" && c.pinRot) {
        // senkrecht, vom Stecker weg in die Platine hinein (Name steht dann außen)
        const below = c.labelPos === "above";
        const ty = below ? pp.y + 10 + pad.py : pp.y - 10 - pad.py;
        s += `<text x="${pp.x + 3}" y="${n(ty)}" text-anchor="${below ? "end" : "start"}" transform="rotate(-90 ${pp.x + 3} ${n(ty)})" class="wr-pinlbl">${esc(p.label)}</text>`;
      }
      else if (c.dir === "h") s += `<text x="${pp.x}" y="${c.labelPos === "above" ? pp.y + 18 + pad.py : pp.y - 10 - pad.py}" text-anchor="middle" class="wr-pinlbl">${esc(p.label)}</text>`;
      else {
        const right = c.pinSide ? c.pinSide === "right" : c.labelPos !== "left" && c.x < b.w / 2;
        const off = 11 + pad.px;
        s += `<text x="${right ? pp.x + off : pp.x - off}" y="${pp.y + 3.5}" text-anchor="${right ? "start" : "end"}" class="wr-pinlbl">${esc(p.label)}</text>`;
      }
    });
    // Stecker-Name
    const lp = c.labelPos || "above";
    if (c.rot) {
      // senkrecht am Platinenrand, wie der Aufdruck auf dem Board
      const tx = x0 - 7, ty = y0 + h / 2;
      s += `<text x="${n(tx)}" y="${n(ty)}" text-anchor="middle" transform="rotate(-90 ${n(tx)} ${n(ty)})" class="wr-connlbl wr-connlbl-rot">${esc(c.label)}</text>`;
    } else if (!c.label) {
      // kein Name (Beschriftung steht an den Pins)
    } else if (c.dir === "h" && (lp === "left" || lp === "right")) {
      s += `<text x="${n(lp === "left" ? x0 - 6 : x0 + w + 6)}" y="${n(y0 + h / 2 + 4)}" text-anchor="${lp === "left" ? "end" : "start"}" class="wr-connlbl">${esc(c.label)}</text>`;
    } else if (c.dir === "h") {
      const ty = lp === "below" ? y0 + h + (c.pinLbl === false || c.pinRot ? 14 : 22) : y0 - 6;
      s += `<text x="${x0 + w / 2}" y="${ty}" text-anchor="middle" class="wr-connlbl">${esc(c.label)}</text>`;
    } else {
      const right = c.x < b.w / 2;
      if (lp === "above") s += `<text x="${x0 + w / 2}" y="${y0 - 6}" text-anchor="middle" class="wr-connlbl">${esc(c.label)}</text>`;
      else if (lp === "below") s += `<text x="${x0 + w / 2}" y="${y0 + h + 14}" text-anchor="middle" class="wr-connlbl">${esc(c.label)}</text>`;
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
  /**
   * Ein Kabel als Gruppe: unsichtbare breite Linie zum leichteren Treffen mit der Maus, Schatten, Farbe, Tooltip.
   * data-ends = beide Enden („p:teil.pin“ / „b:stecker.pin“) – Maus über Kabel oder Pin hebt es hervor (initWiringPage)
   */
  const wire = (d: string, color: string, ends: string, tip: string, dot = "") =>
    `<g class="wr-w" data-ends="${esc(ends)}"><title>${esc(tip)}</title><path d="${d}" stroke="transparent" stroke-width="14" fill="none" pointer-events="stroke"/>` +
    `<path d="${d}" stroke="#0008" stroke-width="5" fill="none" class="wr-wire-sh"/><path d="${d}" stroke="${color}" stroke-width="3" fill="none" class="wr-wire" style="--wc:${color}"/>${dot}</g>`;
  for (const pl of placed) {
    for (const w of pl.part.wires) {
      const a = pl.pins[w.from];
      if (!a) continue;
      let z: { x: number; y: number } | null = null;
      let endKey = "", endName = "";
      if (w.to.startsWith("@")) {
        const [pid, pn] = w.to.slice(1).split(".");
        const other = byId.get(pid);
        z = other?.pins[pn] || null;
        endKey = `p:${pid}.${pn}`; endName = other ? `${partName(other.part)} · ${pn}` : pn;
      } else {
        const bp = boardPin(b, w.to);
        z = bp;
        endKey = `b:${w.to}`; endName = bp ? `${bp.c.label || bp.c.pins[bp.i].label} · ${bp.c.pins[bp.i].label}` : w.to;
      }
      if (!z) continue;
      const ends = `p:${pl.part.id}.${w.from} ${endKey}`;
      const tip = `${partName(pl.part)} · ${w.from}  →  ${endName}`;
      if (w.to.startsWith("@") && pl.part.outer) {
        // zwischen zwei Bauteilen außen herum (z. B. Plasmaschneider/Pumpe an den Relais-Kontakt)
        const side = pl.part.side, o = 46;
        const ox = side === "left" ? -o : side === "right" ? o : 0, oy = side === "top" ? -o : side === "bottom" ? o : 0;
        wires += wire(`M${n(a.x)},${n(a.y)} C${n(a.x + ox)},${n(a.y + oy)} ${n(z.x + ox)},${n(z.y + oy)} ${n(z.x)},${n(z.y)}`, w.color, ends, tip);
        continue;
      }
      const dot = w.to.startsWith("@") ? "" : `<circle cx="${n(z.x)}" cy="${n(z.y)}" r="3.4" fill="${w.color}"/>`;
      wires += wire(curve(a, z, pl.part.side), w.color, ends, tip, dot);
    }
  }
  for (const pl of placed) {
    parts += `<g class="wr-part"><rect x="${pl.x}" y="${pl.y}" width="${pl.w}" height="${pl.h}" rx="9" class="wr-partbox"/>`;
    parts += `<text x="${n(pl.x + pl.w / 2)}" y="${pl.y + 15}" text-anchor="middle" class="wr-partname">${esc(partName(pl.part))}</text>`;
    parts += partGlyph(pl);
    for (const [nm, p] of Object.entries(pl.pins)) {
      parts += `<circle cx="${n(p.x)}" cy="${n(p.y)}" r="4" class="wr-ppin" data-end="p:${esc(pl.part.id)}.${esc(nm)}"/>`;
      const side = pl.part.side;
      const outer = outerPins(pl.part).includes(nm) || !!pl.part.outer;
      let tx = p.x, ty = p.y, anchor = "middle";
      if (side === "left" || side === "right") {
        const towardsInside = (side === "left") !== outer;
        tx = towardsInside ? p.x - 8 : p.x + 8; ty = p.y + 3.5; anchor = towardsInside ? "end" : "start";
      } else if (outerPins(pl.part).includes(nm)) {
        // Außenklemmen (Netz, Röhre, Umrichter): Beschriftung außerhalb des Kastens, sonst liegt sie oben auf dem Namen
        ty = side === "top" ? p.y - 7 : p.y + 14;
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

/** Kasten „Mikroschritte einstellen“ (Treiber, Teiler, A-Klon) mit Ergebnis-Text */
function msPanel(drv: ReturnType<typeof getDriver>, st: { div: number; m: Ms }, isShield: boolean, clone: string): string {
  const on = [0, 1, 2].filter(k => st.m[k]);
  const list = on.map(k => isShield ? "M" + k : String(k + 1)).join(" + ");
  const res = isShield
    ? (on.length ? t("wr.ms.jumpers", { list }) : t("wr.ms.noJumpers"))
    : (on.length ? t("wr.ms.dip", { list }) : t("wr.ms.noDip"));
  const divName = (d: number) => d === 1 ? t("wr.ms.full") : `1/${d}`;
  let h = `<div class="wr-ms"><h4>${esc(t("wr.ms.title"))}</h4><div class="wr-ms-row">`;
  h += `<label>${esc(t("wr.ms.driver"))}<select id="wr-drv">${DRIVERS.map(d => `<option value="${d.id}"${d.id === drv.id ? " selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>`;
  h += `<label>${esc(t("wr.ms.div"))}<select id="wr-div">${drv.steps.map(x => x.div).sort((a, c) => a - c).map(d => `<option value="${d}"${d === st.div ? " selected" : ""}>${esc(divName(d))}</option>`).join("")}</select></label>`;
  if (isShield) h += `<label>${esc(t("wr.ms.clone"))}<select id="wr-clone">${["", "X", "Y", "Z"].map(a => `<option value="${a}"${a === clone ? " selected" : ""}>${esc(a ? t("wr.ms.cloneAxis", { axis: a }) : t("wr.ms.cloneOff"))}</option>`).join("")}</select></label>`;
  h += `</div><div class="wr-ms-res">🔧 ${esc(res)}</div>`;
  if (drv.tmc) h += `<div class="wr-p">${esc(t("wr.ms.tmc"))}</div>`;
  if (isShield && clone) h += `<div class="wr-ms-res">🔀 ${esc(t("wr.ms.cloneOn", { axis: clone }))}</div>`;
  h += `<div class="wr-p">${esc(t("wr.ms.steps", { div: String(st.div), belt: String(200 * st.div / 40), screw: String(200 * st.div / 8) }))}</div></div>`;
  return h;
}

/** Kasten „Art des Sensors“ (Schalter, induktiv NPN/PNP) mit Spannung und Angaben zu den Eingängen des Boards */
function senPanel(inputs: Board["inputs"], type: SensorType, volt: SensorVolt, comp: CompId): string {
  const btn = (v: SensorType, label: string) => `<button data-sen="${v}" class="${type === v ? "active" : ""}">${esc(label)}</button>`;
  let h = `<div class="wr-ms"><h4>${esc(t("wr.sen.title"))}</h4><div class="wr-level wr-sen" role="group">`;
  h += btn("mech", t(comp === "probe" ? "wr.sen.mechProbe" : "wr.sen.mech")) + btn("npn", t("wr.sen.npn")) + btn("pnp", t("wr.sen.pnp"));
  h += `</div>`;
  if (type !== "mech") {
    h += `<div class="wr-ms-row"><label>${esc(t("wr.sen.volt"))}<select id="wr-sen-volt">${[5, 12, 24].map(v => `<option value="${v}"${v === volt ? " selected" : ""}>${v} V</option>`).join("")}</select></label></div>`;
  }
  h += `<div class="wr-p">🔎 ${esc(t("wr.sen.in." + inputs))}</div></div>`;
  return h;
}

export function initWiringPage() {
  const root = document.getElementById("wiring-page");
  if (!root) return;
  let boardId = get(KEY_BOARD, "");
  if (!BOARDS.some(b => b.id === boardId)) boardId = guessBoard();
  let level = get(KEY_LEVEL, "beginner") === "pro" ? "pro" : "beginner";
  let comp = get(KEY_COMP, "overview") as CompId | "overview";

  let ms = { drv: "a4988", div: 16, clone: "" };
  try { ms = { ...ms, ...JSON.parse(get(KEY_MS, "{}")) }; } catch { /* egal */ }
  let sen: { type: SensorType; volt: SensorVolt } = { type: "mech", volt: 24 };
  try {
    const v = JSON.parse(get(KEY_SEN, "{}"));
    if (["mech", "npn", "pnp"].includes(v.type)) sen.type = v.type;
    if ([5, 12, 24].includes(v.volt)) sen.volt = v.volt;
  } catch { /* egal */ }

  const render = () => {
    const b = getBoard(boardId);
    if (comp !== "overview" && !COMPS.includes(comp)) comp = "overview";
    let hk = comp === "overview" ? null : b.hookups[comp] || null;
    // Endschalter / Längensensor: induktiver Sensor statt Schalter
    const senComp = !!hk && !hk.unavailable && (comp === "limits" || comp === "probe");
    if (hk && senComp && sen.type !== "mech") hk = sensorHookup(b, hk, sen.type, sen.volt);
    // Mikroschritte / A-Klon nur in der Ansicht „Schrittmotoren“ zeichnen
    const drv = getDriver(ms.drv), st = msFor(drv, ms.div);
    const isShield = b.id === "cnc-shield-v3";
    const hasSockets = b.deco.some(d => d.kind === "shsock" || d.kind === "socket");
    msView = comp === "motors" && hasSockets ? { m: st.m, clone: isShield ? ms.clone : "" } : null;

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

    // Auswahlliste wie beim Board-Flashen – nach Hersteller gruppiert, damit es auch mit vielen Boards übersichtlich bleibt
    const makers = [...new Set(BOARDS.map(x => x.maker))].sort((a, c) => a.localeCompare(c));
    const boardSelect = `
      <label class="wr-boardpick">
        <span>${esc(t("wr.board"))}</span>
        <select id="wr-board">
          ${makers.map(mk => `<optgroup label="${esc(mk)}">${BOARDS.filter(x => x.maker === mk)
            .map(x => `<option value="${x.id}"${x.id === b.id ? " selected" : ""}>${esc(x.name)} – ${esc(x.mcu)}</option>`).join("")}</optgroup>`).join("")}
        </select>
        <em>${esc(b.mcu)} · ${esc(b.volt)} · ${esc(t(b.fw))}</em>
      </label>`;
    const chips = [`<button class="wr-chip${comp === "overview" ? " active" : ""}" data-comp="overview">🗺️ ${esc(t("wr.overview"))}</button>`]
      .concat(COMPS.filter(c => !OPTIONAL_COMPS.includes(c) || b.hookups[c]).map(c => {
        const h = b.hookups[c];
        const na = !h || !!h.unavailable;
        return `<button class="wr-chip${comp === c ? " active" : ""}${na ? " na" : ""}" data-comp="${c}" style="--cc:${COMP_COLOR[c]}">${COMP_ICON[c]} ${esc(t("wr.comp." + c))}</button>`;
      })).join("");

    // Ausschnitt: Board (+ Beschriftungen) und alle gezeichneten Bauteile
    const box: Box = { x0: BX - 40, y0: BY - 30, x1: BX + b.w + 40, y1: BY + b.h + 50 };
    let svgInner = boardSvg(b, active, connComp);
    if (hk && !hk.unavailable) svgInner += drawHookup(b, hk, box);
    const vb = `${n(box.x0)} ${n(box.y0)} ${n(box.x1 - box.x0)} ${n(box.y1 - box.y0)}`;
    const svg = `<svg class="wr-svg${b.pcb?.light ? " wr-light" : ""}" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${svgInner}</svg>`;

    // rechte Spalte
    const tx = (s: { k: string; p?: Record<string, string> }) => esc(t(s.k, s.p));
    let side = "";
    if (!hk) {
      side += `<h3>🗺️ ${esc(t("wr.overview"))}</h3><p class="wr-p">${esc(t("wr.overviewText"))}</p>`;
      side += `<div class="wr-legend">${COMPS.filter(c => b.hookups[c] && !b.hookups[c]!.unavailable).map(c => `<span style="--cc:${COMP_COLOR[c]}"><i></i>${esc(t("wr.comp." + c))}</span>`).join("")}</div>`;
      side += `<div class="wr-facts"><div><b>${esc(t("wr.fact.mcu"))}</b> ${esc(b.mcu)}</div><div><b>${esc(t("wr.fact.volt"))}</b> ${esc(b.volt)}</div><div><b>${esc(t("wr.fact.fw"))}</b> ${esc(t(b.fw))}</div></div>`;
      side += `<div class="wr-warn">⚡ ${esc(t("wr.safety"))}</div>`;
    } else if (hk.unavailable) {
      side += `<h3>${COMP_ICON[hk.comp]} ${esc(t("wr.comp." + hk.comp))}</h3>`;
      if (senComp) side += senPanel(b.inputs, sen.type, sen.volt, hk.comp);
      side += `<div class="wr-note">${esc(t(hk.unavailable))}</div>`;
    } else {
      side += `<h3>${COMP_ICON[hk.comp]} ${esc(t("wr.comp." + hk.comp))}</h3>`;
      if (senComp) side += senPanel(b.inputs, sen.type, sen.volt, hk.comp);
      if (hk.notes.length) side += hk.notes.map(s => `<div class="wr-note">⚠ ${tx(s)}</div>`).join("");
      if (msView) side += msPanel(drv, st, isShield, ms.clone);
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
      side += `<div class="wr-test">✅ ${esc(t(b.maker === "Ruida" ? "wr.test.ruida" : "wr.test"))}</div>`;
    }

    root.innerHTML = `
      <div class="wr">
        <div class="wr-top">
          ${boardSelect}
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

  root.addEventListener("change", (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.id === "wr-board") { boardId = el.value; put(KEY_BOARD, boardId); render(); }
    if (el.id === "wr-sen-volt") {
      const v = parseInt(el.value, 10);
      if (v === 5 || v === 12 || v === 24) sen.volt = v;
      put(KEY_SEN, JSON.stringify(sen));
      render();
    }
    if (el.id === "wr-drv" || el.id === "wr-div" || el.id === "wr-clone") {
      if (el.id === "wr-drv") { ms.drv = el.value; ms.div = getDriver(el.value).std; }
      if (el.id === "wr-div") ms.div = parseInt(el.value, 10) || 16;
      if (el.id === "wr-clone") ms.clone = el.value;
      put(KEY_MS, JSON.stringify(ms));
      render();
    }
  });
  root.addEventListener("click", (e) => {
    const el = e.target as Element;
    const lv = el.closest("[data-level]") as HTMLElement | null;
    if (lv) { level = lv.dataset.level === "pro" ? "pro" : "beginner"; put(KEY_LEVEL, level); render(); return; }
    const sb = el.closest("[data-sen]") as HTMLElement | null;
    if (sb) {
      const v = sb.dataset.sen;
      if (v === "mech" || v === "npn" || v === "pnp") { sen.type = v; put(KEY_SEN, JSON.stringify(sen)); render(); }
      return;
    }
    const cc = el.closest("[data-comp]") as HTMLElement | null;
    if (cc) { comp = cc.dataset.comp as any; put(KEY_COMP, comp); render(); return; }
  });
  // Kabel hervorheben: Maus über ein Kabel oder einen Pin -> dieses Kabel dick und leuchtend, die anderen blass
  let hlKey = "";
  const clearHl = () => {
    hlKey = "";
    root.querySelector(".wr-svg")?.classList.remove("wr-hl");
    root.querySelectorAll(".wr-w.hl, [data-end].hl").forEach(x => x.classList.remove("hl"));
  };
  root.addEventListener("mouseover", (e) => {
    const el = e.target as Element;
    const w = el.closest(".wr-w") as SVGGElement | null;
    const end = w ? null : el.closest("[data-end]") as Element | null;
    const key = w ? "w:" + (w.getAttribute("data-ends") || "") : end ? "e:" + end.getAttribute("data-end") : "";
    if (key === hlKey) return;
    clearHl();
    if (!key) return;
    const svg = root.querySelector(".wr-svg");
    const groups = w ? [w] : [...root.querySelectorAll<SVGGElement>(".wr-w")].filter(g => (g.getAttribute("data-ends") || "").split(" ").includes(end!.getAttribute("data-end") || ""));
    if (!groups.length || !svg) return;
    hlKey = key;
    svg.classList.add("wr-hl");
    for (const g of groups) {
      g.classList.add("hl");
      g.parentNode?.appendChild(g);   // nach vorne holen
      for (const k of (g.getAttribute("data-ends") || "").split(" ")) root.querySelectorAll(`[data-end="${CSS.escape(k)}"]`).forEach(x => x.classList.add("hl"));
    }
  });
  root.addEventListener("mouseleave", clearHl);

  window.addEventListener("cnc-language-changed", render);
  render();
}
