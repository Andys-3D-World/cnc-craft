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
import { analyze, planWifi, WifiFw, WifiMode, WifiPlan, parseApList, signalBars, ApInfo } from "../wifiCodec";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const KEY_HOST = "cnc_craft_wifi_web_host";

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

/** Einstellung über die Leitung lesen (z. B. "$AP/SSID" -> "MKS_DLC"). "" wenn keine Antwort */
async function readSetting(key: string): Promise<string> {
  const lines: string[] = [];
  const grab = (e: Event) => {
    const d = (e as CustomEvent).detail;
    const txt = d?.type === "text" ? String(d.data?.text || "") : d?.type === "setting" ? `${d.data?.key}=${d.data?.value}` : "";
    if (txt) lines.push(txt);
  };
  window.addEventListener(MACHINE_EVENT, grab);
  try { await sendAndWait(key, 3000, true); await new Promise(r => setTimeout(r, 150)); }
  catch { /* egal */ }
  finally { window.removeEventListener(MACHINE_EVENT, grab); }
  const hit = lines.map(l => l.trim()).find(l => l.toLowerCase().startsWith(key.toLowerCase() + "="));
  return hit ? hit.slice(key.length + 1).trim() : "";
}

export function openWifiSetup(log: (s: string) => void) {
  document.getElementById("wifi-overlay")?.remove();
  const fw = wifiFirmware();
  const fwName = [machine.firmware, machine.version].filter(Boolean).join(" ") + (machine.info.name ? ` · ${machine.info.name}` : "");
  const ov = document.createElement("div");
  ov.id = "wifi-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box wifi-box" role="dialog">
      <h3>📶 ${esc(t("wifi.title"))}</h3>
      <div class="wifi-board">${esc(t("wifi.board", { fw: fwName || "?" }))}</div>
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

  // ---- Erst-Einrichtung über das eigene WLAN des Boards ----
  let apName = "";
  const guide = q("wifi-guide");
  const showGuide = async () => {
    if (tcpHost()) { guide.style.display = "none"; return; }   // per WLAN verbunden: IP ist bekannt
    guide.style.display = "";
    const name = apName || (fw === "grblhal" ? "" : "MKS_DLC / FluidNC / GRBL_ESP");
    guide.innerHTML = `
      <b>${esc(t("wifi.g.title"))}</b>
      <ol>
        <li>${esc(t("wifi.g.s1", { ap: name || "?" }))}</li>
        <li>${esc(t("wifi.g.s2", { ip: BOARD_AP_IP }))}</li>
        <li>${esc(t("wifi.g.s3"))}</li>
      </ol>
      <div class="wifi-g-btns">
        <button type="button" id="wifi-ap-on" class="btn-secondary" data-tip="${esc(t("wifi.g.apOnTip"))}">📡 ${esc(t("wifi.g.apOn"))}</button>
      </div>`;
    q<HTMLButtonElement>("wifi-ap-on").onclick = async () => {
      if (!window.confirm(t("wifi.g.apOnConfirm"))) return;
      const cmds = fw === "fluidnc" ? ["$WiFi/Mode=AP", "$Bye"] : fw === "grblhal" ? ["$73=2"] : ["[ESP110]AP", "[ESP444]RESTART"];
      for (const c of cmds) { try { await sendAndWait(c, 3000, true); log(t("wifi.logSent", { line: c, via: "GRBL" })); } catch { /* Neustart */ } }
      log(t(fw === "grblhal" ? "wifi.g.apOnHal" : "wifi.g.apOnDone"));
      q("wifi-ping-res").textContent = t(fw === "grblhal" ? "wifi.g.apOnHal" : "wifi.g.apOnDone");
    };
    // Namen des Board-WLANs vom Board holen (nur einmal)
    if (!apName && machine.connected && !tcpHost()) {
      apName = await readSetting(fw === "grblhal" ? "$76" : "$AP/SSID");
      if (apName) void showGuide();
    }
  };

  /** Ist die Weboberfläche erreichbar? ([ESP800] = Firmware-Info, ändert nichts) */
  const ping = async (host: string): Promise<boolean> => {
    const out = q("wifi-ping-res");
    out.className = "wifi-note";
    out.textContent = t("wifi.pinging", { ip: host });
    try {
      await invoke<string>("esp_web_command", { host, command: "[ESP800]" });
      out.className = "wifi-note wifi-ok";
      out.textContent = `✓ ${t("wifi.pingOk", { ip: host })}`;
      return true;
    } catch {
      out.className = "wifi-note wifi-bad";
      out.textContent = `✗ ${t("wifi.pingFail", { ip: host, ap: apName || "MKS_DLC" })}`;
      return false;
    }
  };
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
    plan = planWifi(fw, mode(), ssid, pw, true, machine.settings.get("$39") ?? null);
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
    q<HTMLButtonElement>("wifi-send").disabled = !!plan.error || !ssid || needHost || fw === "none";
  };
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
            throw new Error(t("wifi.err.webRejected", { line: shown, e: String(e) }));
          }
          log(t("wifi.logSent", { line: shown, via: "Web" }));
        }
      } else {
        for (let i = 0; i < plan.lines.length; i++) {
          const a = await sendAndWait(plan.lines[i], 6000, true);   // quiet: Passwort nicht in die Konsole
          log(t("wifi.logSent", { line: plan.secret.includes(i) ? t("wifi.logSecret") : plan.lines[i], via: "GRBL" }));
          if (!a.ok) throw new Error(t("wifi.err.rejected", { line: plan.secret.includes(i) ? t("wifi.logSecret") : plan.lines[i], e: String(a.code ?? "") }));
        }
      }
      res.className = "wifi-result ok";
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
