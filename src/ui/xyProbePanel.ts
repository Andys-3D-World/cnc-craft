/**
 * X/Y ANTASTEN im Abschnitt „Antasten“ (Reiter „Maschine“, Fräse mit GRBL) – Ablauf in xyProbe.ts
 *
 * Steht im Seitenbereich und nicht in einem Fenster: so bleiben die Fahr-Knöpfe erreichbar, mit denen man die Spitze
 * vor jeder Messung selbst hinstellt. Gestartet wird erst nach einer Rückfrage, die sagt, was die Maschine fährt.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT } from "../machine";
import { guard, step, xyIO, abortProbe, settled, freshStatus } from "../probe";
import { holdSupported } from "../holdJogLogic";
import {
  cleanXY, Corner, probeEdge, probeHole, probeInnerCorner, probeOuterCorner, Sides, sidesCentre, SIDE_OF, XYDir, XYFail, XYIO, XYOpts, XY_LIMITS, zeroLine,
} from "../xyProbe";
import { recordXY } from "../xyProbeRec";
import { checkImport, importInApp } from "../importers/importRust";

/**
 * Antasten mit Aufzeichnung: jeder Aufruf geht unverändert an die Maschine. Danach spielt Rust den Ablauf mit den
 * Antworten nach (xyprobe.rs) und vergleicht Fahrten und Ergebnis – nur Vergleich, Rust fährt nichts
 */
async function checked<T>(job: Record<string, unknown>, run: (io: XYIO) => Promise<T>): Promise<T> {
  if (!importInApp()) return run(xyIO);
  const rec = recordXY(xyIO);
  try {
    const r = await run(rec.io);
    checkImport("xy_probe_check", { job, log: rec.log }, { ok: r });
    return r;
  } catch (e) {
    checkImport("xy_probe_check", { job, log: rec.log }, { err: e instanceof XYFail ? e.code : "error" });
    throw e;
  }
}

const KEY = "cnc_craft_xyprobe";
type Kind = "outer" | "inner" | "edge" | "hole" | "part";
const KINDS: Kind[] = ["outer", "inner", "edge", "hole", "part"];
const ICON: Record<Kind, string> = { outer: "◳", inner: "◱", edge: "┃", hole: "◎", part: "▣" };

const o: XYOpts & { kind: Kind; corner: Corner; dir: XYDir; vx: number; vy: number } = { ...cleanXY({}), kind: "outer", corner: { cx: -1, cy: -1 }, dir: "xp", vx: 0, vy: 0 };
try {
  const s = JSON.parse(localStorage.getItem(KEY) || "{}");
  Object.assign(o, cleanXY(s));
  if (importInApp()) checkImport("xy_probe_check", { job: { kind: "clean", o: s ?? null } }, cleanXY(s));
  if (KINDS.includes(s.kind)) o.kind = s.kind;
  for (const k of ["vx", "vy"] as const) if (Number.isFinite(s[k]) && Math.abs(s[k]) < 10000) o[k] = s[k];
} catch { /* Standard */ }
// Ecke und Richtung werden nicht gemerkt: nach dem Start immer vorne links
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ tip: o.tip, side: o.side, search: o.search, along: o.along, kind: o.kind, vx: o.vx, vy: o.vy })); } catch { /* egal */ } };

export function xyProbeHtml(): string {
  const num = (id: string, key: string, step: string, min?: number) =>
    `<div class="prop-row" id="${id}-row" ${tip(key + "Tip")}>${T(key)}<input type="number" id="${id}" data-unit="mm" step="${step}" ${min === undefined ? "" : `min="${min}"`} class="prop-input"></div>`;
  return `
    <div class="pr-sub">${T("xyp.title")}</div>
    <div class="xyp-kinds" role="group">${KINDS.map(k => `<button type="button" class="btn-secondary btn-compact xyp-kind" data-kind="${k}" ${tip("xyp.kind." + k + "Tip")}>${ICON[k]} ${T("xyp.kind." + k)}</button>`).join("")}</div>
    <div id="xyp-draw" class="xyp-draw"></div>
    <div class="tool-scope" id="xyp-hint"></div>
    ${num("xyp-tip", "xyp.tip", "0.01", 0)}
    ${num("xyp-side", "xyp.side", "0.01", 0)}
    ${num("xyp-search", "xyp.search", "1", XY_LIMITS.search[0])}
    ${num("xyp-along", "xyp.along", "1", XY_LIMITS.along[0])}
    <div class="rp-grid2">${num("xyp-vx", "xyp.vx", "1")}${num("xyp-vy", "xyp.vy", "1")}</div>
    <button id="xyp-go" class="btn-secondary" ${tip("xyp.goTip")}>⊕ ${T("xyp.go")}</button>
    <div id="xyp-result" class="tool-scope"></div>
    <button id="xyp-reset" class="btn-secondary btn-compact" style="display:none;">↺ ${T("xyp.reset")}</button>`;
}

export interface XYHost {
  ready(): boolean;
  run(what: () => Promise<boolean>): Promise<void>;
  busy(): boolean;
  log(s: string): void;
}

export function initXyProbe(h: XYHost): () => void {
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as E | null;
  const fields: [string, "tip" | "side" | "search" | "along" | "vx" | "vy"][] = [["xyp-tip", "tip"], ["xyp-side", "side"], ["xyp-search", "search"], ["xyp-along", "along"], ["xyp-vx", "vx"], ["xyp-vy", "vy"]];
  let sides: Sides = {};
  let running = false;
  let result = "", drawn = "", homeAt = "";
  const n = (v: number, d = 2) => v.toFixed(d);

  const draw = () => {
    const box = $<HTMLElement>("xyp-draw");
    // nur bei Änderungen neu zeichnen (refresh läuft bei jedem Statusbericht – sonst ginge ein Klick verloren)
    const sig = JSON.stringify([o.kind, o.corner, o.dir, Object.keys(sides), document.documentElement.lang, t("xyp.kind.hole")]);
    if (!box || sig === drawn) return;
    drawn = sig;
    // Zeichnung von oben: Teil/Tasche als Rechteck, anklickbare Stellen (Ecken bzw. Seiten), Pfeile = Tastrichtung
    const inside = o.kind === "inner" || o.kind === "hole";
    const R = { x0: 60, y0: 26, x1: 160, y1: 94 }; // SVG: y nach unten, „hinten“ ist oben
    const spot = (x: number, y: number, on: boolean, attr: string, label: string) =>
      `<g class="xyp-spot${on ? " on" : ""}" ${attr} role="button" tabindex="0" aria-label="${label}"><circle cx="${x}" cy="${y}" r="13" class="xyp-hit"/><circle cx="${x}" cy="${y}" r="6"/></g>`;
    const arrow = (x: number, y: number, dx: number, dy: number) => `<path class="xyp-arrow" d="M${x} ${y}l${dx * 16} ${dy * 16}m${-dx * 5 - dy * 4} ${-dy * 5 - dx * 4}l${dx * 5 + dy * 4} ${dy * 5 + dx * 4}l${-dx * 5 + dy * 4} ${-dy * 5 + dx * 4}"/>`;
    let spots = "", arrows = "";
    if (o.kind === "outer" || o.kind === "inner") {
      for (const cx of [-1, 1] as const) for (const cy of [-1, 1] as const) {
        const on = o.corner.cx === cx && o.corner.cy === cy, g = o.kind === "outer" ? 13 : -15;
        const ex = cx < 0 ? R.x0 : R.x1, ey = cy < 0 ? R.y1 : R.y0, x = ex + cx * g, y = ey - cy * g;
        spots += spot(x, y, on, `data-corner="${cx},${cy}"`, t(`xyp.corner.${cy < 0 ? "f" : "b"}${cx < 0 ? "l" : "r"}`));
        if (on) arrows += o.kind === "outer" ? arrow(ex + cx * 22, ey + cy * 26, -cx, 0) + arrow(ex - cx * 30, ey - cy * 24, 0, cy) : arrow(x, y, cx, 0) + arrow(x, y, 0, -cy);
      }
    } else if (o.kind === "hole") {
      const x = 110, y = 60;
      spots = spot(x, y, true, "", t("xyp.kind.hole"));
      arrows = arrow(x + 12, y, 1, 0) + arrow(x - 12, y, -1, 0) + arrow(x, y - 10, 0, -1) + arrow(x, y + 10, 0, 1);
    } else {
      const at: [XYDir, number, number, number, number][] = [["xp", R.x0 - 18, 60, 1, 0], ["xn", R.x1 + 18, 60, -1, 0], ["yp", 110, R.y1 + 14, 0, -1], ["yn", 110, R.y0 - 14, 0, 1]];
      for (const [d, x, y, dx, dy] of at) {
        const on = o.dir === d, got = o.kind === "part" && sides[SIDE_OF[d]] !== undefined;
        spots += spot(x, y, on, `data-dir="${d}"`, t("xyp.side." + SIDE_OF[d])) + (got ? `<text x="${x + (dx ? -dx * 22 : 20)}" y="${y + 4}" class="xyp-ok">✓</text>` : "");
        if (on) arrows += arrow(x, y, dx, dy);
      }
    }
    box.innerHTML = `<svg viewBox="0 0 220 120" width="100%" height="120">
      <rect x="1" y="1" width="218" height="118" rx="6" class="${inside ? "xyp-mat" : "xyp-air"}"/>
      <rect x="${R.x0}" y="${R.y0}" width="${R.x1 - R.x0}" height="${R.y1 - R.y0}" rx="${o.kind === "hole" ? 8 : 1}" class="${inside ? "xyp-air" : "xyp-mat"}"/>
      ${arrows}${spots}</svg>`;
  };

  const refresh = () => {
    document.querySelectorAll<HTMLElement>(".xyp-kind").forEach(b => { const on = b.dataset.kind === o.kind; b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on)); });
    const show = (id: string, on: boolean) => { const el = $<HTMLElement>(id); if (el) el.style.display = on ? "" : "none"; };
    show("xyp-side-row", o.kind === "outer" || o.kind === "edge" || o.kind === "part");
    show("xyp-along-row", o.kind === "outer");
    show("xyp-vx-row", o.kind !== "edge" || o.dir[0] === "x");
    show("xyp-vy-row", o.kind !== "edge" || o.dir[0] === "y");
    show("xyp-reset", o.kind === "part" && Object.keys(sides).length > 0 && !running);
    for (const [id, k] of fields) { const el = $(id); if (el && document.activeElement !== el) el.value = String(o[k]); }
    const hint = $<HTMLElement>("xyp-hint");
    if (hint) hint.textContent = t("xyp.hint." + o.kind);
    const res = $<HTMLElement>("xyp-result");
    if (res) res.textContent = result;
    const go = $<HTMLButtonElement>("xyp-go");
    if (go) {
      go.disabled = !running && (!machine.connected || machine.protocol !== "grbl" || !holdSupported(machine.protocol, machine.firmware) || h.busy() || machine.job.active);
      const label = running ? "⏹ " + t("xyp.stop") : "⊕ " + t("xyp.go");
      if (go.dataset.label !== label) { go.dataset.label = label; go.textContent = label; } // nicht bei jedem Statusbericht
      go.classList.toggle("btn-danger-outline", running);
    }
    draw();
  };

  const pick = (el: Element | null) => {
    const g = el?.closest(".xyp-spot") as HTMLElement | null;
    if (!g || running) return;
    if (g.dataset.corner) { const [cx, cy] = g.dataset.corner.split(",").map(Number); o.corner = { cx: cx as 1 | -1, cy: cy as 1 | -1 }; }
    if (g.dataset.dir) o.dir = g.dataset.dir as XYDir;
    refresh();
  };
  $<HTMLElement>("xyp-draw")?.addEventListener("click", e => pick(e.target as Element));
  $<HTMLElement>("xyp-draw")?.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e.target as Element); } });
  document.querySelectorAll<HTMLElement>(".xyp-kind").forEach(b => b.addEventListener("click", () => { if (running) return; o.kind = b.dataset.kind as Kind; sides = {}; result = ""; save(); refresh(); }));
  for (const [id, k] of fields) $(id)?.addEventListener("change", () => {
    const v = parseFloat($(id)!.value);
    if (Number.isFinite(v)) { if (k === "vx" || k === "vy") o[k] = Math.max(-9999, Math.min(9999, v)); else o[k] = cleanXY({ ...o, [k]: v })[k]; save(); }
    $(id)!.blur(); refresh();
  });
  $<HTMLButtonElement>("xyp-reset")?.addEventListener("click", () => { sides = {}; result = ""; refresh(); });

  /** Nullpunkt setzen: gemessen wurde found, die Spitze steht still; Versatz aus der frischen Position */
  const setZero = async (found: { x?: number; y?: number }, val: { x: number; y: number }): Promise<boolean> => {
    if (!await settled()) return false;
    await freshStatus();
    const pos = { x: machine.status.mpos[0], y: machine.status.mpos[1] };
    const line = zeroLine(pos, found, val);
    if (importInApp()) checkImport("xy_probe_check", { job: { kind: "zero", pos, found, val } }, line);
    return !!line && await step("G21") && await step(line);
  };

  const what = async (): Promise<boolean> => {
    const val = { x: o.vx, y: o.vy };
    const opts: XYOpts = { tip: o.tip, side: o.side, search: o.search, along: o.along };
    if (o.kind === "outer" || o.kind === "inner") {
      const corner = { ...o.corner }, kind = o.kind;
      const r = await checked({ kind, corner, opts }, io => kind === "outer" ? probeOuterCorner(io, corner, opts) : probeInnerCorner(io, corner, opts));
      if (!await setZero(r, val)) return false;
      result = t("xyp.doneCorner", { x: n(o.vx), y: n(o.vy) });
    } else if (o.kind === "hole") {
      const r = await checked({ kind: "hole", opts }, io => probeHole(io, opts));
      if (!await setZero(r, val)) return false;
      result = t("xyp.doneHole", { w: n(r.w), h: n(r.h), x: n(o.vx), y: n(o.vy) });
    } else {
      const dir = o.dir;
      const e = await checked({ kind: "edge", dir, opts }, io => probeEdge(io, dir, opts));
      const isX = o.dir[0] === "x";
      if (o.kind === "edge") {
        if (!await setZero(isX ? { x: e } : { y: e }, val)) return false;
        result = t("xyp.doneEdge", { axis: isX ? "X" : "Y", v: n(isX ? o.vx : o.vy) });
      } else {
        // neu referenziert: die alten Maschinen-Koordinaten gelten nicht mehr
        if (homeAt !== machine.homeState) sides = {};
        homeAt = machine.homeState;
        sides[SIDE_OF[o.dir]] = e;
        const c = sidesCentre(sides);
        if (importInApp()) checkImport("xy_probe_check", { job: { kind: "sides", s: { ...sides } } }, c);
        // sobald zwei gegenüberliegende Seiten da sind, ist diese Achse fertig
        const done = isX ? c.x : c.y;
        if (done !== undefined && !await setZero(isX ? { x: c.x } : { y: c.y }, val)) return false;
        if (done === undefined && (isX ? sides.left !== undefined && sides.right !== undefined : sides.front !== undefined && sides.back !== undefined)) {
          delete sides[SIDE_OF[o.dir]];
          throw new XYFail("size");
        }
        result = done === undefined ? t("xyp.sideOk", { side: t("xyp.side." + SIDE_OF[o.dir]) })
          : t("xyp.doneMid", { axis: isX ? "X" : "Y", w: n((isX ? c.w : c.h)!), v: n(isX ? o.vx : o.vy) });
        // nächste noch fehlende Seite vorschlagen
        const next = (["xp", "xn", "yp", "yn"] as XYDir[]).find(d => sides[SIDE_OF[d]] === undefined);
        if (next) o.dir = next;
      }
    }
    h.log("[X/Y] " + result);
    return true;
  };

  $<HTMLButtonElement>("xyp-go")?.addEventListener("click", () => {
    if (running) { abortProbe(true); return; }
    if (!h.ready()) return;
    if (!holdSupported(machine.protocol, machine.firmware)) { h.log(t("pr.grblOnly")); return; }
    // Spindel läuft: ein drehender Fräser darf nirgends angetastet werden
    if (machine.status.acc !== null ? /[SC]/.test(machine.status.acc) : machine.status.spindle > 0) { h.log(t("xyp.spindleOn")); return; }
    const key = o.kind === "outer" ? "xyp.confirm.outer" : o.kind === "inner" ? "xyp.confirm.inner" : o.kind === "hole" ? "xyp.confirm.hole" : "xyp.confirm.edge";
    if (!window.confirm(t(key, { s: o.search, a: o.along, tip: o.tip, where: o.kind === "outer" || o.kind === "inner" ? t(`xyp.corner.${o.corner.cy < 0 ? "f" : "b"}${o.corner.cx < 0 ? "l" : "r"}`) : t("xyp.side." + SIDE_OF[o.dir]) }) + "\n\n" + t("xyp.confirm.z"))) return;
    running = true; result = t("xyp.running"); refresh();
    void h.run(async () => {
      guard.own = true;
      try { return await what(); }
      catch (e) {
        result = e instanceof XYFail ? t("xyp.err." + e.code) : String(e);
        h.log("[X/Y] " + result);
        return false;
      } finally { guard.own = false; }
    }).finally(() => { running = false; refresh(); });
  });

  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    // Maschinen-Koordinaten gelten danach nicht mehr: gemerkte Seiten verwerfen
    if (type === "disconnected" || type === "switched" || type === "welcome") { sides = {}; if (!running) result = ""; refresh(); }
    if (type === "state" && /^(Alarm|Home)/.test(machine.status.state)) { sides = {}; refresh(); }
  });
  window.addEventListener("cnc-language-changed", refresh);
  refresh();
  return refresh;
}
