/**
 * SMARTE WERKSTATT (Reiter "Maschine"): Absaugung, Kompressor … mit dem Job ein- und ausschalten
 *
 * Geräte an smarten Steckdosen (Shelly, Tasmota, Home Assistant …) per HTTP oder MQTT.
 * Job startet → „Ein“, Job endet (fertig/abgebrochen/getrennt) → nach dem Nachlauf „Aus“.
 * Das Schalten selbst macht Rust (workshop.rs) in eigenen Threads – Fehler stören den Job nie,
 * sie erscheinen nur in der Konsole. Passwörter/Schlüssel stehen nie in der Konsole.
 * Gespeichert unter cnc_craft_workshop_devices (wird über settingsStore.ts mitgesichert).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, T, tip } from "../i18n/i18n";

const KEY = "cnc_craft_workshop_devices";

export interface WorkshopDevice {
  id: string;
  name: string;
  kind: "http" | "mqtt";
  enabled: boolean;
  delay: number;          // Nachlauf nach dem Job (s)
  method: string;         // GET / POST / PUT
  onUrl: string; onBody: string; offUrl: string; offBody: string;
  token: string;          // optional „Bearer“-Schlüssel (Home Assistant)
  host: string; port: number; user: string; password: string;
  topic: string; onPayload: string; offPayload: string;
}

/** Vorlagen: füllen die Felder vor („IP“ durch die Adresse der Steckdose ersetzen) */
const PRESETS: Record<string, Partial<WorkshopDevice>> = {
  shelly1: { kind: "http", method: "GET", onUrl: "http://IP/relay/0?turn=on", offUrl: "http://IP/relay/0?turn=off" },
  shelly2: { kind: "http", method: "GET", onUrl: "http://IP/rpc/Switch.Set?id=0&on=true", offUrl: "http://IP/rpc/Switch.Set?id=0&on=false" },
  tasmota: { kind: "http", method: "GET", onUrl: "http://IP/cm?cmnd=Power%20On", offUrl: "http://IP/cm?cmnd=Power%20Off" },
  tasmotaMqtt: { kind: "mqtt", host: "IP", port: 1883, topic: "cmnd/tasmota/POWER", onPayload: "ON", offPayload: "OFF" },
  haWebhook: { kind: "http", method: "POST", onUrl: "http://homeassistant.local:8123/api/webhook/cnc_on", offUrl: "http://homeassistant.local:8123/api/webhook/cnc_off" },
  http: { kind: "http", method: "GET" },
  mqtt: { kind: "mqtt", port: 1883 },
};

function blank(): WorkshopDevice {
  return {
    id: "d" + Date.now().toString(36) + Math.floor(Math.random() * 1000), name: "", kind: "http", enabled: true, delay: 30,
    method: "GET", onUrl: "", onBody: "", offUrl: "", offBody: "", token: "",
    host: "", port: 1883, user: "", password: "", topic: "", onPayload: "ON", offPayload: "OFF",
  };
}

let devices: WorkshopDevice[] = [];
let log: (s: string) => void = () => {};

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function load(): WorkshopDevice[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (Array.isArray(arr)) return arr.filter(d => d && typeof d === "object").map(d => ({ ...blank(), ...d, kind: d.kind === "mqtt" ? "mqtt" : "http" }));
  } catch { /* kaputt */ }
  return [];
}

/** Speichern und an Rust geben (der schaltet beim nächsten Job mit diesem Stand) */
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(devices)); } catch { /* gesperrt */ }
  void push();
}

async function push() {
  try { await invoke("workshop_set_devices", { devices }); } catch { /* im Browser ohne Tauri */ }
}

/** Fehler aus Rust lesbar machen (bekannte Kürzel übersetzt) */
function errText(e: unknown): string {
  const k = "ws.err." + String(e);
  return t(k) !== k ? t(k) : String(e);
}

function label(d: Pick<WorkshopDevice, "name">): string {
  return d.name.trim() || t("ws.unnamed");
}

export function workshopPanelHtml(): string {
  const opt = (k: string) => `<option value="${k}" data-i18n="ws.preset.${k}">${esc(t("ws.preset." + k))}</option>`;
  return `
    <div class="menu-section-unified" id="ws-section">
      <h3 class="menu-trigger">${T("ws.title")}</h3>
      <div class="menu-body rp-box">
        <div class="tool-scope">${T("ws.intro")}</div>
        <div id="ws-list" class="ws-list"></div>
        <div class="ws-add">
          <select id="ws-preset" ${tip("ws.presetTip")}>${Object.keys(PRESETS).map(opt).join("")}</select>
          <button id="ws-add" class="btn-secondary btn-compact">＋ ${T("ws.add")}</button>
        </div>
      </div>
    </div>`;
}

function field(k: keyof WorkshopDevice, labelKey: string, d: WorkshopDevice, type = "text", ph = "") {
  return `<label class="ws-field" ${tip(labelKey + "Tip")}><span>${T(labelKey)}</span>` +
    `<input type="${type}" data-k="${k}" value="${esc(String(d[k] ?? ""))}" ${ph ? `placeholder="${esc(ph)}"` : ""} ${type === "password" ? `autocomplete="off"` : ""} spellcheck="false"></label>`;
}

function deviceHtml(d: WorkshopDevice, i: number): string {
  const http = `
    <label class="ws-field"><span>${T("ws.method")}</span><select data-k="method">
      ${["GET", "POST", "PUT"].map(m => `<option ${d.method === m ? "selected" : ""}>${m}</option>`).join("")}
    </select></label>
    ${field("onUrl", "ws.onUrl", d, "text", "http://192.168.1.50/relay/0?turn=on")}
    ${d.method !== "GET" ? field("onBody", "ws.onBody", d) : ""}
    ${field("offUrl", "ws.offUrl", d, "text", "http://192.168.1.50/relay/0?turn=off")}
    ${d.method !== "GET" ? field("offBody", "ws.offBody", d) : ""}
    ${field("token", "ws.token", d, "password")}`;
  const mqtt = `
    <div class="ws-hostport">${field("host", "ws.host", d, "text", "192.168.1.10")}${field("port", "ws.port", d, "number")}</div>
    <div class="ws-hostport">${field("user", "ws.user", d)}${field("password", "ws.password", d, "password")}</div>
    ${field("topic", "ws.topic", d, "text", "cmnd/tasmota/POWER")}
    <div class="ws-hostport">${field("onPayload", "ws.onPayload", d)}${field("offPayload", "ws.offPayload", d)}</div>`;
  return `
    <div class="ws-dev ${d.enabled ? "" : "ws-off"}" data-i="${i}">
      <div class="ws-head">
        <input type="checkbox" data-k="enabled" ${d.enabled ? "checked" : ""} ${tip("ws.enabledTip")}>
        <input type="text" data-k="name" class="ws-name" value="${esc(d.name)}" placeholder="${esc(t("ws.namePh"))}" data-i18n-ph="ws.namePh">
        <select data-k="kind" ${tip("ws.kindTip")}>
          <option value="http" ${d.kind === "http" ? "selected" : ""}>HTTP</option>
          <option value="mqtt" ${d.kind === "mqtt" ? "selected" : ""}>MQTT</option>
        </select>
        <button class="btn-secondary btn-compact" data-act="del" ${tip("ws.delTip")}>🗑</button>
      </div>
      ${d.kind === "mqtt" ? mqtt : http}
      <label class="prop-row" ${tip("ws.delayTip")}>${T("ws.delay")}<input type="number" data-k="delay" class="prop-input" min="0" max="3600" step="5" value="${esc(String(d.delay))}"></label>
      <div class="rp-grid2">
        <button class="btn-secondary btn-compact" data-act="on">⚡ ${T("ws.testOn")}</button>
        <button class="btn-secondary btn-compact" data-act="off">⭘ ${T("ws.testOff")}</button>
      </div>
    </div>`;
}

function render() {
  const list = document.getElementById("ws-list");
  if (!list) return;
  list.innerHTML = devices.length ? devices.map(deviceHtml).join("") : `<div class="tool-scope">${T("ws.none")}</div>`;
}

function readField(el: HTMLInputElement | HTMLSelectElement, d: WorkshopDevice): boolean {
  const k = el.dataset.k as keyof WorkshopDevice;
  if (!k) return false;
  const rec = d as unknown as Record<string, unknown>;
  if (k === "enabled") rec[k] = (el as HTMLInputElement).checked;
  else if (k === "delay") rec[k] = Math.max(0, Math.min(3600, Number(el.value) || 0));
  else if (k === "port") rec[k] = Math.max(1, Math.min(65535, Math.round(Number(el.value) || 1883)));
  else rec[k] = el.value;
  // Felder ändern sich (HTTP ↔ MQTT, Text nur bei POST/PUT) → neu zeichnen
  return k === "kind" || k === "method" || k === "enabled";
}

async function test(d: WorkshopDevice, on: boolean) {
  const name = label(d);
  try {
    await invoke("workshop_test", { device: d, on });
    log(t(on ? "ws.log.testOn" : "ws.log.testOff", { name }));
  } catch (e) {
    log(t("ws.log.fail", { name, e: errText(e) }));
  }
}

export function initWorkshopPanel(appendToConsole: (s: string) => void) {
  log = appendToConsole;
  devices = load();
  render();
  void push();

  const list = document.getElementById("ws-list");
  list?.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const box = el.closest<HTMLElement>(".ws-dev");
    const d = box ? devices[Number(box.dataset.i)] : undefined;
    if (!d) return;
    const again = readField(el, d);
    save();
    if (again) render();
  });
  list?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    const box = btn?.closest<HTMLElement>(".ws-dev");
    if (!btn || !box) return;
    const i = Number(box.dataset.i);
    const d = devices[i];
    if (!d) return;
    // noch nicht übernommene Eingaben (ohne „change“) zuerst lesen
    box.querySelectorAll<HTMLInputElement>("input[data-k]").forEach(el => readField(el, d));
    if (btn.dataset.act === "del") {
      if (!confirm(t("ws.delConfirm", { name: label(d) }))) return;
      devices.splice(i, 1);
      save();
      render();
    } else {
      save();
      btn.disabled = true;
      void test(d, btn.dataset.act === "on").finally(() => { btn.disabled = false; });
    }
  });
  document.getElementById("ws-add")?.addEventListener("click", () => {
    const key = (document.getElementById("ws-preset") as HTMLSelectElement | null)?.value || "http";
    const d = { ...blank(), ...(PRESETS[key] || {}) };
    d.name = t("ws.preset." + key);
    devices.push(d);
    save();
    render();
  });

  // Ergebnisse aus Rust (Job-Start/-Ende) in die Konsole – nur Name und Fehlertext, nie Adressen/Passwörter
  try {
    void listen("workshop-action", (ev: any) => {
      const p = ev.payload || {};
      const name = String(p.name || "").trim() || t("ws.unnamed");
      if (p.error) log(t("ws.log.fail", { name, e: errText(p.error) }));
      else log(t(p.on ? "ws.log.on" : "ws.log.off", { name }));
    }).catch(() => { /* im Browser-Test ohne Tauri */ });
  } catch { /* im Browser-Test ohne Tauri */ }
}
