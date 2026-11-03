/**
 * ZAHNRAD-GENERATOR – Fenster (Generatoren): Stirnrad, Zahnstange, Zahnriemenscheibe oder Kettenrad.
 * Stirnrad: Zähnezahl, Modul, Eingriffswinkel, Spiel, Profilverschiebung, auf Wunsch Gegenrad.
 * Zahnstange: gleiche Verzahnung, Zahl der Zähne, Rückenhöhe, auf Wunsch Ritzel. Riemenscheibe: Profil (GT2, HTD, T5),
 * Bordscheiben. Kettenrad: Kettengröße (ISO 606). Räder bekommen Bohrung (rund, Passfedernut, D-Welle) und
 * Erleichterungslöcher. Vorschau zeigt Paare im Eingriff, „Aufs Bett“ legt die Teile nebeneinander (je eine Gruppe).
 * Geometrie: gear.ts (Stirnrad, Bohrung) und drives.ts (Zahnstange, Riemenscheibe, Kettenrad).
 */
import type { MultiPolygon } from "polygon-clipping";
import { app, bedSizeMm } from "./editorState";
import { MM_TO_PIXEL, newId } from "../shapeTransform";
import { toShapes } from "./shapeOps";
import { getLayers } from "../laserLayers";
import { getMachineMode } from "../machineMode";
import { toolForShape } from "../toolLibrary";
import { t } from "../i18n/i18n";
import { gear, keyFor, boreArea, circle, BORE_KINDS, type GearOptions, type BoreKind, type XY } from "../gear";
import { rackOutline, rackPinion, pulleyOD, pulleyArea, sprocketDims, sprocketArea, finishWheel, BELTS, BELT_PROFILES, CHAINS,
  type BeltProfile } from "../drives";

type Kind = "spur" | "rack" | "pulley" | "sprocket";
const KINDS: Kind[] = ["spur", "rack", "pulley", "sprocket"];
interface Opts extends GearOptions { kind: Kind; rackBack: number; belt: BeltProfile; flanges: boolean; chain: string }

const KEY = "cnc_craft_gear";
const DEF: Opts = { kind: "spur", teeth: 20, module: 2, pressureAngle: 20, backlash: 0.1, shift: 0, bore: "round", boreD: 8,
  keyAuto: true, keyW: 3, keyDepth: 1.4, flat: 4.5, holes: 0, pair: false, teeth2: 40, rackBack: 6, belt: "gt2", flanges: false, chain: "08B" };
const NUMS = ["teeth", "module", "pressureAngle", "backlash", "shift", "boreD", "keyW", "keyDepth", "flat", "holes", "teeth2", "rackBack"] as const;

function load(): Opts {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: Opts = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k]))) o[k] = Number(s[k]);
    for (const k of ["keyAuto", "pair", "flanges"] as const) if (typeof s[k] === "boolean") o[k] = s[k];
    if (BORE_KINDS.includes(s.bore)) o.bore = s.bore;
    if (KINDS.includes(s.kind)) o.kind = s.kind;
    if (BELT_PROFILES.includes(s.belt)) o.belt = s.belt;
    if (CHAINS.some(c => c.id === s.chain)) o.chain = s.chain;
    return o;
  } catch { return { ...DEF }; }
}

const f = (v: number, n = 2) => String(Number(v.toFixed(n)));

/** ein fertiges Teil: Fläche um die eigene Mitte, Lage in der Vorschau (im Eingriff) */
interface Part { area: MultiPolygon; at: XY; label: string }
interface Built { parts: Part[]; info: string[]; warn: string[]; minGap: number; din: ReturnType<typeof keyFor> }

const bbox = (m: MultiPolygon, at: XY = [0, 0]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of m) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x + at[0]); x1 = Math.max(x1, x + at[0]); y0 = Math.min(y0, y + at[1]); y1 = Math.max(y1, y + at[1]); }
  return { x0, y0, x1, y1 };
};

function build(o: Opts): Built {
  const din = o.bore === "key" && o.keyAuto ? keyFor(o.boreD) : null;
  const info: string[] = [], warn: string[] = [];
  if (o.kind === "spur") {
    const r = gear(o);
    const g1 = r.gears[0].dims;
    info.push(t("gear.info", { d: f(g1.d), da: f(g1.da), df: f(g1.df), p: f(g1.p) }));
    if (r.gears[1]) { const g2 = r.gears[1].dims; info.push(t("gear.info2", { z: g2.z, d: f(g2.d), a: f(r.centerDist), i: f(g2.z / g1.z, 3) })); }
    if (r.key) info.push(t("gear.keyInfo", { b: f(r.key.b), t2: f(r.key.t2) }) + (din ? " " + t("gear.keyNote", { h: f(din.h) }) : ""));
    warn.push(...r.warnings.map(w => t(w, { x: f(Math.max(0, r.undercutX), 2) })));
    return { parts: r.gears.map((g, i) => ({ area: g.area, at: r.mesh[i], label: `z${g.dims.z} m${f(g.dims.m)}` })), info, warn,
      minGap: Math.min(...r.gears.map(g => g.rootGap)), din };
  }
  const { area: bore, reach, key } = boreArea(o);
  const keyInfo = () => { if (key) info.push(t("gear.keyInfo", { b: f(key.b), t2: f(key.t2) }) + (din ? " " + t("gear.keyNote", { h: f(din.h) }) : "")); };
  const boreWarn = (rim: number) => { if (reach > 0 && reach > rim - 1) warn.push(t("gear.warnBore")); };
  if (o.bore === "key" && o.keyAuto && !din) warn.push(t("gear.warnNoDin"));
  const z = Math.max(o.kind === "pulley" ? 8 : 6, Math.round(o.teeth));
  if (o.kind === "rack") {
    const ro = { module: o.module, pressureAngle: o.pressureAngle, backlash: o.backlash, teeth: z, back: o.rackBack };
    const r = rackOutline(ro);
    const parts: Part[] = [{ area: [[r.pts]], at: [0, 0], label: `rack m${f(o.module)}` }];
    info.push(t("gear.rackInfo", { l: f(r.length, 1), h: f(r.height, 1), p: f(Math.PI * o.module) }));
    let minGap = r.rootGap;
    if (o.pair && o.teeth2 >= 6) {
      const z2 = Math.round(o.teeth2), pin = rackPinion(ro, z2);
      const w = finishWheel([[pin.pts]], bore, reach, o.module * z2 / 2 - 1.25 * o.module, o.holes, o.module);
      parts.push({ area: w.area, at: pin.at, label: `z${z2} m${f(o.module)}` });
      info.push(t("gear.pinionInfo", { z: z2, d: f(o.module * z2), h: f(pin.at[1]) }));
      keyInfo(); boreWarn(o.module * z2 / 2 - 1.25 * o.module);
      if (Math.round(o.holes) >= 3 && !w.holes) warn.push(t("gear.warnHoles"));
      if (z2 < 17) warn.push(t("gear.warnUndercutPinion"));
      minGap = Math.min(minGap, gearRootGapGuess(o.module, z2));
    }
    return { parts, info, warn, minGap, din };
  }
  if (o.kind === "pulley") {
    const b = BELTS[o.belt], od = pulleyOD(o.belt, z), rim = od / 2 - b.depth;
    const w = finishWheel(pulleyArea(o.belt, z), bore, reach, rim, o.holes, 1);
    const parts: Part[] = [{ area: w.area, at: [0, 0], label: `${t("gear.belt." + o.belt)} z${z}` }];
    info.push(t("gear.pulleyInfo", { od: f(od), d: f(z * b.pitch / Math.PI), p: f(b.pitch) }));
    if (o.flanges) {
      // zwei Bordscheiben (2 mm über den Rillen), gleiche Bohrung, ohne Löcher
      for (let i = 0; i < 2; i++) {
        const disc: MultiPolygon = [[circle(0, 0, od / 2 + 2)]];
        parts.push({ area: finishWheel(disc, bore, reach, 0, 0, 1).area, at: [od + 8 + i * (od + 8), 0], label: t("gear.flange") });
      }
      info.push(t("gear.flangeInfo", { d: f(od + 4) }));
    }
    keyInfo(); boreWarn(rim);
    if (Math.round(o.holes) >= 3 && !w.holes) warn.push(t("gear.warnHoles"));
    info.push(t("gear.pulleyNote"));
    return { parts, info, warn, minGap: 2 * b.wBot, din };
  }
  // Kettenrad
  const ch = CHAINS.find(c => c.id === o.chain) ?? CHAINS[0];
  const d = sprocketDims(ch.p, ch.d1, z);
  const w = finishWheel(sprocketArea(ch.p, ch.d1, z), bore, reach, d.df / 2, o.holes, ch.p / 4);
  info.push(t("gear.sprocketInfo", { d: f(d.D), da: f(d.da), df: f(d.df), p: f(ch.p, 3), d1: f(ch.d1) }));
  keyInfo(); boreWarn(d.df / 2);
  if (Math.round(o.holes) >= 3 && !w.holes) warn.push(t("gear.warnHoles"));
  return { parts: [{ area: w.area, at: [0, 0], label: `${ch.id} z${z}` }], info, warn, minGap: 2 * d.ri, din };
}

/** Breite der Zahnlücke am Fuß eines Stirnrads (für die Fräser-Warnung beim Ritzel) */
function gearRootGapGuess(m: number, z: number): number {
  return gear({ ...DEF, teeth: z, module: m, pair: false, bore: "none", holes: 0 }).gears[0].rootGap;
}

function previewSvg(parts: Part[]): string {
  const bs = parts.map(p => bbox(p.area, p.at));
  const x0 = Math.min(...bs.map(b => b.x0)), x1 = Math.max(...bs.map(b => b.x1)), y0 = Math.min(...bs.map(b => b.y0)), y1 = Math.max(...bs.map(b => b.y1));
  if (!isFinite(x0)) return "";
  const pad = Math.max(x1 - x0, y1 - y0) * 0.04 + 1;
  const xy = (x: number, y: number) => `${(x - x0 + pad).toFixed(2)},${(y1 - y + pad).toFixed(2)}`;
  const d = (m: MultiPolygon, c: XY) => m.map(poly => poly.map(rg => rg.map(([x, y], i) => `${i ? "L" : "M"}${xy(x + c[0], y + c[1])}`).join("") + "Z").join("")).join("");
  const sw = Math.max(x1 - x0, y1 - y0) / 400;
  const colors = [["#c98a4b", "#ffd28a"], ["#6f9fd8", "#bcd8ff"], ["#8a8f9c", "#d0d4dc"]];
  const body = parts.map((p, i) => {
    const [cf, cs] = colors[Math.min(i, 2)];
    const [cx, cy] = xy(p.at[0], p.at[1]).split(",");
    return `<path d="${d(p.area, p.at)}" fill="${cf}" fill-rule="evenodd" stroke="${cs}" stroke-width="${sw.toFixed(2)}"/>
      <path d="M${(+cx - sw * 8).toFixed(2)},${cy}h${(sw * 16).toFixed(2)}M${cx},${(+cy - sw * 8).toFixed(2)}v${(sw * 16).toFixed(2)}" stroke="#fff" stroke-width="${sw.toFixed(2)}"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${(x1 - x0 + 2 * pad).toFixed(2)} ${(y1 - y0 + 2 * pad).toFixed(2)}" style="width:100%;height:280px;">${body}</svg>`;
}

export function openGearDialog(log: (s: string) => void, done: () => void) {
  const init = load();
  document.getElementById("gear-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "gear-dialog-overlay";
  ov.className = "dlg-overlay";
  const num = (id: string, key: string, step: string, min: string, unit = "mm") =>
    `<label class="dlg-row"><span>${t(key)}</span><span class="dlg-num"><input id="${id}" type="number" min="${min}" step="${step}"><em>${unit}</em></span></label>`;
  const chk = (id: string, key: string) =>
    `<label class="dlg-row" style="cursor:pointer;"><span>${t(key)}</span><input id="${id}" type="checkbox" style="width:auto;"></label>`;
  const sel = (id: string, key: string, opts: [string, string][]) =>
    `<label class="dlg-row"><span>${t(key)}</span><select id="${id}" style="width:auto;max-width:190px;">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(800px, calc(100vw - 32px));">
      <h3>⚙ ${t("gear.title")}</h3>
      <div class="dlg-hint">${t("gear.desc")}</div>
      <div style="display:grid;grid-template-columns:310px 1fr;gap:12px;align-items:start;">
        <div class="box-fields">
          ${sel("gr-kind", "gear.kind", KINDS.map(k => [k, t("gear.kind." + k)]))}
          <div class="gr-k-pulley">${sel("gr-belt", "gear.belt", BELT_PROFILES.map(b => [b, t("gear.belt." + b)]))}</div>
          <div class="gr-k-sprocket">${sel("gr-chain", "gear.chain", CHAINS.map(c => [c.id, c.id === "bike" ? t("gear.chain.bike") : `${c.id} (${f(c.p, 3)} × ${f(c.d1)} mm)`]))}</div>
          <label class="dlg-row"><span id="gr-z-lbl">${t("gear.teeth")}</span><span class="dlg-num"><input id="gr-z" type="number" min="6" step="1"><em></em></span></label>
          <div class="gr-k-spur gr-k-rack">
            ${num("gr-m", "gear.module", "0.1", "0.2")}
            ${num("gr-a", "gear.angle", "0.5", "10", "°")}
            ${num("gr-bl", "gear.backlash", "0.02", "0")}
          </div>
          <div class="gr-k-spur">${num("gr-x", "gear.shift", "0.05", "-1", "× m")}</div>
          <div class="gr-k-rack">${num("gr-back", "gear.rackBack", "0.5", "1")}</div>
          <div class="gr-k-pulley">${chk("gr-fl", "gear.flanges")}</div>
          <div class="gr-k-spur gr-k-rack">
            <label class="dlg-row" style="cursor:pointer;"><span id="gr-pair-lbl">${t("gear.pair")}</span><input id="gr-pair" type="checkbox" style="width:auto;"></label>
            <div class="gr-only-pair">${num("gr-z2", "gear.teeth2", "1", "6", "")}</div>
          </div>
          <div class="gr-wheel">
            ${sel("gr-bore", "gear.bore", BORE_KINDS.map(v => [v, t("gear.bore." + v)]))}
            <div class="gr-only-bore">${num("gr-d", "gear.boreD", "0.1", "1")}</div>
            <div class="gr-only-key">
              ${chk("gr-kauto", "gear.keyAuto")}
              ${num("gr-kw", "gear.keyW", "0.1", "0.5")}
              ${num("gr-kt", "gear.keyDepth", "0.1", "0.2")}
            </div>
            <div class="gr-only-flat">${num("gr-flat", "gear.flat", "0.1", "0.5")}</div>
            ${num("gr-holes", "gear.holes", "1", "0", "")}
          </div>
        </div>
        <div class="box-prev" style="min-height:300px;"><div id="gr-svg" style="flex:1;display:flex;align-items:center;"></div>
          <div id="gr-info" class="dlg-hint"></div><div id="gr-warn" class="dlg-hint" style="color:var(--lt-amber, #ffb454);"></div></div>
      </div>
      <div class="dlg-buttons">
        <button id="gr-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="gr-ok" class="btn-primary">✔ ${t("gear.place")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const ids: [string, (typeof NUMS)[number]][] = [["gr-z", "teeth"], ["gr-m", "module"], ["gr-a", "pressureAngle"], ["gr-bl", "backlash"],
    ["gr-x", "shift"], ["gr-d", "boreD"], ["gr-kw", "keyW"], ["gr-kt", "keyDepth"], ["gr-flat", "flat"], ["gr-holes", "holes"], ["gr-z2", "teeth2"],
    ["gr-back", "rackBack"]];
  for (const [id, k] of ids) $(id).value = String(init[k]);
  $<HTMLSelectElement>("gr-kind").value = init.kind;
  $<HTMLSelectElement>("gr-belt").value = init.belt;
  $<HTMLSelectElement>("gr-chain").value = init.chain;
  $<HTMLSelectElement>("gr-bore").value = init.bore;
  $("gr-kauto").checked = init.keyAuto;
  $("gr-pair").checked = init.pair;
  $("gr-fl").checked = init.flanges;

  const read = (): Opts => {
    const n = (id: string, d: number, min: number, max: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
    return {
      kind: $<HTMLSelectElement>("gr-kind").value as Kind, belt: $<HTMLSelectElement>("gr-belt").value as BeltProfile,
      chain: $<HTMLSelectElement>("gr-chain").value, flanges: $("gr-fl").checked, rackBack: n("gr-back", DEF.rackBack, 1, 200),
      teeth: Math.round(n("gr-z", DEF.teeth, 6, 300)), module: n("gr-m", DEF.module, 0.2, 50), pressureAngle: n("gr-a", DEF.pressureAngle, 10, 35),
      backlash: n("gr-bl", DEF.backlash, 0, 5), shift: n("gr-x", 0, -1, 1.5),
      bore: $<HTMLSelectElement>("gr-bore").value as BoreKind, boreD: n("gr-d", DEF.boreD, 1, 500),
      keyAuto: $("gr-kauto").checked, keyW: n("gr-kw", DEF.keyW, 0.5, 100), keyDepth: n("gr-kt", DEF.keyDepth, 0.2, 50),
      flat: n("gr-flat", DEF.flat, 0.5, 500), holes: Math.round(n("gr-holes", 0, 0, 12)),
      pair: $("gr-pair").checked, teeth2: Math.round(n("gr-z2", DEF.teeth2, 6, 300))
    };
  };

  let last: Built | null = null;
  const update = () => {
    const o = read();
    const show = (sel: string, on: boolean) => ov.querySelectorAll<HTMLElement>(sel).forEach(el => { el.style.display = on ? "" : "none"; });
    for (const k of KINDS) show(".gr-k-" + k, false);
    show(".gr-k-" + o.kind, true);
    // Bohrung: bei Zahnstange nur fürs Ritzel
    const wheel = o.kind !== "rack" || o.pair;
    show(".gr-wheel", wheel);
    show(".gr-only-bore", o.bore !== "none"); show(".gr-only-key", o.bore === "key"); show(".gr-only-flat", o.bore === "dflat"); show(".gr-only-pair", o.pair);
    $<HTMLElement>("gr-z-lbl").textContent = t(o.kind === "rack" ? "gear.rackTeeth" : "gear.teeth");
    $<HTMLElement>("gr-pair-lbl").textContent = t(o.kind === "rack" ? "gear.pairPinion" : "gear.pair");
    // DIN-Maße in die Felder schreiben (gesperrt), damit man sieht, was verwendet wird
    const din = o.bore === "key" && o.keyAuto ? keyFor(o.boreD) : null;
    $("gr-kw").disabled = $("gr-kt").disabled = !!din;
    if (din) { $("gr-kw").value = String(din.b); $("gr-kt").value = String(din.t2); }
    const b = build(o);
    last = b;
    $<HTMLElement>("gr-svg").innerHTML = previewSvg(b.parts);
    $<HTMLElement>("gr-info").innerHTML = b.info.map(s => `<div>${s}</div>`).join("");
    const warn = [...b.warn];
    if (getMachineMode() === "mill") {
      const tool = toolForShape(null);
      if (tool && tool.diameter > b.minGap) warn.push(t("gear.warnTool", { gap: f(b.minGap), tool: f(tool.diameter) }));
      warn.push(t(o.bore === "key" && wheel ? "gear.millNoteKey" : "gear.millNote"));
    }
    $<HTMLElement>("gr-warn").innerHTML = warn.map(s => `<div>${s}</div>`).join("");
    $<HTMLButtonElement>("gr-ok").disabled = !b.parts[0]?.area.length;
  };
  ov.querySelectorAll("input, select").forEach(i => i.addEventListener(i.tagName === "SELECT" || (i as HTMLInputElement).type === "checkbox" ? "change" : "input", update));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("gr-cancel").onclick = close;
  $<HTMLElement>("gr-ok").onclick = () => {
    update();
    const b = last;
    if (!b || !b.parts[0]?.area.length) return;
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    close();
    placeParts(b.parts);
    log(t("gear.placed", { n: b.parts.length, what: t("gear.kind." + o.kind) }));
    done();
  };
  setTimeout(() => { const i = $("gr-z"); i.focus(); i.select(); }, 0);
}

/** Teile nebeneinander (5 mm Abstand) in die Bettmitte, je Teil eine Gruppe */
function placeParts(parts: Part[]) {
  const st = app();
  const bed = bedSizeMm();
  const gap = 5;
  const bs = parts.map(p => bbox(p.area));
  const total = bs.reduce((s, b) => s + (b.x1 - b.x0), 0) + gap * (parts.length - 1);
  const cutL = getLayers().filter(l => l.mode === "line").sort((a, c) => c.power - a.power)[0];
  let x = bed.w / 2 - total / 2;
  const made: any[] = [];
  parts.forEach((p, i) => {
    const b = bs[i];
    const dx = x - b.x0, dy = bed.h / 2 - (b.y0 + b.y1) / 2;
    x += b.x1 - b.x0 + gap;
    const px: MultiPolygon = p.area.map(poly => poly.map(rg => rg.map(([gx, gy]) => [(gx + dx) * MM_TO_PIXEL, (gy + dy) * MM_TO_PIXEL] as [number, number])));
    const groupId = "gear-" + newId(), source = p.label.slice(0, 40);
    made.push(...toShapes(px, cutL ? { laserLayerId: cutL.id } : {}).map(s => ({ ...s, groupId, source })));
  });
  st.shapes = [...st.shapes, ...made];
  st.selectedShapeIds = made.map(s => s.id);
}
