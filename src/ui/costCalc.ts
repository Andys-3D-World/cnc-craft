/**
 * KOSTENRECHNER (Reiter Fräsen/Laser → „Kosten berechnen“)
 *
 * Was kostet das Teil, was sollte es kosten?
 *  - Maschinenzeit: Laufzeit aus dem G-Code (dieselbe Schätzung wie in der Simulation) × Maschinen-Stundensatz
 *  - Material: Fläche (Umriss aller Teile + Rand, oder die ganze Platte) × Preis pro m², plus Verschnitt %
 *  - Arbeit: Einrichten einmal pro Auftrag + Nacharbeit pro Stück, × eigener Stundensatz
 *  - Extras pro Stück (Kleinteile, Verpackung)
 *  - Stückzahl und Aufschlag % → Selbstkosten und Verkaufspreis pro Stück und gesamt
 *  - Preisliste für Material (Name → Preis/m²); beim Laser wird der Eintrag zum Material der benutzten Ebenen
 *    (z. B. „Pappel-Sperrholz 4 mm“) von selbst gewählt
 *  - Mengenrabatt: bis zu 3 Staffeln „ab n Stück → Aufschlag %“
 *  - Export der Aufstellung als CSV (Excel, Rechnungsprogramm)
 * Die Sätze werden gemerkt (localStorage), die Stückzahl auch.
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { layersUsedBy } from "../laserLayers";
import { isLaser } from "../machineMode";
import { t, currentLanguage } from "../i18n/i18n";
import { generateGcode, noGcodeMessage } from "../cam";
import { parseGcodeProgram } from "../sim/gcodeParser";
import { groupBounds, MM_TO_PIXEL } from "../shapeTransform";
import { getStock } from "../stock";

export interface CostOptions {
  machineRate: number;  // €/h Maschine (Strom, Verschleiß, Fräser/Röhre)
  matPrice: number;     // €/m² Material
  matArea: "parts" | "sheet";
  waste: number;        // % Verschnitt auf die Materialfläche
  setupMin: number;     // Minuten Einrichten pro Auftrag
  pieceMin: number;     // Minuten Nacharbeit pro Stück (schleifen, verpacken)
  laborRate: number;    // €/h eigene Arbeit
  extra: number;        // € pro Stück (Kleinteile, Verpackung)
  qty: number;          // Stückzahl
  markup: number;       // % Aufschlag
  currency: string;
  prices: { name: string; price: number }[];  // Material-Preisliste (€/m²)
  matName: string;      // gewählter Eintrag der Preisliste ("" = Preis von Hand)
  tiersOn: boolean;     // Mengenrabatt an
  tiers: { qty: number; markup: number }[];   // ab qty Stück gilt dieser Aufschlag
}

export interface CostResult {
  timeS: number;          // Maschinenzeit für ein Stück (s)
  areaM2: number;         // Materialfläche für ein Stück (m², mit Verschnitt)
  machine: number; material: number; labor: number; extras: number;  // gesamt für alle Stück
  total: number; perPiece: number; pricePiece: number; priceTotal: number;
  markup: number; tier: boolean;   // benutzter Aufschlag, aus einer Mengenrabatt-Staffel?
}

const KEY = "cnc_craft_cost";
const DEF: CostOptions = {
  machineRate: 3, matPrice: 15, matArea: "parts", waste: 15, setupMin: 10, pieceMin: 5,
  laborRate: 20, extra: 0, qty: 1, markup: 30, currency: "€",
  prices: [], matName: "", tiersOn: false,
  tiers: [{ qty: 10, markup: 25 }, { qty: 50, markup: 20 }, { qty: 100, markup: 15 }]
};
const NUMS = ["machineRate", "matPrice", "waste", "setupMin", "pieceMin", "laborRate", "extra", "qty", "markup"] as const;

function load(): CostOptions {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    const o: any = { ...DEF };
    for (const k of NUMS) if (Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) o[k] = Number(s[k]);
    if (s.matArea === "sheet") o.matArea = "sheet";
    if (typeof s.currency === "string" && s.currency.trim()) o.currency = s.currency.trim().slice(0, 4);
    o.qty = Math.max(1, Math.round(o.qty));
    o.prices = Array.isArray(s.prices) ? s.prices
      .filter((x: any) => x && typeof x.name === "string" && x.name.trim() && Number(x.price) >= 0)
      .slice(0, 100).map((x: any) => ({ name: x.name.trim().slice(0, 60), price: Number(x.price) })) : [];
    o.matName = typeof s.matName === "string" && o.prices.some((x: any) => x.name === s.matName) ? s.matName : "";
    o.tiersOn = s.tiersOn === true;
    o.tiers = DEF.tiers.map((d, i) => {
      const x = Array.isArray(s.tiers) ? s.tiers[i] : null;
      return { qty: Number(x?.qty) >= 0 ? Math.round(Number(x.qty)) : d.qty, markup: Number(x?.markup) >= 0 ? Number(x.markup) : d.markup };
    });
    return o;
  } catch { return { ...DEF, prices: [], tiers: DEF.tiers.map(x => ({ ...x })) }; }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Aufschlag für die Stückzahl: größte Staffel, deren „ab“ erreicht ist (0 Stück = Staffel aus) */
export function markupFor(o: Pick<CostOptions, "qty" | "markup" | "tiersOn" | "tiers">): { markup: number; tier: boolean } {
  if (!o.tiersOn) return { markup: o.markup, tier: false };
  let best: { qty: number; markup: number } | null = null;
  for (const x of o.tiers) if (x.qty > 1 && o.qty >= x.qty && (!best || x.qty > best.qty)) best = x;
  return best ? { markup: best.markup, tier: true } : { markup: o.markup, tier: false };
}

/** Kosten aus Laufzeit (s) und Fläche (m² ohne Verschnitt) für ein Stück */
export function calcCost(timeS: number, rawAreaM2: number, o: CostOptions): CostResult {
  const qty = Math.max(1, Math.round(o.qty));
  const areaM2 = rawAreaM2 * (1 + o.waste / 100);
  const machine = timeS / 3600 * o.machineRate * qty;
  const material = areaM2 * o.matPrice * qty;
  const labor = (o.setupMin + o.pieceMin * qty) / 60 * o.laborRate;
  const extras = o.extra * qty;
  const total = machine + material + labor + extras;
  const perPiece = total / qty;
  const m = markupFor(o);
  const pricePiece = perPiece * (1 + m.markup / 100);
  return { timeS, areaM2, machine, material, labor, extras, total, perPiece, pricePiece, priceTotal: pricePiece * qty, markup: m.markup, tier: m.tier };
}

function hms(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : m > 0 ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
}

export function openCostDialog(shapes: any[], log: (s: string) => void) {
  const gcode = generateGcode(shapes, { flat: true });
  if (!gcode) { log(noGcodeMessage()); return; }
  const timeS = parseGcodeProgram(gcode.split("\n")).totalTime;
  // Fläche der Teile: Umriss aller Formen + 5 mm Rand ringsum
  const b = groupBounds(shapes.filter((s: any) => s.type !== "image"));
  const partsM2 = b ? ((b.maxX - b.minX) / MM_TO_PIXEL + 10) * ((b.maxY - b.minY) / MM_TO_PIXEL + 10) / 1e6 : 0;
  const st = getStock();
  const sheetM2 = st.w * st.h / 1e6;
  const init = load();
  // Laser: Material der benutzten Ebenen, z. B. „Pappel-Sperrholz 4 mm“ – passender Eintrag der Preisliste wird gewählt
  const guess = isLaser() ? layersUsedBy(shapes).map(l => [l.material, l.thickness > 0 ? `${+l.thickness.toFixed(2)} mm` : ""].filter(Boolean).join(" ")).find(x => x.trim()) || "" : "";
  if (guess) {
    const g = guess.toLowerCase();
    const hit = init.prices.find(x => x.name.toLowerCase() === g) || init.prices.find(x => x.name.toLowerCase().includes(g) || g.includes(x.name.toLowerCase()));
    if (hit) init.matName = hit.name;
  }
  const sel = init.prices.find(x => x.name === init.matName);
  if (sel) init.matPrice = sel.price;
  const fmt = (v: number) => v.toLocaleString(currentLanguage(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  document.getElementById("cost-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "cost-overlay";
  ov.className = "dlg-overlay";
  // unit "$" = Währung, "$/h" = Währung pro Stunde usw.
  const num = (id: string, key: string, v: number, step: string, unit: string, tipKey = "") => {
    const curUnit = unit.startsWith("$");
    return `<label class="dlg-row" ${tipKey ? `data-tip="${esc(t(tipKey))}"` : ""}><span>${esc(t(key))}</span><span class="dlg-num"><input id="${id}" type="number" min="0" step="${step}" value="${v}"><em ${curUnit ? `data-cur="${esc(unit.slice(1))}"` : ""}>${esc(curUnit ? init.currency + unit.slice(1) : unit)}</em></span></label>`;
  };
  const cur = "$";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:640px;">
      <h3>💶 ${esc(t("cost.title"))}</h3>
      <div class="dlg-hint">${esc(t("cost.desc"))}</div>
      <div class="box-grid" style="grid-template-columns: 290px 1fr;">
        <div class="box-fields">
          <div class="dlg-hint" style="margin:0;"><b>${esc(t("cost.gMachine"))}</b></div>
          ${num("co-mrate", "cost.machineRate", init.machineRate, "0.5", cur + "/h", "cost.machineRateTip")}
          <div class="dlg-hint" style="margin:0;"><b>${esc(t("cost.gMaterial"))}</b></div>
          <label class="dlg-row" data-tip="${esc(t("cost.matListTip"))}"><span>${esc(t("cost.matList"))}</span>
            <select id="co-mat" class="prop-input" style="width:150px;"></select></label>
          ${num("co-mprice", "cost.matPrice", init.matPrice, "0.5", cur + "/m²", "cost.matPriceTip")}
          <div id="co-matsave" style="display:flex;gap:4px;">
            <input id="co-matname" type="text" maxlength="60" class="prop-input" style="flex:1;min-width:0;" placeholder="${esc(t("cost.matNamePh"))}" value="${esc(guess)}">
            <button type="button" id="co-matadd" class="btn-secondary btn-compact" data-tip="${esc(t("cost.matAddTip"))}">💾</button>
          </div>
          <button type="button" id="co-matdel" class="btn-secondary btn-compact" style="display:none;">🗑 ${esc(t("cost.matDel"))}</button>
          <label class="dlg-row"><span>${esc(t("cost.matArea"))}</span>
            <select id="co-area" class="prop-input" style="width:auto;">
              <option value="parts"${init.matArea === "parts" ? " selected" : ""}>${esc(t("cost.area.parts"))}</option>
              <option value="sheet"${init.matArea === "sheet" ? " selected" : ""}>${esc(t("cost.area.sheet", { w: Math.round(st.w), h: Math.round(st.h) }))}</option>
            </select></label>
          ${num("co-waste", "cost.waste", init.waste, "1", "%", "cost.wasteTip")}
          <div class="dlg-hint" style="margin:0;"><b>${esc(t("cost.gLabor"))}</b></div>
          ${num("co-setup", "cost.setupMin", init.setupMin, "1", "min", "cost.setupTip")}
          ${num("co-piece", "cost.pieceMin", init.pieceMin, "1", "min", "cost.pieceTip")}
          ${num("co-lrate", "cost.laborRate", init.laborRate, "1", cur + "/h")}
          ${num("co-extra", "cost.extra", init.extra, "0.1", cur, "cost.extraTip")}
          <div class="dlg-hint" style="margin:0;"><b>${esc(t("cost.gSale"))}</b></div>
          ${num("co-qty", "cost.qty", init.qty, "1", t("cost.pcs"))}
          ${num("co-markup", "cost.markup", init.markup, "5", "%", "cost.markupTip")}
          <label class="dlg-row" style="cursor:pointer;" data-tip="${esc(t("cost.tiersTip"))}"><span>${esc(t("cost.tiers"))}</span><input id="co-tiers" type="checkbox" ${init.tiersOn ? "checked" : ""} style="width:auto;"></label>
          <div id="co-tierrows">${init.tiers.map((x, i) => `
            <div class="dlg-row"><span>${esc(t("cost.tierFrom"))}</span><span style="display:flex;gap:4px;align-items:center;">
              <span class="dlg-num"><input id="co-tq${i}" type="number" min="0" step="1" value="${x.qty}" style="width:56px;"><em>${esc(t("cost.pcs"))}</em></span>
              <span class="dlg-num"><input id="co-tm${i}" type="number" min="0" step="1" value="${x.markup}" style="width:48px;"><em>%</em></span></span></div>`).join("")}
          </div>
          <label class="dlg-row"><span>${esc(t("cost.currency"))}</span><input id="co-cur" type="text" maxlength="4" value="${esc(init.currency)}" class="prop-input" style="width:60px;"></label>
        </div>
        <div class="box-prev" style="min-height:0;">
          <div id="co-res"></div>
        </div>
      </div>
      <div class="dlg-hint">${esc(t("cost.hint"))}</div>
      <div class="dlg-buttons">
        <button id="co-copy" class="btn-secondary">📋 ${esc(t("cost.copy"))}</button>
        <button id="co-csv" class="btn-secondary">📄 ${esc(t("cost.csv"))}</button>
        <button id="co-close" class="btn-primary">${esc(t("dlg.close"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (id: string) => ov.querySelector("#" + id) as HTMLInputElement;

  const read = (): CostOptions => {
    const n = (id: string, d: number) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : d; };
    return {
      machineRate: n("co-mrate", DEF.machineRate), matPrice: n("co-mprice", DEF.matPrice),
      matArea: $("co-area").value === "sheet" ? "sheet" : "parts", waste: n("co-waste", DEF.waste),
      setupMin: n("co-setup", DEF.setupMin), pieceMin: n("co-piece", DEF.pieceMin), laborRate: n("co-lrate", DEF.laborRate),
      extra: n("co-extra", DEF.extra), qty: Math.max(1, Math.round(n("co-qty", 1))), markup: n("co-markup", DEF.markup),
      currency: $("co-cur").value.trim().slice(0, 4) || DEF.currency,
      prices, matName: ($("co-mat") as unknown as HTMLSelectElement).value,
      tiersOn: $("co-tiers").checked,
      tiers: [0, 1, 2].map(i => ({ qty: Math.round(n("co-tq" + i, 0)), markup: n("co-tm" + i, 0) }))
    };
  };

  // ---- Preisliste ----
  const prices = init.prices.map(x => ({ ...x }));
  const matSel = $("co-mat") as unknown as HTMLSelectElement;
  const fillMat = (value: string) => {
    matSel.innerHTML = `<option value="">${esc(t("cost.matManual"))}</option>`
      + prices.map(x => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join("");
    matSel.value = prices.some(x => x.name === value) ? value : "";
  };
  const matUi = () => {
    const on = !!matSel.value;
    (ov.querySelector("#co-matsave") as HTMLElement).style.display = on ? "none" : "flex";
    (ov.querySelector("#co-matdel") as HTMLElement).style.display = on ? "" : "none";
  };
  fillMat(init.matName);
  matUi();
  matSel.addEventListener("change", () => {
    const x = prices.find(p => p.name === matSel.value);
    if (x) $("co-mprice").value = String(x.price);
    matUi();
  });
  // Preis eines gewählten Eintrags ändern = Eintrag ändern
  $("co-mprice").addEventListener("input", () => {
    const x = prices.find(p => p.name === matSel.value), v = parseFloat($("co-mprice").value);
    if (x && Number.isFinite(v) && v >= 0) x.price = v;
  });
  $("co-matadd").onclick = () => {
    const name = $("co-matname").value.trim().slice(0, 60), v = parseFloat($("co-mprice").value);
    if (!name) { $("co-matname").focus(); return; }
    const price = Number.isFinite(v) && v >= 0 ? v : 0;
    const x = prices.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (x) x.price = price; else prices.push({ name, price });
    prices.sort((a, b) => a.name.localeCompare(b.name));
    fillMat(x ? x.name : name);
    matUi();
    render();
  };
  (ov.querySelector("#co-matdel") as HTMLElement).onclick = () => {
    const i = prices.findIndex(p => p.name === matSel.value);
    if (i >= 0) prices.splice(i, 1);
    fillMat("");
    matUi();
    render();
  };

  let text = "";
  let csvRows: [string, number | string, string][] = [];
  const render = () => {
    const o = read();
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* egal */ }
    // Einheiten mit der Währung mitziehen
    ov.querySelectorAll<HTMLElement>("em[data-cur]").forEach(e => { e.textContent = o.currency + (e.dataset.cur || ""); });
    (ov.querySelector("#co-tierrows") as HTMLElement).style.display = o.tiersOn ? "" : "none";
    const r = calcCost(timeS, o.matArea === "sheet" ? sheetM2 : partsM2, o);
    const c = (v: number) => `${fmt(v)} ${o.currency}`;
    const row = (k: string, v: string, strong = false) =>
      `<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;${strong ? "font-weight:700;" : ""}"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
    const hr = `<div style="border-top:1px solid rgba(255,255,255,0.12);margin:4px 0;"></div>`;
    ($("co-res") as HTMLElement).innerHTML =
      row(t("cost.time"), hms(r.timeS) + (o.qty > 1 ? ` × ${o.qty}` : ""))
      + row(t("cost.area"), `${r.areaM2.toLocaleString(currentLanguage(), { maximumSignificantDigits: 3 })} m²` + (o.qty > 1 ? ` × ${o.qty}` : ""))
      + hr
      + row(t("cost.gMachine"), c(r.machine))
      + row(t("cost.gMaterial"), c(r.material))
      + row(t("cost.gLabor"), c(r.labor))
      + (r.extras > 0 ? row(t("cost.extras"), c(r.extras)) : "")
      + hr
      + row(t("cost.total"), c(r.total), true)
      + (o.qty > 1 ? row(t("cost.perPiece"), c(r.perPiece)) : "")
      + hr
      + row(t(r.tier ? "cost.markupTier" : "cost.markup"), `${fmt(r.markup)} %`)
      + `<div style="color:var(--color-success, #2ecc71);">`
      + row(t("cost.pricePiece"), c(r.pricePiece), true)
      + (o.qty > 1 ? row(t("cost.priceTotal", { n: o.qty }), c(r.priceTotal), true) : "")
      + `</div>`
      + row(t("cost.profit"), c(r.priceTotal - r.total));
    csvRows = [
      [t("cost.qty"), o.qty, t("cost.pcs")],
      [t("cost.time"), +(r.timeS / 60).toFixed(2), "min"],
      [t("cost.area"), +r.areaM2.toFixed(5), "m²"],
      ...(o.matName ? [[t("cost.matList"), o.matName, ""] as [string, string, string]] : []),
      [t("cost.gMachine"), +r.machine.toFixed(2), o.currency], [t("cost.gMaterial"), +r.material.toFixed(2), o.currency],
      [t("cost.gLabor"), +r.labor.toFixed(2), o.currency], [t("cost.extras"), +r.extras.toFixed(2), o.currency],
      [t("cost.total"), +r.total.toFixed(2), o.currency], [t("cost.perPiece"), +r.perPiece.toFixed(2), o.currency],
      [t("cost.markup"), +r.markup.toFixed(2), "%"],
      [t("cost.pricePiece"), +r.pricePiece.toFixed(2), o.currency], [t("cost.priceTotal", { n: o.qty }), +r.priceTotal.toFixed(2), o.currency],
      [t("cost.profit"), +(r.priceTotal - r.total).toFixed(2), o.currency]
    ];
    text = [
      `${t("cost.title")} – ${o.qty} ${t("cost.pcs")}`,
      `${t("cost.time")}: ${hms(r.timeS)}`,
      `${t("cost.gMachine")}: ${c(r.machine)}`, `${t("cost.gMaterial")}: ${c(r.material)}`, `${t("cost.gLabor")}: ${c(r.labor)}`,
      ...(r.extras > 0 ? [`${t("cost.extras")}: ${c(r.extras)}`] : []),
      `${t("cost.total")}: ${c(r.total)}`,
      `${t("cost.pricePiece")}: ${c(r.pricePiece)}`,
      ...(o.qty > 1 ? [`${t("cost.priceTotal", { n: o.qty })}: ${c(r.priceTotal)}`] : [])
    ].join("\n");
  };
  ov.querySelectorAll("input, select").forEach(i => { i.addEventListener("input", render); i.addEventListener("change", render); });
  render();
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $("co-close").onclick = close;
  $("co-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(text); log(t("cost.copied")); } catch { log(text); }
  };
  // CSV: Dezimalkomma-Sprachen bekommen „;“ als Trenner (so öffnet Excel die Datei richtig)
  $("co-csv").onclick = async () => {
    const comma = (1.5).toLocaleString(currentLanguage()).includes(",");
    const sep = comma ? ";" : ",";
    const cell = (v: number | string) => {
      const s = typeof v === "number" ? (comma ? String(v).replace(".", ",") : String(v)) : v;
      return /[";,\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = "\ufeff" + [[t("cost.csvItem"), t("cost.csvValue"), t("cost.csvUnit")], ...csvRows].map(r => r.map(cell).join(sep)).join("\r\n") + "\r\n";
    try {
      const path = await save({ title: t("cost.csv"), defaultPath: t("cost.csvFile"), filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      await writeFile(path, new TextEncoder().encode(csv));
      log(t("cost.csvSaved", { p: path }));
    } catch (err) { log(t("gcw.saveError", { e: String(err) })); }
  };
  setTimeout(() => $("co-qty").select(), 0);
}
