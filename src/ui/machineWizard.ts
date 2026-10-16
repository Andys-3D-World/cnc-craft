/**
 * MASCHINEN-ASSISTENT: Hersteller + Modell wählen → alles passend einstellen
 *
 *  - Maschinenart (Fräse / Laser / Plasma)
 *  - Arbeitsfläche (bed-w / bed-h), Baudrate, Nullpunkt
 *  - Laser: S-Max ($30) und M4 dynamisch
 *  - Platte (Restflächen) bekommt die neue Größe, solange darauf noch nichts markiert ist
 *  - auf Wunsch $32 (Laser-Modus) und $30 an die Maschine schreiben
 *
 * Jede Maschinenart (Fräse / Laser / Plasma) hat ihre EIGENE gewählte Maschine:
 * Im Laser-Modus zeigt der Assistent nur Laser, beim Fräsen nur Fräsen, bei Plasma nur Plasma.
 * Wechselt man oben die Art, wird automatisch die dazu gemerkte Maschine eingestellt
 * (Bettgröße, Baudrate, Nullpunkt, Steuerung) – z. B. Laser = K40, Fräse = 3018.
 */
import { t, T, tip } from "../i18n/i18n";
import { BRANDS, PROFILES, profileById, profilesOf, MachineProfile, Origin } from "../machines/profiles";
import { setMachineMode, getMachineMode, MachineMode, MODE_CHANGED } from "../machineMode";
import { setLaserSettings, laserSettings } from "../laserLayers";
import { hasUsedArea, newPlate, getStock } from "../stock";
import { machine, sendAndWait, setRuidaOptionsProvider, syncRuidaOptions } from "../machine";
import { openUrl } from "@tauri-apps/plugin-opener";
import { selectBundledGrbl } from "./flashPage";

const KEY = "cnc_craft_machine_profile";

/** Was gespeichert wird (Profil-Werte, ggf. von Hand angepasst) */
export interface SavedMachine {
  id: string;            // Profil-Id ("" = ohne Profil)
  name: string;          // Anzeigename zum Zeitpunkt der Auswahl
  kind: MachineMode;
  w: number; h: number; z?: number;
  baud: number;
  sMax: number;
  dynamic: boolean;
  origin: Origin;
  protocol?: "grbl" | "marlin" | "ruida" | "k40";
  board?: string; // K40-Board (M2, M3, B2 …)
  net?: string;   // Netzwerk-Adresse aus dem Profil
}

let saved: SavedMachine | null = null;
let log: (s: string) => void = () => {};
let redraw: () => void = () => {};

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const $ = (id: string) => document.getElementById(id);

export function brandName(id: string): string {
  const b = BRANDS.find(x => x.id === id);
  if (!b) return id;
  return b.nameKey ? t(b.nameKey) : (b.name || id);
}

export function modelName(p: MachineProfile): string {
  return p.modelKey ? t(p.modelKey) : (p.model || p.id);
}

export function profileName(p: MachineProfile): string {
  return p.brand === "custom" ? modelName(p) : `${brandName(p.brand)} ${modelName(p)}`;
}

export function currentMachine(): SavedMachine | null {
  return saved;
}

/** Ist die gewählte Maschine eine Ruida-Steuerung (CO₂ mit Display)? */
export function isRuidaMachine(): boolean {
  return saved?.protocol === "ruida";
}

/** K40 mit Original-Board (M2 Nano …)? */
export function isK40Machine(): boolean {
  return saved?.protocol === "k40";
}

/** Marlin-Maschine (Creality, Anycubic, MPCNC …)? */
export function isMarlinMachine(): boolean {
  return saved?.protocol === "marlin";
}

function applyProtocolClass() {
  document.body.classList.toggle("proto-ruida", isRuidaMachine());
  document.body.classList.toggle("proto-marlin", isMarlinMachine());
  document.body.classList.toggle("proto-k40", isK40Machine());
  window.dispatchEvent(new CustomEvent("cnc-protocol-changed", { detail: { ruida: isRuidaMachine() } }));
}

// Werte für die Ruida-Umrechnung (Bettgröße, Nullpunkt, S-Max)
setRuidaOptionsProvider(() => {
  const w = parseFloat((document.getElementById("bed-w") as HTMLInputElement | null)?.value || "") || saved?.w || 600;
  const h = parseFloat((document.getElementById("bed-h") as HTMLInputElement | null)?.value || "") || saved?.h || 400;
  const radio = document.querySelector<HTMLInputElement>('input[name="origin-select"]:checked')?.value;
  return { bedW: w, bedH: h, origin: radio || saved?.origin || "top-right", sMax: laserSettings.sMax || 1000, magic: 0x88, minPower: 0, board: saved?.board || "M2" };
});

const keyFor = (mode: MachineMode) => `${KEY}_${mode}`;

/** Gemerkte Maschine für eine Art (alte Einzel-Speicherung wird übernommen, wenn die Art passt) */
function load(mode: MachineMode = getMachineMode()): SavedMachine | null {
  try {
    let raw = localStorage.getItem(keyFor(mode));
    if (!raw) {
      const old = localStorage.getItem(KEY);
      if (old && JSON.parse(old).kind === mode) raw = old;
    }
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!(+d.w > 0 && +d.h > 0)) return null;
    return {
      id: String(d.id || ""), name: String(d.name || ""),
      kind: (["mill", "laser", "plasma"].includes(d.kind) ? d.kind : "mill") as MachineMode,
      w: +d.w, h: +d.h, z: +d.z > 0 ? +d.z : undefined,
      baud: +d.baud > 0 ? +d.baud : 115200,
      sMax: +d.sMax > 0 ? +d.sMax : 1000,
      dynamic: d.dynamic !== false,
      origin: (["top-left", "top-right", "bottom-left", "bottom-right"].includes(d.origin) ? d.origin : "bottom-left") as Origin,
      protocol: ["ruida", "marlin", "k40"].includes(d.protocol) ? d.protocol : "grbl",
      board: typeof d.board === "string" ? d.board : undefined,
      net: typeof d.net === "string" ? d.net : undefined
    };
  } catch { return null; }
}

function store() {
  try { if (saved) localStorage.setItem(keyFor(saved.kind), JSON.stringify(saved)); } catch { /* egal */ }
}

/** Baudrate in die Auswahl setzen (fehlende Werte werden ergänzt) */
function setBaud(baud: number) {
  const sel = $("baud-select") as HTMLSelectElement | null;
  if (!sel || sel.disabled) return;
  const v = String(baud);
  if (![...sel.options].some(o => o.value === v)) {
    const o = document.createElement("option");
    o.value = v; o.textContent = `${v} Baud`;
    sel.appendChild(o);
  }
  sel.value = v;
}

function setOrigin(origin: Origin) {
  const r = document.querySelector<HTMLInputElement>(`input[name="origin-select"][value="${origin}"]`);
  if (r) r.checked = true;
}

function setBed(w: number, h: number, fire: boolean) {
  const wi = $("bed-w") as HTMLInputElement | null, hi = $("bed-h") as HTMLInputElement | null;
  if (wi) { wi.value = String(w); if (fire) wi.dispatchEvent(new Event("input")); }
  if (hi) { hi.value = String(h); if (fire) hi.dispatchEvent(new Event("input")); }
}

/**
 * Direkt nach dem Aufbau der rechten Seite aufrufen (vor allem anderen, das die Bettgröße liest):
 * stellt die gespeicherte Maschine wieder ein.
 */
export function applySavedMachine() {
  saved = load();
  applyProtocolClass();
  if (!saved) return;
  setBed(saved.w, saved.h, false);
  setBaud(saved.baud);
  setOrigin(saved.origin);
}

/** Art gewechselt (Fräse/Laser/Plasma): die dazu gemerkte Maschine einstellen */
function switchToMode(mode: MachineMode) {
  if (saved && saved.kind === mode) return; // schon die richtige (z. B. gerade im Assistenten gewählt)
  const before = saved?.protocol || "grbl";
  saved = load(mode);
  applyProtocolClass();
  if (saved) {
    setBed(saved.w, saved.h, true);
    setBaud(saved.baud);
    setOrigin(saved.origin);
    if (saved.kind === "laser") {
      setLaserSettings({ sMax: saved.sMax, dynamic: saved.dynamic });
      const smax = $("laser-smax") as HTMLInputElement | null, dyn = $("laser-dynamic") as HTMLInputElement | null;
      if (smax) smax.value = String(laserSettings.sMax);
      if (dyn) dyn.checked = laserSettings.dynamic;
    }
    if (saved.net) { try { localStorage.setItem("cnc_craft_net_addr", saved.net); } catch { /* egal */ } }
    log(t("mw.switched", { mode: t("mode." + mode), name: saved.name }));
  }
  if (machine.connected && (saved?.protocol || "grbl") !== before) log(t("mw.reconnect"));
  refreshMachineLine();
  syncRuidaOptions();
  redraw();
}

export function initMachineWizard(redrawFn: () => void, logFn: (s: string) => void) {
  redraw = redrawFn;
  log = logFn;
  window.addEventListener(MODE_CHANGED, () => switchToMode(getMachineMode()));
  document.querySelectorAll<HTMLElement>(".mw-open").forEach(b => b.addEventListener("click", () => openMachineWizard()));
  // Bettgröße von Hand geändert (oder von der Maschine übernommen) → merken
  const remember = () => {
    const w = parseFloat(($("bed-w") as HTMLInputElement | null)?.value || ""), h = parseFloat(($("bed-h") as HTMLInputElement | null)?.value || "");
    if (!(w > 0 && h > 0)) return;
    if (!saved) return;
    if (saved.w === w && saved.h === h) return;
    saved.w = w; saved.h = h; store(); refreshMachineLine();
    syncRuidaOptions();
  };
  $("bed-w")?.addEventListener("change", remember);
  $("bed-h")?.addEventListener("change", remember);
  $("bed-w")?.addEventListener("input", remember);
  $("bed-h")?.addEventListener("input", remember);
  document.querySelectorAll<HTMLInputElement>('input[name="origin-select"]').forEach(r => r.addEventListener("change", () => {
    if (saved && r.checked) { saved.origin = r.value as Origin; store(); syncRuidaOptions(); }
  }));
  $("baud-select")?.addEventListener("change", () => {
    const b = parseInt(($("baud-select") as HTMLSelectElement).value, 10);
    if (saved && b > 0 && b !== saved.baud) { saved.baud = b; store(); }
  });
  window.addEventListener("cnc-language-changed", refreshMachineLine);
  refreshMachineLine();
}

/** Zeile „Maschine: …“ in beiden Reitern */
export function refreshMachineLine() {
  let text: string;
  if (saved) {
    const p = profileById(saved.id);
    const name = p ? profileName(p) : saved.name;
    text = `${t("mw.current", { name: esc(name) })} · ${saved.w} × ${saved.h} mm`;
  } else {
    text = `<span class="mw-none">${t("mw.none")}</span>`;
  }
  document.querySelectorAll<HTMLElement>(".mw-current").forEach(el => el.innerHTML = text);
}

/** Abschnitt für die rechte Seite (Reiter Fräsen/Laser/Plasma → Arbeitsbereich und Maschine → Verbindung) */
export function machineLineHtml(): string {
  return `<div class="mw-line"><span class="mw-current"></span><button class="btn-secondary btn-compact mw-open" ${tip("mw.openTip")}>🧭 ${T("mw.open")}</button></div>`;
}

// ---------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------

const supportBadge = (s: string) => `<span class="mw-sup mw-sup-${s}">${t("mw.sup." + s)}</span>`;

export function openMachineWizard() {
  $("mw-overlay")?.remove();
  // nur Maschinen der aktuellen Art zeigen (oben umschaltbar)
  let kind: MachineMode = getMachineMode();
  const ofKind = (p: MachineProfile) => p.kind === kind;
  const startProfile = profileById(saved?.id);
  let brand = startProfile && ofKind(startProfile) ? startProfile.brand : "custom";
  let current: MachineProfile = (startProfile && ofKind(startProfile) ? startProfile : null) || PROFILES.find(p => p.brand === brand && ofKind(p)) || PROFILES.find(ofKind)!;
  let filter = "";

  const ov = document.createElement("div");
  ov.id = "mw-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box mw-box" role="dialog">
      <h3>🧭 ${t("mw.title")}</h3>
      <div class="mw-tabs" role="tablist">
        ${(["laser", "mill", "plasma"] as MachineMode[]).map(k => `<button class="mw-tab" data-kind="${k}">${{ laser: "🔦", mill: "🛠️", plasma: "🔥" }[k]} ${t("mode." + k)}</button>`).join("")}
      </div>
      <div class="dlg-hint">${t("mw.intro")}</div>
      <input type="search" id="mw-search" class="mw-search" placeholder="${esc(t("mw.search"))}">
      <div class="mw-lists">
        <div class="mw-list" id="mw-brands"></div>
        <div class="mw-list" id="mw-models"></div>
      </div>
      <div class="mw-detail" id="mw-detail"></div>
      <div class="dlg-buttons">
        <button id="mw-apply" class="btn-primary" style="flex:1;">✔ ${t("mw.apply")}</button>
        <button id="mw-cancel" class="btn-secondary">${t("mw.cancel")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const matches = (p: MachineProfile) => {
    if (!ofKind(p)) return false;
    if (!filter) return true;
    const s = (brandName(p.brand) + " " + modelName(p)).toLowerCase();
    return filter.split(/\s+/).every(w => s.includes(w));
  };

  const renderLists = () => {
    const brands = BRANDS.filter(b => PROFILES.some(p => p.brand === b.id && matches(p)));
    if (!brands.some(b => b.id === brand) && brands.length) brand = brands[0].id;
    ($("mw-brands") as HTMLElement).innerHTML = brands.map(b =>
      `<button class="mw-item ${b.id === brand ? "active" : ""}" data-brand="${b.id}">${b.icon} ${esc(brandName(b.id))}</button>`).join("")
      || `<div class="dlg-hint">${t("mw.nothing")}</div>`;
    ov.querySelectorAll<HTMLElement>(".mw-tab").forEach(b => b.classList.toggle("active", b.dataset.kind === kind));
    const models = profilesOf(brand).filter(matches);
    if (!models.some(p => p.id === current.id) && models.length) current = models[0];
    ($("mw-models") as HTMLElement).innerHTML = models.map(p =>
      `<button class="mw-item ${p.id === current.id ? "active" : ""}" data-id="${p.id}">${esc(modelName(p))}<span class="mw-dot mw-dot-${p.support}"></span></button>`).join("");
    ov.querySelectorAll<HTMLElement>("[data-brand]").forEach(b => b.onclick = () => {
      brand = b.dataset.brand!; current = profilesOf(brand).filter(matches)[0] || current; renderLists(); renderDetail();
    });
    ov.querySelectorAll<HTMLElement>("[data-id]").forEach(b => b.onclick = () => {
      current = profileById(b.dataset.id!) || current; renderLists(); renderDetail();
    });
  };

  const renderDetail = () => {
    const p = current;
    // gespeicherte (von Hand angepasste) Werte vorschlagen, wenn es dieselbe Maschine ist
    const mine = load(p.kind);
    const v = mine && mine.id === p.id ? mine : null;
    const val = {
      w: v?.w || p.w, h: v?.h || p.h, z: v?.z || p.z || 0,
      baud: v?.baud || p.baud, sMax: v?.sMax || p.sMax, dynamic: v ? v.dynamic : p.dynamic, origin: v?.origin || p.origin
    };
    const notes = (p.notes || []).map(k => `<li>${t(k)}</li>`).join("");
    const canSend = p.support === "ok" || p.support === "check";
    const bauds = [9600, 57600, 115200, 230400, 250000];
    if (!bauds.includes(val.baud)) bauds.push(val.baud);
    ($("mw-detail") as HTMLElement).innerHTML = `
      <div class="mw-head"><b>${esc(profileName(p))}</b>${supportBadge(p.support)}</div>
      ${notes ? `<ul class="mw-notes">${notes}</ul>` : ""}
      ${!canSend ? `<div class="mw-warn">${t("mw.noSend")}</div>` : ""}
      <div class="mw-grid">
        <label>${t("mw.area")}<span class="mw-pair"><input type="number" id="mw-w" min="1" value="${val.w}"> × <input type="number" id="mw-h" min="1" value="${val.h}"> mm</span></label>
        <label class="mw-mill">${t("mw.zTravel")}<span class="mw-pair"><input type="number" id="mw-z" min="0" value="${val.z}"> mm</span></label>
        <label>${t("mw.baud")}<select id="mw-baud">${bauds.sort((a, b) => b - a).map(b => `<option value="${b}" ${b === val.baud ? "selected" : ""}>${b}</option>`).join("")}</select></label>
        <label class="mw-laser" ${tip("laser.sMaxTip")}>${t("mw.sMax")}<input type="number" id="mw-smax" min="1" value="${val.sMax}"></label>
        <label class="mw-laser mw-check" ${tip("laser.dynamicTip")}>${t("mw.dynamic")}<input type="checkbox" id="mw-dyn" ${val.dynamic ? "checked" : ""}></label>
        <label>${t("mw.origin")}<select id="mw-origin">
          ${(["bottom-left", "bottom-right", "top-left", "top-right"] as Origin[]).map(o => `<option value="${o}" ${o === val.origin ? "selected" : ""}>${t(originKey(o))}</option>`).join("")}
        </select></label>
      </div>
      ${p.protocol === "k40" ? `<div class="mw-grid"><label>${t("mw.k40board")}<select id="mw-board">
          ${["M2", "M3", "B2", "M1", "B1", "M", "B", "A"].map(b => `<option value="${b}" ${(v?.board || p.board || "M2") === b ? "selected" : ""}>${b === "M2" ? "M2 Nano" : b === "M3" ? "M3 Nano" : b}</option>`).join("")}
        </select></label></div>` : ""}
      ${p.action === "flash-grbl" ? `<button id="mw-flash" class="btn-secondary">⚡ ${t("mw.flashGrbl")}</button>` : ""}
      ${p.grbl ? `<label class="mw-write"><input type="checkbox" id="mw-write"> <span>${t("mw.writeGrbl")}</span></label>
        <div class="dlg-hint" id="mw-write-hint"></div>` : ""}
      <div class="dlg-hint">${t("mw.verify", { btn: t("rp.syncBed") })}${p.src ? ` <a href="#" class="mw-src" data-url="${esc(p.src)}">${t("mw.source")}</a>` : ""}</div>`;
    const syncKind = () => {
      const k = p.kind;
      ov.querySelectorAll<HTMLElement>(".mw-laser").forEach(e => e.style.display = k === "laser" ? "" : "none");
      ov.querySelectorAll<HTMLElement>(".mw-mill").forEach(e => e.style.display = k === "laser" ? "none" : "");
      const hint = $("mw-write-hint");
      if (hint) hint.textContent = k === "laser" ? t("mw.writeLaser", { s: ($("mw-smax") as HTMLInputElement).value }) : t("mw.writeMill");
      const wr = $("mw-write") as HTMLInputElement | null;
      if (wr) { wr.disabled = !machine.connected; if (!machine.connected) wr.checked = false; wr.parentElement!.title = machine.connected ? "" : t("mw.writeOffline"); }
    };
    ($("mw-smax") as HTMLInputElement).oninput = syncKind;
    syncKind();
    $("mw-flash")?.addEventListener("click", () => {
      ($("mw-apply") as HTMLElement).click(); // Maschine übernehmen …
      (document.querySelector('.tab-navigation [data-tab="tab-flash"]') as HTMLElement | null)?.click(); // … zum Flashen
      selectBundledGrbl(p.id === "estlcam-nano" ? "arduino-nano" : "arduino-uno");
    });
    ov.querySelector<HTMLElement>(".mw-src")?.addEventListener("click", (e) => {
      e.preventDefault();
      const url = (e.currentTarget as HTMLElement).dataset.url!;
      openUrl(url).catch(() => log(url));
    });
    ($("mw-apply") as HTMLButtonElement).disabled = p.support === "no";
    ($("mw-apply") as HTMLButtonElement).title = p.support === "no" ? t("mw.noSend") : "";
  };

  const search = $("mw-search") as HTMLInputElement;
  search.oninput = () => { filter = search.value.trim().toLowerCase(); renderLists(); renderDetail(); };
  // Art umschalten (Laser / Fräse / Plasma)
  ov.querySelectorAll<HTMLElement>(".mw-tab").forEach(b => b.onclick = () => {
    kind = b.dataset.kind as MachineMode;
    const mine = load(kind);
    const sp = mine ? profileById(mine.id) : null;
    current = (sp && ofKind(sp) ? sp : null) || PROFILES.find(x => x.brand === "custom" && ofKind(x)) || PROFILES.find(ofKind)!;
    brand = current.brand;
    renderLists(); renderDetail();
  });

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ($("mw-cancel") as HTMLElement).onclick = close;
  ($("mw-apply") as HTMLElement).onclick = async () => {
    const num = (id: string, def: number) => { const n = parseFloat(($(id) as HTMLInputElement | null)?.value || ""); return n > 0 ? n : def; };
    const p = current;
    const result: SavedMachine = {
      id: p.id, name: profileName(p), kind: p.kind,
      w: Math.round(num("mw-w", p.w)), h: Math.round(num("mw-h", p.h)),
      z: p.kind !== "laser" ? num("mw-z", p.z || 0) || undefined : undefined,
      baud: parseInt(($("mw-baud") as HTMLSelectElement).value, 10) || p.baud,
      sMax: Math.round(num("mw-smax", p.sMax)),
      dynamic: ($("mw-dyn") as HTMLInputElement).checked,
      origin: ($("mw-origin") as HTMLSelectElement).value as Origin,
      protocol: p.protocol || "grbl",
      board: ($("mw-board") as HTMLSelectElement | null)?.value || p.board,
      net: p.net
    };
    const write = !!($("mw-write") as HTMLInputElement | null)?.checked && machine.connected;
    close();
    await applyMachine(result, write);
  };

  renderLists();
  renderDetail();
  setTimeout(() => search.focus(), 0);
}

function originKey(o: Origin): string {
  return { "top-left": "rp.originTL", "top-right": "rp.originTR", "bottom-left": "rp.originBL", "bottom-right": "rp.originBR" }[o];
}

/** Maschine übernehmen: alles im Programm einstellen und speichern */
export async function applyMachine(m: SavedMachine, writeToMachine = false) {
  const protoChanged = (saved?.protocol || "grbl") !== (m.protocol || "grbl");
  saved = m;
  store();
  if (m.net) {
    // Netzwerk-Adresse vorbelegen (z. B. xTool F1 über USB-Netzwerk)
    try { localStorage.setItem("cnc_craft_net_addr", m.net); localStorage.setItem("cnc_craft_last_port", "__net__"); } catch { /* egal */ }
  }
  applyProtocolClass();
  if (protoChanged && machine.connected) log(t("mw.reconnect"));
  setMachineMode(m.kind);
  setBed(m.w, m.h, true);
  setBaud(m.baud);
  setOrigin(m.origin);
  if (m.kind === "laser") {
    setLaserSettings({ sMax: m.sMax, dynamic: m.dynamic });
    const smax = $("laser-smax") as HTMLInputElement | null, dyn = $("laser-dynamic") as HTMLInputElement | null;
    if (smax) smax.value = String(laserSettings.sMax);
    if (dyn) dyn.checked = laserSettings.dynamic;
  }
  // Platte an die neue Größe anpassen, wenn darauf noch nichts markiert ist
  const st = getStock(m.kind);
  if (!hasUsedArea(m.kind) && (st.w !== m.w || st.h !== m.h)) newPlate(m.w, m.h);
  refreshMachineLine();
  syncRuidaOptions();
  log(t("mw.applied", { name: m.name, w: m.w, h: m.h }));
  redraw();
  window.dispatchEvent(new Event("cnc-redraw"));
  window.dispatchEvent(new CustomEvent("cnc-machine-profile-changed", { detail: m }));

  if (writeToMachine) {
    const lines = m.kind === "laser" ? [["$32", "1"], ["$30", String(m.sMax)]] : [["$32", "0"]];
    for (const [key, v] of lines) {
      const ack = await sendAndWait(`${key}=${v}`, 4000, false);
      if (ack.ok) { machine.settings.set(key, v); log(t("mw.wrote", { key, v })); }
      else log(t("mw.writeFail", { key, e: String((ack as any).code ?? "?") }));
    }
  }
}
