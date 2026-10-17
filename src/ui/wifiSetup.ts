/**
 * WLAN EINRICHTEN (Reiter „Maschine“ → Verbindung → 📶 WLAN einrichten)
 *
 * Heimnetz-Name und Passwort (oder eigenes WLAN des Boards) sicher ans Board schicken –
 * auch mit Sonderzeichen, die GRBL sonst unterwegs „verschluckt“ (! ? ~, Umlaute, ( ) ;).
 * Welche Zeichen wo Probleme machen und wie sie umgangen werden: wifiCodec.ts.
 *
 * Die Zeile mit dem Passwort wird nie ins Protokoll/die Konsole geschrieben.
 * 📡 Suchen: das Board selbst sucht WLANs in der Nähe ([ESP410]) – Name anklicken statt abtippen.
 */
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n/i18n";
import { machine, sendAndWait, MACHINE_EVENT } from "../machine";
import { analyze, planWifi, WifiFw, WifiMode, WifiPlan, parseApList, signalBars, ApInfo, hostSlug, isDefaultHost, hostLine } from "../wifiCodec";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const KEY_HOST = "cnc_craft_wifi_web_host";
const KEY_BOARD = "cnc_craft_wifi_board";

/** Board-Auswahl im WLAN-Dialog (falls die Erkennung danebenliegt) */
export type WifiBoard = "auto" | "mks" | "esp32" | "fluidnc" | "grblhal";
const BOARD_CHOICES: WifiBoard[] = ["auto", "mks", "esp32", "fluidnc", "grblhal"];

/** Was ist erkannt? */
function detectBoard(): WifiBoard | "none" {
  const fw = wifiFirmware();
  if (fw === "esp32") return isMksWifi() ? "mks" : "esp32";
  return fw;
}

/** Gewählt oder erkannt -> Firmware-Art + MKS-Nummern ja/nein */
function resolveBoard(choice: WifiBoard): { fw: WifiFw; mks: boolean } {
  const b = choice === "auto" ? detectBoard() : choice;
  if (b === "none") return { fw: "none", mks: false };
  if (b === "mks") return { fw: "esp32", mks: true };
  return { fw: b as WifiFw, mks: false };
}

/** Welche Firmware-Familie hängt dran? */
export function wifiFirmware(): WifiFw {
  if (!machine.connected || machine.protocol !== "grbl") return "none";
  if (machine.firmware === "FluidNC") return "fluidnc";
  if (machine.firmware === "grblHAL") return "grblhal";
  if (machine.firmware === "Grbl_ESP32" || /MKS|DLC32|ESP32/i.test(machine.info.name + " " + machine.info.fw + " " + machine.info.raw.join(" "))) return "esp32";
  // Netzwerk-Verbindung = hat sicher WLAN; Rest (Arduino-GRBL) hat keins
  if (machine.port.startsWith("tcp://")) return "esp32";
  return "none";
}

/**
 * MKS DLC32 MAX (und neuere MKS-Firmware): WLAN steht in $50–$54 statt [ESP100]/[ESP101].
 * Erkennbar an $53 in den Einstellungen oder am Namen „DLC32 MAX“.
 */
export function isMksWifi(): boolean {
  return machine.settings.has("$53") || /DLC32\s*MAX/i.test(`${machine.info.name} ${machine.info.fw}`);
}

/**
 * Das Board nach WLANs in der Nähe suchen lassen ([ESP410]).
 * Der erste Aufruf startet oft erst die Suche und liefert eine leere Liste – dann kurz warten und nochmal.
 */
export async function scanBoardNetworks(cancelled: () => boolean = () => false): Promise<ApInfo[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (cancelled() || !machine.connected) return [];
    const lines: string[] = [];
    const grab = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d?.type === "text" && d.data?.text) lines.push(String(d.data.text));
    };
    window.addEventListener(MACHINE_EVENT, grab);
    try {
      const a = await sendAndWait("[ESP410]", 12000, true);
      await new Promise(r => setTimeout(r, 400)); // Rest der Antwort abwarten
      if (!a.ok && !lines.length) throw new Error("scan-failed");
    } finally {
      window.removeEventListener(MACHINE_EVENT, grab);
    }
    const aps = parseApList(lines);
    if (aps.length) return aps;
    if (cancelled()) return [];
    await new Promise(r => setTimeout(r, 2500));
  }
  return [];
}

/** Adresse, unter der das Board sein eigenes WLAN aufmacht (ESP32-Boards, solange sie kein Heimnetz kennen) */
export const BOARD_AP_IP = "192.168.4.1";

/** Verbunden über WLAN? Dann ist die Weboberfläche unter derselben IP */
function tcpHost(): string {
  return machine.port.startsWith("tcp://") ? machine.port.slice(6).replace(/:\d+$/, "") : "";
}

/** Adresse der Weboberfläche: bei WLAN-Verbindung die IP der Verbindung, sonst das eigene WLAN des Boards */
function defaultHost(): string {
  return tcpHost() || BOARD_AP_IP;
}

/** Befehl über die Leitung schicken und die Antwortzeilen einsammeln */
async function ask(cmd: string): Promise<string[]> {
  const lines: string[] = [];
  const grab = (e: Event) => {
    const d = (e as CustomEvent).detail;
    const txt = d?.type === "text" ? String(d.data?.text || "") : d?.type === "setting" ? `${d.data?.key}=${d.data?.value}` : "";
    if (txt) lines.push(txt.trim());
  };
  window.addEventListener(MACHINE_EVENT, grab);
  try { await sendAndWait(cmd, 3000, true); await new Promise(r => setTimeout(r, 150)); }
  catch { /* egal */ }
  finally { window.removeEventListener(MACHINE_EVENT, grab); }
  return lines;
}

export interface BoardWifi { mode: string; ip: string; apName: string }

/**
 * Was macht das WLAN des Boards gerade?
 * 1. "$I" (Grbl_ESP32 / MKS DLC32 / MKS MAX) meldet z. B.
 *      [MSG:Mode=STA:SSID=MeinNetz:Status=Connected:IP=192.168.99.38:MAC=…]
 *      [MSG:Mode=AP:SSDI=MKS_DLC:IP=192.168.4.1:MAC=…]
 * 2. Sonst ESP3D-Befehle (FluidNC u. a.): [ESP110] Funk-Art, [ESP111] aktuelle IP
 */
export function parseWifiInfo(lines: string[]): BoardWifi | null {
  let res: BoardWifi | null = null;
  for (const l of lines) {
    const m = l.match(/Mode=(STA|AP)\b(.*)/i);
    if (!m) continue;
    const mode = m[1].toUpperCase();
    const ip = (m[2].match(/IP=(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || "";
    const name = (m[2].match(/:SS[DI]{2}=([^:\]]*)/i) || [])[1] || "";
    const connected = !/Status=Not/i.test(m[2]);
    if (mode === "STA" && connected && ip && ip !== "0.0.0.0") return { mode, ip, apName: res?.apName || "" };
    if (mode === "AP") res = { mode, ip: ip || BOARD_AP_IP, apName: name };
    else if (!res) res = { mode, ip: "", apName: "" };
  }
  return res;
}

export async function readBoardWifi(fw: WifiFw): Promise<BoardWifi> {
  if (fw === "esp32") {
    const r = parseWifiInfo(await ask("$I"));
    if (r) return r;
  }
  const pick = (lines: string[], re: RegExp) => { for (const l of lines) { const m = l.match(re); if (m) return m[1].trim(); } return ""; };
  const mode = pick(await ask("[ESP110]"), /(?:ESP110|Radio\/Mode|WiFi\/Mode)\s*=\s*(\S+)/i);
  const ip = pick(await ask("[ESP111]"), /^(?:IP:?\s*)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  return { mode: mode.toUpperCase(), ip: ip === "0.0.0.0" ? "" : ip, apName: "" };
}

/** Der Rechner ist im 192.168.4.x-Netz des Boards? (dann ist die Board-WLAN-Adresse richtig) */
function isApIp(ip: string): boolean { return ip === BOARD_AP_IP; }

export function openWifiSetup(log: (s: string) => void) {
  document.getElementById("wifi-overlay")?.remove();
  let boardChoice: WifiBoard = "auto";
  try { const v = localStorage.getItem(KEY_BOARD) as WifiBoard | null; if (v && BOARD_CHOICES.includes(v)) boardChoice = v; } catch { /* egal */ }
  // ohne Verbindung keine Auswahl erzwingen
  let { fw, mks } = machine.connected ? resolveBoard(boardChoice) : { fw: "none" as WifiFw, mks: false };
  const detected = detectBoard();
  const boardLabel = (b: WifiBoard | "none") => t("wifi.b." + b);
  const fwName = [machine.firmware, machine.version].filter(Boolean).join(" ") + (machine.info.name ? ` · ${machine.info.name}` : "");
  const ov = document.createElement("div");
  ov.id = "wifi-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box wifi-box" role="dialog">
      <h3>📶 ${esc(t("wifi.title"))}</h3>
      <div class="wifi-board">${esc(t("wifi.board", { fw: fwName || "?" }))}</div>
      <label class="dlg-row"><span>${esc(t("wifi.b.label"))}</span>
        <select id="wifi-board-sel" data-tip="${esc(t("wifi.b.tip"))}">
          ${BOARD_CHOICES.map(b => `<option value="${b}" ${b === boardChoice ? "selected" : ""}>${esc(b === "auto" ? t("wifi.b.auto", { b: boardLabel(detected) }) : boardLabel(b))}</option>`).join("")}
        </select></label>
      <div class="wifi-modes">
        <label><input type="radio" name="wifi-mode" value="sta" checked> 🏠 ${esc(t("wifi.sta"))}</label>
        <label><input type="radio" name="wifi-mode" value="ap"> 📡 ${esc(t("wifi.ap"))}</label>
      </div>
      <label class="dlg-row"><span>${esc(t("wifi.ssid"))}</span>
        <span class="wifi-pw"><input id="wifi-ssid" type="text" autocomplete="off" spellcheck="false"><button type="button" id="wifi-scan" class="btn-secondary" data-tip="${esc(t("wifi.scanTip"))}">📡</button></span></label>
      <div id="wifi-aps" class="wifi-aps" style="display:none;"></div>
      <label class="dlg-row"><span>${esc(t("wifi.pw"))}</span>
        <span class="wifi-pw"><input id="wifi-pw" type="password" autocomplete="new-password" spellcheck="false"><button type="button" id="wifi-eye" class="btn-secondary" data-tip="${esc(t("wifi.showPw"))}">👁</button></span></label>
      <div id="wifi-check" class="wifi-check"></div>
      <label class="dlg-row"><span>${esc(t("wifi.name"))}</span>
        <input id="wifi-name" type="text" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${esc(t("wifi.namePh"))}" data-tip="${esc(t("wifi.nameTip"))}"></label>
      <div id="wifi-name-hint" class="wifi-note"></div>
      <div id="wifi-guide" class="wifi-guide" style="display:none;"></div>
      <label class="dlg-row" id="wifi-host-row" style="display:none;"><span>${esc(t("wifi.host"))}</span>
        <span class="wifi-pw"><input id="wifi-host" type="text" placeholder="192.168.4.1" spellcheck="false"><button type="button" id="wifi-ping" class="btn-secondary" data-tip="${esc(t("wifi.pingTip"))}">🔎</button></span></label>
      <div id="wifi-ping-res" class="wifi-note"></div>
      <details class="wifi-cmds"><summary>${esc(t("wifi.cmds"))}</summary><pre id="wifi-cmds"></pre></details>
      <div id="wifi-result" class="wifi-result"></div>
      <div class="dlg-buttons">
        <button id="wifi-cancel" class="btn-secondary" style="flex:1;">${esc(t("dlg.cancel"))}</button>
        <button id="wifi-send" class="btn-primary" style="flex:2;">📶 ${esc(t("wifi.send"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = <T extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as T;
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  q("wifi-cancel").onclick = close;
  q("wifi-host").value = defaultHost();
  const oldHost = machine.info.host || "";
  // Standard-Namen ab Werk nicht vorbelegen (sonst würde „mks_grbl“ unbemerkt zu „mks-grbl“)
  q("wifi-name").value = oldHost && !isDefaultHost(oldHost) ? oldHost : "";

  // ---- Erst-Einrichtung über das eigene WLAN des Boards ----
  let apName = "";
  let state: BoardWifi | null = null;
  let stateAsked = false;
  const guide = q("wifi-guide");
  const showGuide = async () => {
    if (tcpHost()) { guide.style.display = "none"; return; }   // per WLAN verbunden: IP ist bekannt
    guide.style.display = "";
    const name = apName || (fw === "grblhal" ? "" : "MKS_DLC");
    // Zustand des Boards: im Heimnetz (mit IP) oder eigenes WLAN an?
    const inHome = !!state && !!state.ip && !isApIp(state.ip) && state.mode !== "AP";
    const apOn = !!state && (state.mode === "AP" || isApIp(state.ip));
    const now = !state ? `<div class="wifi-g-now">${esc(t("wifi.g.reading"))}</div>`
      : inHome ? `<div class="wifi-g-now warn">${esc(t("wifi.g.nowHome", { ip: state.ip }))}</div>`
      : apOn ? `<div class="wifi-g-now ok">${esc(t("wifi.g.nowAp", { ap: name }))}</div>`
      : `<div class="wifi-g-now">${esc(t("wifi.g.nowUnknown"))}</div>`;
    guide.innerHTML = `
      ${inHome ? "" : `<b>${esc(t("wifi.g.title"))}</b>`}
      ${now}
      ${inHome ? "" : `<ol>
        <li>${esc(t("wifi.g.s1", { ap: name || "?" }))}</li>
        <li>${esc(t("wifi.g.s2", { ip: BOARD_AP_IP }))}</li>
        <li>${esc(t("wifi.g.s3"))}</li>
      </ol>`}
      <div class="wifi-g-btns">
        <button type="button" id="wifi-ap-on" class="btn-secondary" data-tip="${esc(t("wifi.g.apOnTip"))}">📡 ${esc(t("wifi.g.apOn"))}</button>
      </div>`;
    q<HTMLButtonElement>("wifi-ap-on").onclick = async () => {
      if (!window.confirm(t("wifi.g.apOnConfirm"))) return;
      const cmds = fw === "fluidnc" ? ["$WiFi/Mode=AP", "$Bye"] : fw === "grblhal" ? ["$73=2"]
        : mks ? ["[ESP110]AP", "$50=1", "[ESP444]RESTART"] : ["[ESP110]AP", "[ESP444]RESTART"];
      for (const c of cmds) { try { await sendAndWait(c, 3000, true); log(t("wifi.logSent", { line: c, via: "GRBL" })); } catch { /* Neustart */ } }
      log(t(fw === "grblhal" ? "wifi.g.apOnHal" : "wifi.g.apOnDone"));
      q("wifi-ping-res").textContent = t(fw === "grblhal" ? "wifi.g.apOnHal" : "wifi.g.apOnDone");
      // ab jetzt gilt die feste Adresse im WLAN des Boards
      state = { mode: "AP", ip: BOARD_AP_IP, apName };
      q("wifi-host").value = BOARD_AP_IP;
      void showGuide();
      startWatch();
    };
    // Zustand und Namen des Board-WLANs vom Board holen (einmal)
    if (!stateAsked && machine.connected && !tcpHost() && fw !== "grblhal") {
      stateAsked = true;
      state = await readBoardWifi(fw);
      if (state.apName) apName = state.apName;
      // Board ist schon in einem Netz: dessen IP vorschlagen (geht, wenn der Mac im selben Netz ist)
      if (state.ip && document.activeElement !== q("wifi-host")) q("wifi-host").value = state.ip;
      void showGuide();
      startWatch();
    }
  };

  // Adresse alle paar Sekunden prüfen – so sieht man sofort, wenn der Mac im richtigen WLAN ist
  let watch: ReturnType<typeof setInterval> | null = null;
  const startWatch = () => {
    if (watch) return;
    let busy = false;
    watch = setInterval(async () => {
      if (!document.body.contains(ov)) { if (watch) clearInterval(watch); watch = null; return; }
      if (busy || q("wifi-host-row").style.display === "none") return;
      // nur solange das Board noch nicht antwortet, und nicht während gesendet wird
      if (q("wifi-ping-res").classList.contains("wifi-ok") || q<HTMLButtonElement>("wifi-send").disabled) return;
      const h = q("wifi-host").value.trim();
      if (!h) return;
      busy = true;
      await ping(h, true);
      busy = false;
    }, 4000);
  };

  /** Ist die Weboberfläche erreichbar? ([ESP800] = Firmware-Info, ändert nichts) */
  const ping = async (host: string, quiet = false): Promise<boolean> => {
    const out = q("wifi-ping-res");
    if (!quiet) { out.className = "wifi-note"; out.textContent = t("wifi.pinging", { ip: host }); }
    try {
      await invoke<string>("esp_web_command", { host, command: "[ESP800]" });
      out.className = "wifi-note wifi-ok";
      out.textContent = `✓ ${t("wifi.pingOk", { ip: host })}`;
      return true;
    } catch {
      out.className = "wifi-note wifi-bad";
      out.textContent = `✗ ${t(isApIp(host) ? "wifi.pingFailAp" : "wifi.pingFail", { ip: host, ap: apName || "MKS_DLC" })}`;
      return false;
    }
  };
  q("wifi-host").addEventListener("input", () => { const o = q("wifi-ping-res"); o.className = "wifi-note"; o.textContent = ""; });
  q("wifi-ping").onclick = () => { const h = q("wifi-host").value.trim(); if (h) void ping(h); };
  q("wifi-eye").onclick = () => { const p = q("wifi-pw"); p.type = p.type === "password" ? "text" : "password"; };

  // ---- WLANs in der Nähe (sucht das Board selbst) ----
  const apBox = q("wifi-aps");
  const scanBtn = q<HTMLButtonElement>("wifi-scan");
  const doScan = async () => {
    if (scanBtn.disabled) return;
    scanBtn.disabled = true;
    apBox.style.display = "";
    apBox.innerHTML = `<div class="net-find-busy"><span class="net-spin"></span>${esc(t("wifi.scanning"))}</div>`;
    try {
      const aps = await scanBoardNetworks(() => !document.body.contains(ov));
      apBox.innerHTML = aps.length
        ? aps.map(a => `<button type="button" class="wifi-ap" data-ssid="${esc(a.ssid)}">
            <span class="wifi-ap-bars" title="${a.signal} %">${signalBars(a.signal)}</span>
            <span class="wifi-ap-name">${esc(a.ssid)}</span>
            <span class="wifi-ap-lock">${a.secure ? "🔒" : esc(t("wifi.open"))}</span></button>`).join("")
          + `<div class="wifi-note">${esc(t("wifi.scanHint"))}</div>`
        : `<div class="wifi-note">${esc(t("wifi.scanNone"))}</div>`;
      apBox.querySelectorAll<HTMLButtonElement>(".wifi-ap").forEach(b => b.addEventListener("click", () => {
        q("wifi-ssid").value = b.dataset.ssid!;
        apBox.style.display = "none";
        refresh();
        q("wifi-pw").focus();
      }));
    } catch {
      apBox.innerHTML = `<div class="wifi-note">${esc(t("wifi.scanFailed"))}</div>`;
    } finally {
      scanBtn.disabled = false;
    }
  };
  scanBtn.onclick = doScan;

  const mode = () => (ov.querySelector<HTMLInputElement>("input[name=wifi-mode]:checked")?.value || "sta") as WifiMode;
  let plan: WifiPlan;

  const refresh = () => {
    const ssid = q("wifi-ssid").value, pw = q("wifi-pw").value, host = q("wifi-host").value.trim();
    // Weboberfläche zunächst als möglich annehmen, damit der Weg dorthin angezeigt wird
    const slug = hostSlug(q("wifi-name").value);
    const newHost = slug && slug !== oldHost && slug !== hostSlug(oldHost) ? slug : "";
    plan = planWifi(fw, mode(), ssid, pw, true, machine.settings.get("$39") ?? null, mks, newHost);
    // nur umbenennen (ohne WLAN-Daten): nur den Namen schicken
    const nameOnly = !ssid && !!newHost && fw !== "none";
    if (nameOnly) plan = { route: "serial", lines: [hostLine(fw, newHost)], secret: [], restart: fw === "fluidnc" ? "$Bye" : fw === "esp32" ? "[ESP444]RESTART" : "", notes: ["wifi.note.nameOnly"], error: "" };
    const nh = q("wifi-name-hint");
    nh.className = "wifi-note";
    nh.textContent = slug
      ? (slug !== q("wifi-name").value.trim() ? t("wifi.nameAs", { h: slug }) + " " : "") + t("wifi.nameLocal", { h: slug })
      : (oldHost && isDefaultHost(oldHost) ? t("wifi.nameDefault", { h: oldHost }) : "");
    if (!slug && oldHost && isDefaultHost(oldHost)) nh.className = "wifi-note wifi-warn";
    const r = analyze(ssid + pw);
    const chips: string[] = [];
    if (r.realtime.length) chips.push(`<span class="wifi-chip warn">${esc(r.realtime.join(" "))} – ${esc(t("wifi.c.realtime"))}</span>`);
    if (r.nonAscii.length) chips.push(`<span class="wifi-chip warn">${esc(r.nonAscii.join(" "))} – ${esc(t("wifi.c.nonAscii"))}</span>`);
    if (r.comment.length) chips.push(`<span class="wifi-chip">${esc(r.comment.join(" "))} – ${esc(t("wifi.c.comment"))}</span>`);
    if (r.space) chips.push(`<span class="wifi-chip">␣ – ${esc(t("wifi.c.space"))}</span>`);
    const okLine = plan.error
      ? `<div class="wifi-bad">✗ ${esc(t(plan.error))}</div>`
      : `<div class="wifi-ok">✓ ${esc(t(plan.route === "web" ? "wifi.route.web" : "wifi.route.serial"))}</div>`;
    q("wifi-check").innerHTML = (ssid || pw ? `<div class="wifi-chips">${chips.join("") || `<span class="wifi-chip ok">${esc(t("wifi.c.allOk"))}</span>`}</div>` : "")
      + (ssid ? okLine : "") + plan.notes.map(n => `<div class="wifi-note">${esc(t(n))}</div>`).join("");
    const web = plan.route === "web" && !plan.error;
    q("wifi-host-row").style.display = web ? "" : "none";
    if (web && guide.style.display === "none" && !tcpHost()) void showGuide();
    if (!web) { guide.style.display = "none"; q("wifi-ping-res").textContent = ""; }
    q("wifi-cmds").textContent = plan.lines.map((l, i) => plan.secret.includes(i) ? l.replace(/(Password=|\]|=)(.*)$/, (_m, a) => a + "••••••••") : l).join("\n")
      + (plan.route === "web" ? `\n(→ http://${host || "IP"}/command?plain=…)` : "");
    const needHost = plan.route === "web" && !host;
    q<HTMLButtonElement>("wifi-send").disabled = !!plan.error || (!ssid && !nameOnly) || needHost || fw === "none";
  };
  q<HTMLSelectElement>("wifi-board-sel").addEventListener("change", () => {
    boardChoice = q<HTMLSelectElement>("wifi-board-sel").value as WifiBoard;
    try { localStorage.setItem(KEY_BOARD, boardChoice); } catch { /* egal */ }
    if (machine.connected) ({ fw, mks } = resolveBoard(boardChoice));
    refresh();
  });
  ov.querySelectorAll("input").forEach(i => i.addEventListener("input", refresh));
  ov.querySelectorAll<HTMLInputElement>("input[name=wifi-mode]").forEach(i => i.addEventListener("change", refresh));
  refresh();
  setTimeout(() => q("wifi-ssid").focus(), 0);
  // Board mit WLAN: gleich nach Netzen suchen (nur für „In mein Heimnetz“ sinnvoll)
  if (fw !== "none") void doScan();
  ov.querySelectorAll<HTMLInputElement>("input[name=wifi-mode]").forEach(i => i.addEventListener("change", () => {
    if (mode() === "ap") apBox.style.display = "none";
    scanBtn.style.display = mode() === "sta" ? "" : "none";
  }));

  q("wifi-send").onclick = async () => {
    refresh();
    if (plan.error) return;
    const btn = q<HTMLButtonElement>("wifi-send");
    btn.disabled = true;
    const res = q("wifi-result");
    res.className = "wifi-result";
    res.textContent = t("wifi.sending");
    const host = q("wifi-host").value.trim();
    let switched = false;
    try {
      if (plan.route === "web") {
        try { localStorage.setItem(KEY_HOST, host); } catch { /* egal */ }
        // erst prüfen, ob das Board dort überhaupt antwortet – sonst klare Meldung statt Netzwerkfehler
        if (!(await ping(host))) { res.textContent = ""; btn.disabled = false; return; }
        for (let i = 0; i < plan.lines.length; i++) {
          const shown = plan.secret.includes(i) ? t("wifi.logSecret") : plan.lines[i];
          try {
            await invoke<string>("esp_web_command", { host, command: plan.lines[i] });
          } catch (e) {
            // Board hat beim Umschalten sein eigenes WLAN abgeschaltet -> keine Antwort mehr: das ist gut so
            if (plan.switchLast && i === plan.lines.length - 1 && !String(e).startsWith("http-")) {
              log(t("wifi.logSent", { line: shown, via: "Web" }));
              switched = true;
              break;
            }
            throw new Error(t("wifi.err.webRejected", { line: shown, e: String(e) }));
          }
          log(t("wifi.logSent", { line: shown, via: "Web" }));
        }
      } else {
        for (let i = 0; i < plan.lines.length; i++) {
          const a = await sendAndWait(plan.lines[i], 6000, true);   // quiet: Passwort nicht in die Konsole
          log(t("wifi.logSent", { line: plan.secret.includes(i) ? t("wifi.logSecret") : plan.lines[i], via: "GRBL" }));
          if (!a.ok && plan.switchLast && i === plan.lines.length - 1 && !(a.code !== undefined && a.code > 0)) { switched = true; break; }
          if (!a.ok) throw new Error(t("wifi.err.rejected", { line: plan.secret.includes(i) ? t("wifi.logSecret") : plan.lines[i], e: String(a.code ?? "") }));
        }
      }
      res.className = "wifi-result ok";
      if (plan.switchLast) {
        // MKS: wechselt sofort, kein Neustart nötig
        const ssid = q("wifi-ssid").value;
        res.innerHTML = `✓ ${esc(t(mode() === "sta" ? (switched ? "wifi.switchedNoAnswer" : "wifi.switched") : "wifi.switchedAp", { ssid }))}`;
        if (mode() === "sta" && machine.connected && !tcpHost()) {
          // per USB nachsehen, ob das Board drin ist und welche IP es bekommen hat
          const out = document.createElement("div");
          out.className = "wifi-note";
          out.textContent = t("wifi.checkingJoin");
          res.appendChild(out);
          let found = "";
          for (let n = 0; n < 6 && !found && document.body.contains(ov); n++) {
            await new Promise(r => setTimeout(r, 2500));
            const st = parseWifiInfo(await ask("$I"));
            if (st && st.mode === "STA" && st.ip && !isApIp(st.ip)) found = st.ip;
          }
          out.className = found ? "wifi-note wifi-ok" : "wifi-note wifi-bad";
          out.textContent = found ? `✓ ${t("wifi.joinedAt", { ssid, ip: found })}` : `✗ ${t("wifi.joinFailed", { ssid })}`;
          if (found) { try { localStorage.setItem(KEY_HOST, found); } catch { /* egal */ } log(t("wifi.joinedAt", { ssid, ip: found })); }
        }
        return;
      }
      res.innerHTML = `✓ ${esc(t("wifi.done"))}${plan.restart ? ` <button id="wifi-restart" class="btn-secondary">↻ ${esc(t("wifi.restart"))}</button>` : ` ${esc(t("wifi.powerCycle"))}`}`;
      const rb = ov.querySelector("#wifi-restart") as HTMLButtonElement | null;
      if (rb) rb.onclick = async () => {
        if (!window.confirm(t("wifi.restartConfirm"))) return;
        try {
          if (plan.route === "web") await invoke<string>("esp_web_command", { host, command: plan.restart });
          else await sendAndWait(plan.restart, 3000, true);
        } catch { /* Board startet neu – Verbindung bricht ab */ }
        log(t("wifi.restarted"));
        close();
      };
    } catch (e) {
      res.className = "wifi-result bad";
      const m = e instanceof Error ? e.message : String(e);
      const k = "cam.ipErr." + m;
      res.textContent = `✗ ${t("wifi.failed", { e: t(k) !== k ? t(k) : m })}`;
      btn.disabled = false;
    }
  };
}
