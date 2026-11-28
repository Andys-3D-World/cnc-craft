/**
 * LANGE PLATTE (Fräse): das Programm der Zeichnung in Abschnitte teilen, mit Passstiften zum Weiterschieben.
 * Gerechnet wird in longBoard.ts. Jeder Abschnitt wird einzeln als Auftrag geladen oder gespeichert; gestartet wird nichts.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t, ascii, tMm } from "../i18n/i18n";
import { state } from "../main";
import { isMill } from "../machineMode";
import { rotary } from "../rotary";
import { twoSidedOn } from "../editor/beds";
import { bedSizeMm } from "../editor/editorState";
import { getTools, MillingTool, DEFAULT_PLUNGE, toolForShape, cutDiameter, toolNumber } from "../toolLibrary";
import { probeSettings } from "../probe";
import { expandOps } from "../ops";
import { generateGcode, generateGcodeFull, type GcodeResult } from "../cam";
import { spindleCode } from "../spindleDir";
import { toolChangeGcode } from "../toolChange";
import { postCtx } from "../post/postContext";
import { loadGcodeFromText } from "../machineStream";
import { withPost, postedText, postFileName, postExtensions } from "../post/postExport";
import { Axis, checkLong, cutBounds, holeLines, LongOpts, pinHits, Section, sections, SplitProgram, splitProgram, unsupported } from "../longBoard";
import { checkImport, importInApp } from "../importers/importRust";

const KEY = "cnc_craft_longboard", SAFE_Z = 5.0;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** ganzes Programm der Zeichnung, ohne Nachmess-Punkte und Sperrzonen (die gehören zum Bett, nicht zur Platte) */
function wholeProgram(): Promise<GcodeResult> {
  const dr = probeSettings.drOn;
  probeSettings.drOn = 0;
  // die Einstellung gilt, solange der G-Code entsteht – das geschieht sofort (vor dem ersten Warten), die Antwort kommt später
  try { return generateGcodeFull((state.shapes as any[]).filter(s => !s.keepOut), { preview: true }); } finally { probeSettings.drOn = dr; }
}

/** dasselbe ohne Warten (cam.ts allein): beim Speichern für eine andere Steuerung, mitten in withPost() */
function wholeProgramNow(): string | null {
  const dr = probeSettings.drOn;
  probeSettings.drOn = 0;
  try { return generateGcode((state.shapes as any[]).filter(s => !s.keepOut)); } finally { probeSettings.drOn = dr; }
}

export async function openLongBoard(log: (s: string) => void) {
  if (!isMill()) { log(t("deco.onlyMill")); return; }
  if (rotary.on || twoSidedOn()) { log(t("long.notHere")); return; }
  const whole = await wholeProgram(), full = whole.gcode;
  if (!full) { log(whole.warnings[0] || t("gcw.noObjects")); return; }
  const lines = full.split("\n"), bad = unsupported(lines), bounds = cutBounds(lines);
  if (bad || !bounds) { log(t("long.unsupported", { g: bad || "?" })); return; }
  const warnings = whole.warnings.slice(), hadZones = (state.shapes as any[]).some(s => s.keepOut);
  const bed = bedSizeMm(), tools = getTools().filter(x => x.type === "drill" || x.type === "endmill" || x.type === "bullnose");
  if (!tools.length) { log(t("face.noTool")); return; }
  const maxR = Math.max(...expandOps(state.shapes as any[]).map((s: any) => { const x = toolForShape(s); return x ? cutDiameter(x) / 2 : 1.5; }));

  const o = { axis: (bounds.x1 - bounds.x0) / bed.w > (bounds.y1 - bounds.y0) / bed.h ? "x" : "y", start: 20, shift: 0, overlap: 5, pinD: 6, p1: 0, p2: 0, pa: 10, thick: 18, spoil: 10, tool: "" };
  const bedLen = () => (o.axis === "x" ? bed.w : bed.h), bedWide = () => (o.axis === "x" ? bed.h : bed.w);
  const autoPos = () => {
    const c0 = o.axis === "x" ? bounds.y0 : bounds.x0, c1 = o.axis === "x" ? bounds.y1 : bounds.x1, off = o.pinD / 2 + maxR + 4;
    o.shift = Math.max(20, Math.floor((bedLen() - o.start - o.overlap - 12) / 5) * 5);
    o.pa = 10;
    o.p1 = +Math.max(o.pinD, c0 - off).toFixed(1); o.p2 = +Math.min(bedWide() - o.pinD, c1 + off).toFixed(1);
  };
  autoPos();
  try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); for (const k of ["overlap", "pinD", "thick", "spoil"] as const) if (Number.isFinite(s[k]) && s[k] > 0) o[k] = s[k]; if (tools.some(x => x.id === s.tool)) o.tool = s.tool; } catch { /* Standard */ }
  autoPos();
  const fits = (x: MillingTool) => (x.type === "drill" ? Math.abs(x.diameter - o.pinD) <= 0.05 : x.diameter <= o.pinD + 0.01);
  if (!tools.some(x => x.id === o.tool && fits(x))) o.tool = (tools.find(x => x.type === "drill" && fits(x)) || tools.filter(fits).sort((a, b) => b.diameter - a.diameter)[0] || tools[0]).id;
  const pinTool = () => tools.find(x => x.id === o.tool) || tools[0];

  const num = (id: string, label: string, step = "1", tipKey = "") => `<div class="dlg-row"${tipKey ? ` data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(label))}</span><span class="dlg-num"><input id="${id}" type="number" step="${step}" class="prop-input"><em>mm</em></span></div>`;
  document.getElementById("long-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "long-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(1040px, calc(100vw - 32px));">
      <h3>📐 ${esc(t("long.title"))}</h3>
      <div class="dlg-hint">${esc(t("long.intro"))}</div>
      <div class="c3d-grid">
        <div class="c3d-form">
          <div class="dlg-row"><span>${esc(t("long.axis"))}</span><select id="lb-axis" class="prop-input" style="width:auto;"><option value="x">X</option><option value="y">Y</option></select></div>
          ${num("lb-shift", "long.shift", "1", "long.shiftTip")}${num("lb-start", "long.start", "1", "long.startTip")}${num("lb-overlap", "long.overlap", "0.5", "long.overlapTip")}
          <div class="c3d-sec">${esc(t("long.pins"))}</div>
          ${num("lb-pind", "long.pinD", "0.1")}${num("lb-pa", "long.pinAlong", "1", "long.pinAlongTip")}${num("lb-p1", "long.pin1")}${num("lb-p2", "long.pin2")}
          ${num("lb-thick", "long.thick", "0.5")}${num("lb-spoil", "long.spoil", "0.5", "long.spoilTip")}
          <div class="dlg-row"><span>${esc(t("long.pinTool"))}</span><select id="lb-tool" class="prop-input" style="width:170px;"></select></div>
          <div class="dlg-hint" id="lb-warn" style="color:var(--lt-amber, #ffb454);white-space:pre-line;"></div>
        </div>
        <div>
          <canvas id="lb-cv" width="900" height="420" style="width:100%;border-radius:6px;display:block;background:#16161c;"></canvas>
          <div id="lb-list" style="margin-top:8px;display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;"></div>
          <ol class="dlg-hint" style="margin:8px 0 0 18px;padding:0;">${[1, 2, 3, 4, 5].map(i => `<li>${esc(t("long.step" + i))}</li>`).join("")}</ol>
        </div>
      </div>
      <div class="dlg-buttons"><button id="lb-close" class="btn-secondary" style="margin-left:auto;">${esc(t("dlg.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const fields: [string, "shift" | "start" | "overlap" | "pinD" | "pa" | "p1" | "p2" | "thick" | "spoil", number, number][] = [["lb-shift", "shift", 1, 10000], ["lb-start", "start", 0, 2000], ["lb-overlap", "overlap", 0.5, 50],
    ["lb-pind", "pinD", 1, 30], ["lb-pa", "pa", 0, 10000], ["lb-p1", "p1", -1000, 10000], ["lb-p2", "p2", -1000, 10000], ["lb-thick", "thick", 0.5, 200], ["lb-spoil", "spoil", 1, 60]];

  const long = (): LongOpts => ({ axis: o.axis as Axis, bed: bedLen(), start: o.start, shift: o.shift, overlap: o.overlap, pinD: o.pinD,
    pins: [o.p1, o.p2].map(c => (o.axis === "x" ? { x: o.pa, y: c } : { x: c, y: o.pa })) });
  const c = (k: string, v?: Record<string, string | number>) => `(${ascii(tMm(k, v))})`;
  const toolPrefix = ascii(tMm("gc.tool", { name: "@", d: "0" })).split("@")[0];
  const load = (x: MillingTool) => (postCtx.toolTable ? [toolChangeGcode(toolNumber(x), c("gc.toolLoad", { i: 1, name: x.name, d: x.diameter.toFixed(1) }))] : []);
  const startTool = (x: MillingTool) => [...load(x), c("gc.tool", { name: x.name, d: x.diameter.toFixed(1) }), `${spindleCode("M3")} S${Math.round(x.rpm || 12000)} ${c("gc.spindleOn", { rpm: Math.round(x.rpm || 12000) })}`, `G4 P3 ${c("gc.spinUp")}`];
  const head = (title: string) => [`(${ascii(title)})`, `G21 ${c("gc.unitMm")}`, `G90 ${c("gc.absolute")}`, "G17", `G0 Z${SAFE_Z.toFixed(3)} ${c("gc.safeZ")}`];
  const foot = () => [`M5 ${c("gc.spindleOff")}`, `G0 X0 Y0 ${c("gc.park")}`, `M30 ${c("gc.end")}`];
  const holes = (shift: number) => long().pins.map(p => (o.axis === "x" ? { x: p.x + shift, y: p.y } : { x: p.x, y: p.y + shift }));
  const drillPins = (at: { x: number; y: number }[], depth: number): string[] => {
    const x = pinTool();
    return holeLines(at, o.pinD, depth, { drill: x.type === "drill", diameter: x.diameter, feed: x.feedrate || 800, plunge: x.plungeFeed ?? DEFAULT_PLUNGE, stepZ: x.stepZ || 1 }, SAFE_Z);
  };

  let secs: Section[] = [], parts: SplitProgram[] = [], okAll = false;
  const spoilProgram = () => [...head(tMm("long.gcSpoil")), ...startTool(pinTool()), ...drillPins(long().pins, o.spoil), ...foot()].join("\n") + "\n";
  /** Teilprogramm; beim Speichern für eine andere Steuerung neu gerechnet (dort schreibt cam.ts z. B. Werkzeugnummern) */
  const part = (k: number): SplitProgram => (postCtx.foreign ? splitProgram((wholeProgramNow() || "").split("\n"), o.axis as Axis, secs[k], SAFE_Z, toolPrefix, postCtx.toolTable) : parts[k]);
  const program = (k: number): string => {
    const p = part(k), last = k === secs.length - 1;
    const out = head(tMm("long.gcHead", { k: k + 1, n: secs.length, s: o.shift }));
    if (!last) {
      out.push(c("long.gcHoles"), ...startTool(pinTool()), ...drillPins(holes(o.shift), o.thick + 0.5));
      if (p.cuts && !p.firstTool.startsWith(ascii(tMm("gc.tool", { name: pinTool().name, d: pinTool().diameter.toFixed(1) })))) {
        out.push(`M5 ${c("gc.spindleOff")}`);
        if (!postCtx.toolTable) {
          const next = p.firstTool.slice(toolPrefix.length).trim(), cut = next.lastIndexOf(", "), name = cut > 0 ? next.slice(0, cut) : next, d = /[\d.]+/.exec(next.slice(cut))?.[0] ?? "";
          const nt = getTools().find(x => ascii(x.name).trim() === name);
          out.push(toolChangeGcode(nt ? toolNumber(nt) : 0, c("gc.toolChange", { i: 2, name, d })));
        }
      }
    }
    // nach dem ersten Einschalten immer warten, bis die Spindel läuft
    const body = p.lines.slice(), on = body.findIndex(l => /^M0?[34]\b/.test(l.trim()));
    if (on >= 0 && !/^G0?4\b/.test((body[on + 1] || "").trim())) body.splice(on + 1, 0, `G4 P3 ${c("gc.spinUp")}`);
    return [...out, ...body, ...foot()].join("\n") + "\n";
  };

  let rustChecked = false;
  const refresh = () => {
    for (const [id, k] of fields) if (document.activeElement !== $(id)) $(id).value = String(o[k]);
    $<HTMLSelectElement>("lb-axis").value = o.axis;
    $<HTMLSelectElement>("lb-tool").innerHTML = tools.map(x => `<option value="${esc(x.id)}"${x.id === o.tool ? " selected" : ""}${fits(x) ? "" : " disabled"}>${esc(x.name)} · Ø${x.diameter}</option>`).join("");
    const L = long(), min = o.axis === "x" ? bounds.x0 : bounds.y0, max = o.axis === "x" ? bounds.x1 : bounds.y1;
    const errs = checkLong(L, min, max), warn: string[] = [];
    secs = errs.includes("shift") ? [] : sections(L, max);
    parts = secs.map(s => splitProgram(lines, L.axis, s, SAFE_Z, toolPrefix));
    const cross = o.axis === "x" ? [bounds.y0, bounds.y1] : [bounds.x0, bounds.x1];
    const wide = cross[0] < -1e-6 || cross[1] > bedWide() + 1e-6, pinWide = [o.p1, o.p2].some(v => v - o.pinD / 2 < 0 || v + o.pinD / 2 > bedWide());
    if (wide) warn.push(t("long.warnWide", { w: bedWide() }));
    if (pinWide) warn.push(t("long.err.pinOut", { b: bedWide() }));
    for (const e of errs) warn.push(t("long.err." + e, { b: bedLen() }));
    if (!fits(pinTool())) warn.push(t("long.err.tool"));
    let hard = errs.length > 0 || wide || pinWide || !fits(pinTool());
    const keep = o.pinD / 2 + maxR + 1;
    // once per dialog: the same in Rust (longboard.rs), in the background; the sections in use stay the TypeScript ones
    if (!rustChecked && importInApp()) {
      rustChecked = true;
      const hl = holes(o.shift), x = pinTool(), depth = o.thick + 0.5;
      const holeTool = { drill: x.type === "drill", diameter: x.diameter, feed: x.feedrate || 800, plunge: x.plungeFeed ?? DEFAULT_PLUNGE, stepZ: x.stepZ || 1 };
      checkImport("long_board", { job: { text: full, opts: L, min, max, safeZ: SAFE_Z, toolPrefix, keepM6: false, keep, holes: hl, holeTool, holeDepth: depth } }, {
        bad, bounds, errs, secs, parts, hits: parts.map(p => ({ pins: pinHits(p.trace, L.pins, keep), holes: pinHits(p.trace, hl, keep) })),
        holeLines: holeLines(hl, o.pinD, depth, holeTool, SAFE_Z)
      });
    }
    parts.forEach((p, k) => {
      if (k > 0 && pinHits(p.trace, L.pins, keep).length) { hard = true; warn.push(t("long.hitPin", { k: k + 1 })); }
      if (k < parts.length - 1 && pinHits(p.trace, holes(o.shift), keep).length) { hard = true; warn.push(t("long.hitHole", { k: k + 1 })); }
    });
    if (secs.length === 1 && !errs.length) warn.push(t("long.fitsAnyway"));
    if (hadZones) warn.push(t("long.zones"));
    warn.push(...warnings.slice(0, 4));
    okAll = !hard;
    $<HTMLElement>("lb-warn").textContent = warn.map(x => "⚠ " + x).join("\n");
    // Liste
    const list = $<HTMLElement>("lb-list");
    list.textContent = "";
    const row = (label: string, info: string, make: () => string, file: string, ok: boolean) => {
      const r = document.createElement("div");
      r.className = "dlg-row";
      const tx = document.createElement("span"); const b = document.createElement("b"); b.textContent = label; const sm = document.createElement("small"); sm.textContent = " " + info; sm.style.color = "var(--text-muted)"; tx.append(b, sm);
      const bt = document.createElement("span"); bt.style.cssText = "display:flex;gap:6px;flex:none;";
      const load = document.createElement("button"); load.type = "button"; load.className = "btn-primary btn-compact"; load.textContent = t("c3d.load"); load.disabled = !ok;
      load.onclick = () => { if (okAll && loadGcodeFromText(make(), label, log)) log(t("long.loaded", { name: label })); };
      const sv = document.createElement("button"); sv.type = "button"; sv.className = "btn-secondary btn-compact"; sv.textContent = "💾"; sv.setAttribute("aria-label", t("c3d.save")); sv.title = t("c3d.save"); sv.disabled = !ok;
      sv.onclick = async () => {
        if (!okAll) return;
        const text = postedText(withPost(make), log);
        if (text === null) return;
        try { const p = await save({ title: t("rp.saveGcode"), defaultPath: postFileName(file), filters: [{ name: t("stream.dlgFilter"), extensions: postExtensions() }] }); if (p) { await writeFile(p, new TextEncoder().encode(text)); log(t("gcw.saved", { p })); } }
        catch (err) { log(t("gcw.saveError", { e: String(err) })); }
      };
      bt.append(load, sv); r.append(tx, bt); list.append(r);
    };
    if (secs.length > 1) row(t("long.rowSpoil"), t("long.rowSpoilInfo"), spoilProgram, "spoilboard-pins.gcode", okAll);
    secs.forEach((s, k) => {
      const p = parts[k], tool1 = k < secs.length - 1 ? pinTool().name : p.firstTool.slice(toolPrefix.length).replace(/,.*$/, "");
      row(t("long.row", { k: s.n, n: secs.length }), p.cuts || k < secs.length - 1 ? t("long.rowInfo", { tool: tool1, e: p.entries }) : t("long.rowEmpty"), () => program(k), `section-${s.n}.gcode`, okAll && (p.cuts > 0 || k < secs.length - 1));
    });
    draw(L, max);
  };
  const COL = ["#36b3ff", "#34d17b", "#ffd23c", "#c03ce0", "#ff9a3c", "#7ff3ff"];
  const draw = (L: LongOpts, max: number) => {
    const cv = $<HTMLCanvasElement>("lb-cv"), ctx = cv.getContext("2d")!, len = Math.max(max, bedLen()) + 10, wide = Math.max(bedWide(), o.axis === "x" ? bounds.y1 : bounds.x1) + 10;
    // die lange Achse immer waagerecht zeichnen
    const k = Math.min((cv.width - 30) / len, (cv.height - 30) / wide), U = (a: number) => 15 + a * k, V = (b: number) => cv.height - 15 - b * k;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "rgba(200,160,100,0.18)"; ctx.fillRect(U(0), V(wide - 10), (len - 10) * k, (wide - 10) * k);
    secs.forEach((s, i) => { const lo = Math.max(0, s.lo), hi = Math.min(len - 10, s.hi); ctx.fillStyle = COL[i % COL.length] + "22"; ctx.fillRect(U(lo), V(wide - 10), (hi - lo) * k, (wide - 10) * k); });
    parts.forEach((p, i) => {
      ctx.strokeStyle = COL[i % COL.length]; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let q = 1; q < p.trace.length; q += 2) { const a = p.trace[q - 1], b = p.trace[q]; if (Math.min(a.z, b.z) >= 0) continue; const sh = secs[i].shift, A = (m: typeof a) => (o.axis === "x" ? m.x : m.y) + sh, B = (m: typeof a) => (o.axis === "x" ? m.y : m.x); ctx.moveTo(U(A(a)), V(B(a))); ctx.lineTo(U(A(b)), V(B(b))); }
      ctx.stroke();
    });
    // Stifte (gefüllt) und die Löcher, die zu den nächsten Abschnitten gehören (Ringe)
    for (const p of L.pins) for (let i = 0; i < Math.max(1, secs.length); i++) { const a = (o.axis === "x" ? p.x : p.y) + i * o.shift, b = o.axis === "x" ? p.y : p.x; ctx.beginPath(); ctx.arc(U(a), V(b), Math.max(3, o.pinD / 2 * k), 0, 7); if (i === 0) { ctx.fillStyle = "#ff5a5a"; ctx.fill(); } else { ctx.strokeStyle = "#ff5a5a"; ctx.lineWidth = 2; ctx.stroke(); } }
    ctx.strokeStyle = "rgba(255,77,77,0.6)"; ctx.setLineDash([5, 4]); ctx.strokeRect(U(0), V(bedWide()), bedLen() * k, bedWide() * k); ctx.setLineDash([]);
  };
  const keepVals = () => { try { localStorage.setItem(KEY, JSON.stringify({ overlap: o.overlap, pinD: o.pinD, thick: o.thick, spoil: o.spoil, tool: o.tool })); } catch { /* egal */ } };
  let timer = 0;
  const later = () => { keepVals(); clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) refresh(); }, 200); };
  for (const [id, k, lo, hi] of fields) {
    $(id).addEventListener("input", () => { const v = parseFloat($(id).value); if (!Number.isFinite(v) || v < lo || v > hi) return; o[k] = v; okAll = false; later(); });
    $(id).addEventListener("change", () => { $(id).blur(); refresh(); });
  }
  $<HTMLSelectElement>("lb-axis").addEventListener("change", () => { o.axis = $<HTMLSelectElement>("lb-axis").value; autoPos(); refresh(); });
  $<HTMLSelectElement>("lb-tool").addEventListener("change", () => { o.tool = $<HTMLSelectElement>("lb-tool").value; keepVals(); refresh(); });
  const close = () => { clearTimeout(timer); ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $<HTMLButtonElement>("lb-close").onclick = close;
  refresh();
}
