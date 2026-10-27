/**
 * FREQUENZUMRICHTER (VFD) per Modbus (Reiter "Maschine", nur Fräse)
 *
 * Eigene Verbindung neben der Maschine: RS-485 über einen USB-Adapter (Modbus RTU) oder
 * Netzwerk (Modbus TCP). Drehzahl setzen, vorwärts/rückwärts/stopp, Ist-Drehzahl und
 * Störungscode lesen (jede Sekunde, solange verbunden).
 * Die Register stehen in Profilen (vfd.rs); „Eigenes Profil“ lässt alle Register selbst eintragen.
 * Gespeichert unter cnc_craft_vfd (wird über settingsStore.ts mitgesichert).
 */
import { invoke } from "@tauri-apps/api/core";
import { t, T, tip } from "../i18n/i18n";
import { listPorts } from "../machine";

const KEY = "cnc_craft_vfd";
const CUSTOM = "custom";

type SpeedUnit = "hz100" | "hz10" | "rpm" | "percent100";
type ReadFn = "holding" | "input";
interface ReadReg { reg: number; read: ReadFn }
export interface VfdProfile {
  id: string; name: string;
  controlReg: number; cmdFwd: number; cmdRev: number; cmdStop: number;
  speedReg: number; speedUnit: SpeedUnit;
  actual: ReadReg | null; actualUnit: SpeedUnit;
  fault: ReadReg | null;
}
interface VfdStatus { rpm: number | null; hz: number | null; fault: number | null }

interface Settings {
  link: "rtu" | "tcp"; port: string; baud: number; parity: "N" | "E" | "O"; host: string;
  unit: number; profile: string; maxRpm: number; maxHz: number; rpm: number;
  custom: VfdProfile;
}

const UNITS: SpeedUnit[] = ["hz100", "hz10", "rpm", "percent100"];

function defaults(): Settings {
  return {
    link: "rtu", port: "", baud: 9600, parity: "N", host: "", unit: 1, profile: "delta", maxRpm: 24000, maxHz: 400, rpm: 12000,
    custom: {
      id: CUSTOM, name: "", controlReg: 0x2000, cmdFwd: 0x12, cmdRev: 0x22, cmdStop: 0x01, speedReg: 0x2001, speedUnit: "hz100",
      actual: { reg: 0x2103, read: "holding" }, actualUnit: "hz100", fault: { reg: 0x2100, read: "holding" },
    },
  };
}

let s: Settings = defaults();
let profiles: VfdProfile[] = [];
let connected = false;
let poll: number | undefined;
let polling = false;
let failCount = 0;
let log: (s: string) => void = () => {};

function esc(v: string): string {
  return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(4, "0");
/** "0x2000", "2000h" oder dezimal -> Zahl 0 … 65535 (null = leer/ungültig) */
function num(v: string): number | null {
  const x = v.trim().toLowerCase();
  if (!x) return null;
  const n = x.startsWith("0x") ? parseInt(x.slice(2), 16) : x.endsWith("h") ? parseInt(x.slice(0, -1), 16) : Number(x);
  return Number.isInteger(n) && n >= 0 && n <= 0xFFFF ? n : null;
}

function load() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (o && typeof o === "object") s = { ...defaults(), ...o, custom: { ...defaults().custom, ...(o.custom || {}), id: CUSTOM } };
  } catch { /* kaputt -> Standard */ }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* egal */ } }

function profile(): VfdProfile | undefined {
  return s.profile === CUSTOM ? s.custom : profiles.find(p => p.id === s.profile);
}

/** Fehler aus Rust (modbus.rs / vfd.rs) -> verständlicher Text */
function errText(e: unknown): string {
  const m = String(e);
  if (m.startsWith("modbus-timeout")) return t("vfd.err.timeout");
  if (m.startsWith("modbus-crc")) return t("vfd.err.crc");
  if (m.startsWith("modbus-exception")) return t("vfd.err.exception", { code: m.split(":")[1]?.trim() || "?" });
  if (m.startsWith("modbus-frame")) return t("vfd.err.frame");
  if (m.startsWith("modbus-io")) return t("vfd.err.io", { e: m.slice(m.indexOf(":") + 1).trim() });
  if (m === "vfd-unit") return t("vfd.err.unit");
  if (m === "vfd-range") return t("vfd.err.range");
  if (m === "vfd-profile") return t("vfd.err.profile");
  if (m === "not connected") return t("vfd.err.notConnected");
  return m;
}

export function vfdPanelHtml(): string {
  const unitOpts = () => UNITS.map(u => `<option value="${u}" data-i18n="vfd.unit.${u}">${esc(t("vfd.unit." + u))}</option>`).join("");
  const readOpts = `<option value="holding">03</option><option value="input">04</option>`;
  const reg = (k: string, label: string, extra = "") =>
    `<label class="ws-field" ${tip(label + "Tip")}><span>${T(label)}</span><input type="text" data-r="${k}" spellcheck="false" ${extra}></label>`;
  return `
    <div class="menu-section-unified only-mill" id="vfd-section">
      <h3 class="menu-trigger">${T("vfd.title")}</h3>
      <div class="menu-body rp-box">
        <div class="tool-scope">${T("vfd.intro")}</div>

        <label class="ws-field" ${tip("vfd.linkTip")}><span>${T("vfd.link")}</span><select id="vfd-link">
          <option value="rtu" data-i18n="vfd.linkRtu">${esc(t("vfd.linkRtu"))}</option>
          <option value="tcp" data-i18n="vfd.linkTcp">${esc(t("vfd.linkTcp"))}</option>
        </select></label>
        <div id="vfd-rtu">
          <div style="display:flex; gap:6px; align-items:flex-end;">
            <label class="ws-field" style="flex:1; min-width:0;" ${tip("vfd.portTip")}><span>${T("vfd.port")}</span><select id="vfd-port"></select></label>
            <button id="vfd-scan" class="btn-secondary btn-compact" style="flex:0 0 auto;" ${tip("vfd.scanTip")}>🔄</button>
          </div>
          <div class="ws-hostport">
            <label class="ws-field"><span>${T("vfd.baud")}</span><select id="vfd-baud">
              ${[4800, 9600, 19200, 38400, 57600, 115200].map(b => `<option value="${b}">${b}</option>`).join("")}
            </select></label>
            <label class="ws-field" ${tip("vfd.parityTip")}><span>${T("vfd.parity")}</span><select id="vfd-parity">
              <option value="N" data-i18n="vfd.parityN">${esc(t("vfd.parityN"))}</option>
              <option value="E" data-i18n="vfd.parityE">${esc(t("vfd.parityE"))}</option>
              <option value="O" data-i18n="vfd.parityO">${esc(t("vfd.parityO"))}</option>
            </select></label>
          </div>
        </div>
        <label class="ws-field" id="vfd-tcp" ${tip("vfd.hostTip")}><span>${T("vfd.host")}</span><input type="text" id="vfd-host" placeholder="192.168.1.60:502" spellcheck="false"></label>
        <div class="ws-hostport">
          <label class="ws-field" ${tip("vfd.unitTip")}><span>${T("vfd.unitAddr")}</span><input type="number" id="vfd-unit" min="1" max="247" step="1"></label>
          <label class="ws-field" ${tip("vfd.profileTip")}><span>${T("vfd.profile")}</span><select id="vfd-profile"></select></label>
        </div>
        <div class="ws-hostport">
          <label class="ws-field" ${tip("vfd.maxRpmTip")}><span>${T("vfd.maxRpm")}</span><input type="number" id="vfd-max-rpm" min="1" step="1000"></label>
          <label class="ws-field" ${tip("vfd.maxHzTip")}><span>${T("vfd.maxHz")}</span><input type="number" id="vfd-max-hz" min="1" step="10"></label>
        </div>

        <details id="vfd-map" class="vfd-map">
          <summary>${T("vfd.map")}</summary>
          <div class="tool-scope">${T("vfd.mapHint")}</div>
          <div class="ws-hostport">${reg("controlReg", "vfd.r.control")}${reg("speedReg", "vfd.r.speed")}</div>
          <div class="ws-hostport">${reg("cmdFwd", "vfd.r.fwd")}${reg("cmdRev", "vfd.r.rev")}${reg("cmdStop", "vfd.r.stop")}</div>
          <label class="ws-field"><span>${T("vfd.r.speedUnit")}</span><select data-r="speedUnit">${unitOpts()}</select></label>
          <div class="ws-hostport">${reg("actualReg", "vfd.r.actual", `placeholder="–"`)}
            <label class="ws-field" ${tip("vfd.r.readTip")}><span>${T("vfd.r.read")}</span><select data-r="actualRead">${readOpts}</select></label></div>
          <label class="ws-field"><span>${T("vfd.r.actualUnit")}</span><select data-r="actualUnit">${unitOpts()}</select></label>
          <div class="ws-hostport">${reg("faultReg", "vfd.r.fault", `placeholder="–"`)}
            <label class="ws-field" ${tip("vfd.r.readTip")}><span>${T("vfd.r.read")}</span><select data-r="faultRead">${readOpts}</select></label></div>
          <button id="vfd-copy" class="btn-secondary btn-compact" ${tip("vfd.copyTip")}>⧉ ${T("vfd.copy")}</button>
        </details>

        <button id="vfd-connect" class="btn-primary"></button>

        <div id="vfd-live" style="display:none;">
          <div class="sp-state-row"><span id="vfd-state" class="sp-state sp-off"></span></div>
          <div id="vfd-fault" class="tool-scope"></div>
          <div class="prop-row" ${tip("vfd.rpmTip")}>${T("vfd.rpm")}<input type="number" id="vfd-rpm" min="0" step="100" class="prop-input">
            <button id="vfd-set" class="btn-secondary btn-compact">${T("vfd.set")}</button></div>
          <div class="sp-btns">
            <button id="vfd-fwd" class="btn-primary" ${tip("vfd.fwdTip")}>↻ ${T("vfd.fwd")}</button>
            <button id="vfd-rev" class="btn-secondary" ${tip("vfd.revTip")}>↺ ${T("vfd.rev")}</button>
          </div>
          <button id="vfd-stop" class="btn-secondary sp-stop" ${tip("vfd.stopTip")}>■ ${T("vfd.stop")}</button>
        </div>
      </div>
    </div>`;
}

const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E | null;

/** Formular aus den Einstellungen füllen */
function fill() {
  const setVal = (id: string, v: string | number) => { const el = $<HTMLInputElement>(id); if (el) el.value = String(v); };
  setVal("vfd-link", s.link);
  setVal("vfd-baud", s.baud);
  setVal("vfd-parity", s.parity);
  setVal("vfd-host", s.host);
  setVal("vfd-unit", s.unit);
  setVal("vfd-max-rpm", s.maxRpm);
  setVal("vfd-max-hz", s.maxHz);
  setVal("vfd-rpm", s.rpm);
  const sel = $<HTMLSelectElement>("vfd-profile");
  if (sel) {
    sel.innerHTML = profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")
      + `<option value="${CUSTOM}">${esc(t("vfd.custom"))}</option>`;
    if (![...sel.options].some(o => o.value === s.profile)) s.profile = profiles[0]?.id || CUSTOM;
    sel.value = s.profile;
  }
  fillMap();
  showLink();
}

/** Registerkarte anzeigen – bei eingebauten Profilen nur lesen, bei „Eigenes Profil“ bearbeitbar */
function fillMap() {
  const p = profile();
  const box = $("vfd-map");
  if (!p || !box) return;
  const edit = s.profile === CUSTOM;
  const vals: Record<string, string> = {
    controlReg: hex(p.controlReg), speedReg: hex(p.speedReg), cmdFwd: hex(p.cmdFwd), cmdRev: hex(p.cmdRev), cmdStop: hex(p.cmdStop),
    speedUnit: p.speedUnit, actualReg: p.actual ? hex(p.actual.reg) : "", actualRead: p.actual?.read || "holding",
    actualUnit: p.actualUnit, faultReg: p.fault ? hex(p.fault.reg) : "", faultRead: p.fault?.read || "holding",
  };
  box.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-r]").forEach(el => {
    el.value = vals[el.dataset.r || ""] ?? "";
    el.disabled = !edit || connected;
  });
  const copy = $<HTMLButtonElement>("vfd-copy");
  if (copy) copy.style.display = edit ? "none" : "";
  if (edit) (box as HTMLDetailsElement).open = true;
}

/** Eingaben im eigenen Profil übernehmen. false = Pflichtfeld fehlt/ungültig */
function readMap(): boolean {
  const box = $("vfd-map");
  if (!box || s.profile !== CUSTOM) return true;
  const v = (k: string) => (box.querySelector<HTMLInputElement>(`[data-r="${k}"]`)?.value || "");
  const need = ["controlReg", "speedReg", "cmdFwd", "cmdRev", "cmdStop"].map(k => num(v(k)));
  const c = s.custom;
  const unit = (x: string): SpeedUnit => (UNITS as string[]).includes(x) ? x as SpeedUnit : "hz100";
  const rd = (x: string): ReadFn => x === "input" ? "input" : "holding";
  c.speedUnit = unit(v("speedUnit"));
  c.actualUnit = unit(v("actualUnit"));
  const a = num(v("actualReg")), f = num(v("faultReg"));
  c.actual = a === null ? null : { reg: a, read: rd(v("actualRead")) };
  c.fault = f === null ? null : { reg: f, read: rd(v("faultRead")) };
  if (need.some(n => n === null)) return false;
  [c.controlReg, c.speedReg, c.cmdFwd, c.cmdRev, c.cmdStop] = need as number[];
  c.name = t("vfd.custom");
  return true;
}

function showLink() {
  const rtu = s.link === "rtu";
  const r = $("vfd-rtu"), tcp = $("vfd-tcp");
  if (r) r.style.display = rtu ? "" : "none";
  if (tcp) tcp.style.display = rtu ? "none" : "";
}

async function scanPorts() {
  const sel = $<HTMLSelectElement>("vfd-port");
  if (!sel) return;
  const ports = await listPorts();
  // Namen kommen vom USB-Gerät selbst – nie ungeprüft als HTML einsetzen
  sel.innerHTML = ports.length
    ? ports.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.chip ? " – " + esc(p.chip) : ""}</option>`).join("")
    : `<option value="">${esc(t("m.noPorts"))}</option>`;
  if (ports.some(p => p.name === s.port)) sel.value = s.port;
}

function setUi() {
  const btn = $<HTMLButtonElement>("vfd-connect");
  if (btn) {
    btn.innerHTML = connected ? `⏏ ${T("vfd.disconnect")}` : `🔌 ${T("vfd.connect")}`;
    btn.className = connected ? "btn-secondary btn-danger-outline" : "btn-primary";
  }
  const live = $("vfd-live");
  if (live) live.style.display = connected ? "" : "none";
  const section = $("vfd-section");
  section?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    "#vfd-link, #vfd-port, #vfd-scan, #vfd-baud, #vfd-parity, #vfd-host, #vfd-unit, #vfd-profile, #vfd-max-rpm, #vfd-max-hz",
  ).forEach(el => { el.disabled = connected; });
  fillMap();
}

function showStatus(st: VfdStatus | null) {
  const state = $("vfd-state"), fault = $("vfd-fault");
  if (!state || !fault) return;
  if (!st) {
    state.textContent = t("vfd.noAnswer");
    state.className = "sp-state sp-off";
    return;
  }
  const running = (st.hz ?? 0) > 0.05;
  state.textContent = st.rpm === null
    ? t("vfd.noActual")
    : t("vfd.actual", { rpm: Math.round(st.rpm), hz: (st.hz ?? 0).toFixed(1) });
  state.className = "sp-state " + (running ? "sp-on" : "sp-off");
  fault.textContent = st.fault === null ? "" : st.fault === 0 ? t("vfd.faultNone") : t("vfd.fault", { code: st.fault });
  fault.style.color = st.fault ? "var(--danger, #e5484d)" : "";
}

function startPoll() {
  stopPoll();
  failCount = 0;
  poll = window.setInterval(async () => {
    if (polling || !connected) return;
    polling = true;
    try {
      showStatus(await invoke<VfdStatus>("vfd_status"));
      failCount = 0;
    } catch (e) {
      // einmal melden, nicht jede Sekunde
      if (++failCount === 3) log(t("vfd.log.lost", { e: errText(e) }));
      if (failCount >= 3) showStatus(null);
    } finally {
      polling = false;
    }
  }, 1000);
}
function stopPoll() { if (poll !== undefined) { window.clearInterval(poll); poll = undefined; } }

async function doConnect() {
  const target = s.link === "tcp" ? "tcp://" + s.host.trim().replace(/^tcp:\/\//, "") : s.port;
  if (s.link === "tcp" ? !s.host.trim() : !s.port) { log(t("vfd.log.noTarget")); return; }
  if (!readMap()) { log(t("vfd.err.custom")); return; }
  save();
  const p = profile();
  if (!p) { log(t("vfd.err.profile")); return; }
  log(t("vfd.log.connecting", { target }));
  try {
    const st = await invoke<VfdStatus>("vfd_connect", {
      target, baud: s.baud, parity: s.parity, unit: s.unit, profile: s.profile,
      custom: s.profile === CUSTOM ? s.custom : null, maxRpm: s.maxRpm, maxHz: s.maxHz,
    });
    connected = true;
    log(t("vfd.log.connected", { name: p.name }));
    showStatus(st);
    startPoll();
  } catch (e) {
    log(t("vfd.log.failed", { e: errText(e) }));
    log(t("vfd.log.help"));
  }
  setUi();
}

async function doDisconnect() {
  stopPoll();
  try { await invoke("vfd_disconnect"); } catch { /* war schon weg */ }
  connected = false;
  log(t("vfd.log.disconnected"));
  setUi();
}

async function command(cmd: string, args: Record<string, unknown>, okKey: string, params: Record<string, string | number> = {}) {
  try {
    await invoke(cmd, args);
    log(t(okKey, params));
  } catch (e) {
    log(t("vfd.log.cmdFailed", { e: errText(e) }));
  }
}

export function initVfdPanel(appendToConsole: (s: string) => void) {
  log = appendToConsole;
  load();
  const section = $("vfd-section");
  if (!section) return;

  void (async () => {
    try { profiles = await invoke<VfdProfile[]>("vfd_profiles"); } catch { profiles = []; }
    fill();
    setUi();
    await scanPorts();
  })();

  section.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const n = (v: string, min: number, max: number, def: number) => { const x = Number(v); return Number.isFinite(x) && x >= min ? Math.min(max, x) : def; };
    switch (el.id) {
      case "vfd-link": s.link = el.value === "tcp" ? "tcp" : "rtu"; showLink(); break;
      case "vfd-port": s.port = el.value; break;
      case "vfd-baud": s.baud = n(el.value, 1200, 921600, 9600); break;
      case "vfd-parity": s.parity = el.value === "E" ? "E" : el.value === "O" ? "O" : "N"; break;
      case "vfd-host": s.host = el.value.trim(); break;
      case "vfd-unit": s.unit = Math.round(n(el.value, 1, 247, 1)); el.value = String(s.unit); break;
      case "vfd-profile": s.profile = el.value; fillMap(); break;
      case "vfd-max-rpm": s.maxRpm = n(el.value, 1, 100000, 24000); el.value = String(s.maxRpm); break;
      case "vfd-max-hz": s.maxHz = n(el.value, 1, 3000, 400); el.value = String(s.maxHz); break;
      case "vfd-rpm": s.rpm = n(el.value, 0, s.maxRpm, 0); el.value = String(s.rpm); break;
      default: if (el.dataset.r) readMap();
    }
    save();
  });

  $("vfd-scan")?.addEventListener("click", () => void scanPorts());
  $("vfd-port")?.addEventListener("focus", () => { if (!connected) void scanPorts(); });
  $("vfd-copy")?.addEventListener("click", () => {
    const p = profile();
    if (!p) return;
    s.custom = { ...JSON.parse(JSON.stringify(p)), id: CUSTOM, name: t("vfd.custom") };
    s.profile = CUSTOM;
    save();
    fill();
  });
  $("vfd-connect")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try { await (connected ? doDisconnect() : doConnect()); } finally { btn.disabled = false; }
  });
  $("vfd-set")?.addEventListener("click", () => {
    const rpm = Math.max(0, Math.min(s.maxRpm, Number($<HTMLInputElement>("vfd-rpm")?.value) || 0));
    s.rpm = rpm;
    save();
    void command("vfd_set_speed", { rpm }, "vfd.log.speed", { rpm });
  });
  const dir = (direction: string, key: string) => () => void command("vfd_set_direction", { direction }, key);
  $("vfd-fwd")?.addEventListener("click", dir("fwd", "vfd.log.fwd"));
  $("vfd-rev")?.addEventListener("click", dir("rev", "vfd.log.rev"));
  $("vfd-stop")?.addEventListener("click", dir("stop", "vfd.log.stop"));
}
