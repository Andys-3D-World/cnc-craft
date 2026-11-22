/**
 * POST-PROCESSOR: turns CNC Craft's neutral router program (millimetres, written for GRBL) into a file for another
 * controller, described by a PostDef (posts.ts). No screen, no settings – text in, text out.
 *
 * What it reads is only what CNC Craft itself writes: G0–G3 with X Y Z I J F, G4 P, G17, G21, G90, G54–G59,
 * M0/M1, M3/M4 S, M5, M6 T, M7–M9, M2/M30 and comments in brackets. Anything else stops the translation with the line
 * number – better no file than a file with a line nobody checked.
 *
 * Rules:
 *  - GRBL in millimetres: the program comes back unchanged, character for character.
 *  - Inches: X Y Z I J are divided by 25.4 and written with 4 decimals, F with 2. S, P and tool numbers stay.
 *  - Arcs: after rounding, the centre is put back onto the line of equal distance to start and end and written with
 *    one decimal more (I J), so both radii match again (Mach3 allows 0.0002 inch / 0.002 mm, LinuxCNC 0.0005 inch /
 *    0.005 mm). In millimetres X Y Z keep their text, only I and J are written again. An arc that becomes shorter
 *    than one step of the last decimal would read as a full circle – it is written as a straight line instead.
 *  - Tool table: the first tool is loaded and its length switched on (T… M6, G43 H…) BEFORE the first move. The start
 *    line cancels the tool length (G49); a Z move before G43 would otherwise sit a whole tool length too low.
 *  - No tool table: no T, M6, G43 or G49 at all. The tool change is a pause (M0).
 *  - Rotary axis (A): not translated yet – the feed of a turning axis means something different on each controller.
 */
import type { PostDef } from "./posts.ts";

export interface PostOptions {
  inch: boolean;
  /** tool lengths from the controller's tool table (T… M6, G43 H…); false = pause, nothing about tool lengths */
  toolTable: boolean;
  /** comment lines for the top of the file: plain ASCII, no brackets */
  info?: string[];
  /** comment for the unit line of a program that keeps its own start (GRBL in inches) */
  inchNote?: string;
}

export type PostErrorCode = "rotary" | "unknown" | "relative" | "inchInput" | "noTool" | "arc" | "afterEnd" | "noEnd";
export interface PostError { code: PostErrorCode; line: number; text: string }
export interface PostResult { gcode: string; error?: PostError }

const MM_PER_INCH = 25.4;
const WORD = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
/** comments LinuxCNC and Mach3 treat as commands when they start like this */
const ACTIVE_COMMENT = /^\s*(MSG|DEBUG|PRINT|LOG|LOGOPEN|LOGAPPEND|LOGCLOSE|PROBEOPEN|PROBECLOSE|PYRUN|PYRELOAD|ABORT)\s*,/i;

const G_KEEP = new Set([0, 1, 2, 3, 17, 40, 54, 55, 56, 57, 58, 59, 80, 90, 94]);
const M_KEEP = new Set([0, 1, 3, 4, 5, 7, 8, 9]);

interface Word { l: string; txt: string; v: number }
interface Line { words: Word[]; comments: string[]; rest: string }

function readLine(raw: string): Line {
  const comments: string[] = [];
  let code = raw.replace(/\(([^)]*)\)/g, (_m, c: string) => { comments.push(c); return " "; });
  const semi = code.indexOf(";");
  if (semi >= 0) { const c = code.slice(semi + 1).trim(); if (c) comments.push(c); code = code.slice(0, semi); }
  const words: Word[] = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(code))) words.push({ l: m[1].toUpperCase(), txt: m[2], v: parseFloat(m[2]) });
  return { words, comments, rest: code.replace(WORD, "").trim() };
}

/** number with a fixed count of decimals, never "-0.000" */
export function fixed(v: number, d: number): string {
  const s = v.toFixed(d);
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

/** feed: up to 2 decimals, no trailing zeros, never 0 */
function feedText(v: number): string {
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "0" || s === "" ? "0.01" : s;
}

export function postProcess(neutral: string, def: PostDef, o: PostOptions): PostResult {
  if (!def.rewrite && !o.inch) return { gcode: neutral };

  const src = neutral.split(/\r?\n/);
  const lines = src.map(readLine);
  const out: string[] = [];
  const dec = o.inch ? 4 : 3;
  // I and J get one decimal more than X Y Z: start and end are fixed once they are rounded, so the centre decides
  // how well the two radii of an arc agree. With the same decimals they can differ by a whole last digit
  // (0.0001 inch) – half of what Mach3 allows. With one more it is a tenth of that.
  const ijDec = dec + 1;
  const table = o.toolTable && def.hasToolTable && !!def.toolTable;
  const fail = (code: PostErrorCode, i: number): PostResult => ({ gcode: "", error: { code, line: i + 1, text: (src[i] ?? "").slice(0, 80) } });

  const cmt = (list: string[]): string => {
    if (!list.length) return "";
    const text = list.map(c => (ACTIVE_COMMENT.test(c) ? "- " + c : c)).join(" - ");
    return def.comment === "semicolon" ? `; ${text}` : `(${text})`;
  };
  const withCmt = (code: string, list: string[]) => { const c = cmt(list); return code && c ? `${code} ${c}` : code || c; };
  const len = (txt: string, v: number) => (o.inch ? fixed(v / MM_PER_INCH, dec) : txt);
  const dwell = (sec: number, txt: string) =>
    def.dwell === "ms" ? String(Math.round(sec * 1000)) : def.dwell === "s." ? (Number.isInteger(sec) ? sec.toFixed(1) : String(sec)) : txt;

  const has = (ln: Line, l: string, v: number) => ln.words.some(w => w.l === l && w.v === v);
  const word = (ln: Line, l: string) => ln.words.find(w => w.l === l);
  const startHas = (w: string) => def.start.some(s => s.split(/\s+/).includes(w));

  // rotary axis first: the reason people should read, whatever else is missing
  for (let i = 0; i < lines.length; i++) if (lines[i].words.some(w => "ABCUVW".includes(w.l))) return fail("rotary", i);

  // ---- tool table: the first tool has to be loaded before anything moves ----
  let firstTool = -1;
  if (table) {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (has(ln, "M", 6)) { firstTool = i; break; }
      if (has(ln, "M", 3) || has(ln, "M", 4)) break;
    }
    if (firstTool < 0) return fail("noTool", 0);
  }
  const toolLines = (ln: Line, i: number, z: string | null): string[] | PostError => {
    const tw = word(ln, "T");
    if (!tw || !(tw.v >= 1) || !Number.isInteger(tw.v) || ln.words.length !== 2) return { code: "noTool", line: i + 1, text: src[i].slice(0, 80) };
    const tpl = table ? def.toolTable! : def.toolPause!;
    const res: string[] = [];
    for (const s of tpl) {
      if (s.includes("{z}") && z === null) continue;
      res.push(s.replace(/\{t\}/g, String(tw.v)).replace(/\{z\}/g, z ?? ""));
    }
    if (res.length) res[0] = withCmt(res[0], ln.comments);
    return res;
  };

  // ---- start ----
  for (const tpl of def.start) {
    if (tpl === "{info}") { for (const s of o.info ?? []) out.push(cmt([s])); continue; }
    const s = tpl
      .replace(/\{units\}/g, o.inch ? "G20" : "G21")
      .replace(/\{g49\}/g, table ? "G49" : "")
      .replace(/\{blend\}/g, fixed(o.inch ? def.blend / MM_PER_INCH : def.blend, dec).replace(/0+$/, "").replace(/\.$/, ".0"))
      .replace(/\s+/g, " ").trim();
    if (s) out.push(s);
  }
  if (firstTool >= 0) {
    const r = toolLines(lines[firstTool], firstTool, null);
    if (!Array.isArray(r)) return { gcode: "", error: r };
    out.push(...r);
  }

  // ---- the program ----
  let x: number | null = null, y: number | null = null;          // position in the neutral program (mm)
  let ox: number | null = null, oy: number | null = null;        // position as written (unit of the file)
  let zText: string | null = null;                               // last Z as written
  let motion = -1;
  let spinWait = false, ended = false;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.rest) return fail("unknown", i);
    if (!ln.words.length) {
      if (ended) { if (ln.comments.length) return fail("afterEnd", i); continue; }
      out.push(cmt(ln.comments));
      continue;
    }
    if (ended) return fail("afterEnd", i);
    if (ln.words.some(w => "ABCUVW".includes(w.l))) return fail("rotary", i);
    if (has(ln, "G", 20)) return fail("inchInput", i);
    if (has(ln, "G", 91)) return fail("relative", i);

    const isDwell = has(ln, "G", 4);
    if (spinWait && !isDwell) out.push(`G4 P${dwell(def.spinUp, String(def.spinUp))}`);
    spinWait = false;

    // program end
    if (has(ln, "M", 30) || has(ln, "M", 2)) {
      if (ln.words.length !== 1) return fail("unknown", i);
      ended = true;
      if (def.end) def.end.forEach((s, k) => out.push(k === 0 ? withCmt(s, ln.comments) : s));
      else out.push(withCmt(ln.words[0].l + ln.words[0].txt, ln.comments));
      continue;
    }
    // tool change
    if (has(ln, "M", 6)) {
      if (i === firstTool) continue;
      if (!def.toolPause || !def.toolTable) { out.push(src[i]); continue; }
      const r = toolLines(ln, i, zText);
      if (!Array.isArray(r)) return { gcode: "", error: r };
      out.push(...r);
      continue;
    }
    // dwell
    if (isDwell) {
      const p = word(ln, "P");
      if (!p || ln.words.length !== 2 || !(p.v >= 0)) return fail("unknown", i);
      out.push(withCmt(`G4 P${dwell(p.v, p.txt)}`, ln.comments));
      continue;
    }
    // unit and absolute mode: one word alone on its line
    if (ln.words.length === 1 && has(ln, "G", 21)) {
      if (!startHas("{units}")) out.push(o.inch ? withCmt("G20", o.inchNote ? [o.inchNote] : []) : withCmt("G21", ln.comments));
      continue;
    }
    if (ln.words.length === 1 && has(ln, "G", 90)) {
      if (!startHas("G90")) out.push(withCmt("G90", ln.comments));
      continue;
    }

    // everything else: moves, feed, spindle
    let lineMotion = -1;
    for (const w of ln.words) {
      if (w.l === "G") {
        if (!G_KEEP.has(w.v)) return fail("unknown", i);
        if (w.v <= 3) lineMotion = w.v;
      } else if (w.l === "M") {
        if (!M_KEEP.has(w.v)) return fail("unknown", i);
        if ((w.v === 3 || w.v === 4) && def.spinUp > 0) spinWait = true;
      } else if (!"XYZIJFS".includes(w.l)) return fail("unknown", i);
    }
    const wx = word(ln, "X"), wy = word(ln, "Y"), wz = word(ln, "Z"), wi = word(ln, "I"), wj = word(ln, "J");
    const moves = !!(wx || wy || wz);
    if (lineMotion < 0 && moves) { if (motion < 0) return fail("unknown", i); lineMotion = motion; }
    const arc = moves && (lineMotion === 2 || lineMotion === 3);
    if ((wi || wj) && !arc && !(lineMotion >= 2 && !moves)) return fail("arc", i);
    const fullCircleNoAxis = !moves && (lineMotion === 2 || lineMotion === 3) && !!(wi || wj);

    const nx: number | null = wx ? wx.v : x, ny: number | null = wy ? wy.v : y;
    const tx = wx ? len(wx.txt, wx.v) : null, ty = wy ? len(wy.txt, wy.v) : null;
    const nox: number | null = tx !== null ? parseFloat(tx) : ox, noy: number | null = ty !== null ? parseFloat(ty) : oy;
    let iText = wi ? len(wi.txt, wi.v) : null, jText = wj ? len(wj.txt, wj.v) : null;
    let asLine = false;

    if (arc || fullCircleNoAxis) {
      if (x === null || y === null || ox === null || oy === null || nx === null || ny === null || nox === null || noy === null) return fail("arc", i);
      // centre as the neutral program gives it, in the unit of the file
      const k = o.inch ? 1 / MM_PER_INCH : 1;
      let cx = (x + (wi ? wi.v : 0)) * k, cy = (y + (wj ? wj.v : 0)) * k;
      const chordX = nox - ox, chordY = noy - oy, chord = Math.hypot(chordX, chordY);
      if (chord < 1e-12) {
        // start and end are the same point once written: a full circle for every controller
        const was = Math.hypot(nx - x, ny - y);
        if (was > 1e-9) {
          const a0 = Math.atan2(y - (y + (wj ? wj.v : 0)), x - (x + (wi ? wi.v : 0)));
          const a1 = Math.atan2(ny - (y + (wj ? wj.v : 0)), nx - (x + (wi ? wi.v : 0)));
          let sweep = lineMotion === 2 ? a0 - a1 : a1 - a0;
          while (sweep < 0) sweep += Math.PI * 2;
          // it was a short arc, not a circle: too short for the last decimal → straight line (zero length)
          if (sweep < Math.PI) asLine = true;
        }
      } else {
        // centre back onto the line of equal distance to the written start and end
        const mx = (ox + nox) / 2, my = (oy + noy) / 2;
        const ux = -chordY / chord, uy = chordX / chord;
        const along = (cx - mx) * ux + (cy - my) * uy;
        cx = mx + ux * along; cy = my + uy * along;
      }
      if (!asLine) {
        // round I and J so that the two radii differ as little as possible (four candidates)
        const step = Math.pow(10, -ijDec);
        const bi = Math.floor((cx - ox) / step) * step, bj = Math.floor((cy - oy) / step) * step;
        let best = Infinity;
        for (const di of [0, step]) for (const dj of [0, step]) {
          const ci = parseFloat((bi + di).toFixed(ijDec)), cj = parseFloat((bj + dj).toFixed(ijDec));
          const r1 = Math.hypot(ci, cj), r2 = Math.hypot(ox + ci - nox, oy + cj - noy);
          const off = Math.hypot(ox + ci - cx, oy + cj - cy);
          // first the radii, then the nearest to the true centre
          const score = Math.abs(r1 - r2) + off * 1e-3;
          if (score < best) { best = score; iText = fixed(ci, ijDec); jText = fixed(cj, ijDec); }
        }
      }
    }

    const parts: string[] = [];
    let ijDone = false;
    // a line without G0–G3 relies on the line before; written out, so nothing depends on what this file added in between
    if (moves && !ln.words.some(w => w.l === "G" && w.v <= 3)) parts.push(asLine ? "G1" : `G${lineMotion}`);
    for (const w of ln.words) {
      switch (w.l) {
        case "G":
          if (w.v === 21) { if (!startHas("{units}")) parts.push(o.inch ? "G20" : "G21"); }
          else if (asLine && (w.v === 2 || w.v === 3)) parts.push("G1");
          else parts.push("G" + w.txt);
          break;
        case "X": parts.push("X" + tx); break;
        case "Y": parts.push("Y" + ty); break;
        case "Z": zText = len(w.txt, w.v); parts.push("Z" + zText); break;
        case "I": case "J":
          if (asLine || ijDone) break;
          ijDone = true;
          parts.push("I" + (iText ?? fixed(0, ijDec)), "J" + (jText ?? fixed(0, ijDec)));
          break;
        case "F": parts.push("F" + (o.inch ? feedText(w.v / MM_PER_INCH) : w.txt)); break;
        default: parts.push(w.l + w.txt);
      }
    }
    out.push(withCmt(parts.join(" "), ln.comments));
    if (lineMotion >= 0) motion = lineMotion;
    if (moves) { x = nx; y = ny; ox = nox; oy = noy; }
  }
  if (!ended) return fail("noEnd", src.length - 1);

  // ---- line numbers ----
  if (def.lineNumbers > 0) {
    let n = def.lineNumbers;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (!s || s[0] === "%" || s[0] === "(" || s[0] === ";") continue;
      out[i] = `N${n} ${s}`;
      n += def.lineNumbers;
      if (n > 99999) n = def.lineNumbers; // Mach3 reads at most five digits; repeated numbers are allowed
    }
  }
  return { gcode: out.join("\n") + "\n" };
}
