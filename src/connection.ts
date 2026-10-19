/**
 * VERBINDUNG & BEDIENUNG (Reiter "Maschine")
 *
 *  - Ports mit Chip-Erkennung auflisten (CH340, CP210x, ESP32-S3 USB …)
 *  - Netzwerk-Suche 📡 (wie der IP-Finder in OpenBuilds): findet FluidNC, grblHAL, MKS DLC32 … im WLAN
 *  - Verbinden / Trennen, Firmware-Anzeige (GRBL, grblHAL, FluidNC, Grbl_ESP32 …)
 *  - echte Position (Werkstück- und Maschinenkoordinaten) aus dem Statusbericht
 *  - Status-Anzeige (Bereit, Läuft, Angehalten, Alarm …) mit Alarm-Erklärung
 *  - Entsperren ($X), Referenzfahrt ($H), Reset, Nullpunkt setzen / anfahren
 *  - Overrides (Vorschub, Spindel/Laser, Eilgang) – wirken sofort, auch während des Jobs
 *    (Spindel an/aus, Laser-Testschuss, THC und Schieberegler: ui/spindlePanel.ts)
 *  - Manuelles Fahren ($J=…) und Konsole
 * Ohne Maschine läuft alles im Demo-Modus (Position wird nur angezeigt).
 */
import { state } from "./main";
import { liveMachinePos } from "./render";
import { handleJogClick } from "./jogSimulator";
import { t } from "./i18n/i18n";
import {
  machine, MACHINE_EVENT, RT, listPorts, connect, connectMarlin, connectRuida, connectK40, k40Count, disconnect, send, sendAndWait, realtime,
  alarmText, canCommand, PortInfo, fmtBuildDate, netScan, NetDevice,
  machineSlots, selectMachine, newMachineSlot, stopAllMachines, connectedCount
} from "./machine";
import { isRuidaMachine, isMarlinMachine, isK40Machine, currentMachine } from "./ui/machineWizard";
import { openWifiSetup, wifiFirmware } from "./ui/wifiSetup";
import { analyze, isDefaultHost } from "./wifiCodec";

/** Text sicher in HTML einsetzen (Gerätenamen, Antworten des Boards …) */
function escHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const KEY_LAST = "cnc_craft_last_port";
const KEY_RUIDA_IP = "cnc_craft_ruida_ip";
const KEY_LAST_RUIDA = "cnc_craft_last_port_ruida";
const KEY_NET_GRBL = "cnc_craft_net_addr"; // GRBL über Netzwerk: "host:port"
const KEY_NET_FOUND = "cnc_craft_net_found"; // zuletzt gefundene Netzwerk-Maschinen (für die nächste Suche)
const NET = "__net__"; // Eintrag „Netzwerk (IP)“ in der Port-Auswahl (Ruida und GRBL)

/** Hinweis, welches Board hinter einem Chip typischerweise steckt */
/** Fehler beim Verbinden verständlich machen (z. B. "already-connected") */
function whyText(e: unknown): string {
  const k = "m.why." + String(e);
  return t(k) !== k ? t(k) : String(e);
}

function chipHint(p: PortInfo): string {
  switch (p.chip) {
    case "CH340": case "CH341": return t("m.hint.ch340");
    case "CH9102": case "CH343": case "CP210x": return t("m.hint.esp32");
    case "ESP32-S3/C3 USB": case "ESP32 USB": return t("m.hint.esp32s3");
    case "Arduino": return t("m.hint.arduino");
    case "STM32 USB": return t("m.hint.stm32");
    case "FTDI": return t("m.hint.ftdi");
    default: return "";
  }
}

export function initConnection(appendToConsole: (text: string) => void) {
  const $ = (id: string) => document.getElementById(id);
  const portSelect = $("port-select") as HTMLSelectElement;
  const baudSelect = $("baud-select") as HTMLSelectElement;
  const connectBtn = $("connect-btn") as HTMLButtonElement;
  const cmdInput = $("cmd-input") as HTMLInputElement;
  const redraw = () => window.dispatchEvent(new CustomEvent("cnc-redraw"));
  let ports: PortInfo[] = [];

  // ---------------- Ports ----------------
  const ipInput = $("ruida-ip") as HTMLInputElement | null;
  const get = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
  // Netzwerk geht bei Ruida und GRBL (FluidNC, grblHAL, ESP32-Boards per WLAN, xTool F1) – nicht bei Marlin/K40
  const netCapable = () => isRuidaMachine() || (!isMarlinMachine() && !isK40Machine());
  let ipFor = "";
  const syncIpField = () => {
    if (!ipInput) return;
    const proto = isRuidaMachine() ? "ruida" : "grbl";
    if (ipFor !== proto) {
      ipFor = proto;
      ipInput.value = proto === "ruida" ? (get(KEY_RUIDA_IP) || "192.168.1.100") : (get(KEY_NET_GRBL) || "");
      ipInput.placeholder = proto === "ruida" ? "192.168.1.100" : "192.168.4.1";
      ipInput.title = t(proto === "ruida" ? "m.ruidaIpTip" : "m.netIpTip");
    }
    const show = netCapable() && portSelect.value === NET;
    ipInput.style.display = show ? "" : "none";
    // Netzwerk-Suche gibt es für GRBL über Netzwerk (Ruida spricht UDP mit eigenem Protokoll)
    const findBtn = $("net-find-btn");
    if (findBtn) findBtn.style.display = show && !isRuidaMachine() ? "" : "none";
    if (!(show && !isRuidaMachine())) hideFind();
    if (!isRuidaMachine() && !isK40Machine()) baudSelect.style.display = show ? "none" : "";
  };
  window.addEventListener("cnc-protocol-changed", () => { ipFor = ""; });

  // ---------------- Netzwerk-Suche (IP-Finder) ----------------
  const findList = $("net-find-list");
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  function hideFind() { if (findList) { findList.style.display = "none"; findList.innerHTML = ""; } }
  const pick = (addr: string) => {
    if (!ipInput) return;
    ipInput.value = addr;
    try { localStorage.setItem(KEY_NET_GRBL, addr); } catch { /* egal */ }
    hideFind();
    appendToConsole(t("net.picked", { addr }));
  };
  /** zuletzt gefundene Maschinen (Adresse, Firmware, Name) */
  const knownDevices = (): NetDevice[] => { try { return JSON.parse(get(KEY_NET_FOUND) || "[]"); } catch { return []; } };
  /** Adressen, die die Suche zuerst und gründlich prüft */
  const hints = (): string[] => {
    const h = [ipInput?.value || "", get(KEY_NET_GRBL), ...knownDevices().map(d => `${d.ip}:${d.port}`)];
    return [...new Set(h.map(s => s.trim()).filter(Boolean))];
  };
  const rememberFound = (devs: NetDevice[]) => {
    const grbl = devs.filter(d => d.kind === "grbl");
    if (!grbl.length) return;
    // neue Funde vorne, alte (die diesmal nicht da waren) behalten – höchstens 8
    const merged = [...grbl, ...knownDevices().filter(o => !grbl.some(n => n.ip === o.ip && n.port === o.port))].slice(0, 8);
    try { localStorage.setItem(KEY_NET_FOUND, JSON.stringify(merged)); } catch { /* egal */ }
  };
  let finding = false;
  const findDevices = async () => {
    if (!findList || finding || machine.connected) return;
    finding = true;
    const btn = $("net-find-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    findList.style.display = "";
    findList.innerHTML = `<div class="net-find-busy"><span class="net-spin"></span>${esc(t("net.searching"))}</div>`;
    try {
      const r = await netScan(hints());
      const net = r.own ? r.own.replace(/\.\d+$/, ".x") : "";
      const devs = r.devices || [];
      rememberFound(devs);
      // mehrere Maschinen, die man nicht auseinanderhalten kann (gleicher oder Standard-Name)?
      const dupHint = (list: NetDevice[]) => {
        const g = list.filter(d => d.kind === "grbl");
        const ips = [...new Set(g.map(d => d.ip))];
        if (ips.length < 2) return "";
        const names = ips.map(ip => g.find(d => d.ip === ip)?.host || "");
        const unclear = names.some(n => !n || isDefaultHost(n)) || new Set(names).size < names.length;
        return unclear ? `<div class="net-find-dup">${esc(t("net.dupHint"))}</div>` : "";
      };
      const label = (d: NetDevice) => {
        const parts = [d.firmware, d.name, d.host && isDefaultHost(d.host) ? d.host : ""].filter(Boolean);
        return parts.length ? parts.join(" · ") : t(d.kind === "grbl" ? "net.grblUnknown" : "net.openPort");
      };
      const portHint = (p: number) => p === 23 ? "Telnet" : p === 8080 ? "MKS" : p === 8780 ? "xTool" : "";
      findList.innerHTML = `
        <div class="net-find-head"><span>${esc(net ? t("net.foundIn", { net, n: devs.length }) : t("net.found", { n: devs.length }))}</span>
          <button class="net-find-x" data-tip="${esc(t("upd.close"))}">✕</button></div>
        ${devs.length ? devs.map(d => `
          <button class="net-find-item${d.kind === "grbl" ? " grbl" : ""}" data-addr="${esc(d.ip + ":" + d.port)}">
            <span class="net-find-dot"></span>
            <span class="net-find-txt">${d.host && !isDefaultHost(d.host)
              ? `<b><span class="net-host">${esc(d.host)}</span><span class="net-ipline">${esc(d.ip)}:${d.port}</span></b>`
              : `<b>${esc(d.ip)}<em>:${d.port}</em></b>`}<small>${esc(label(d))}${portHint(d.port) ? " · " + portHint(d.port) : ""}</small></span>
            <span class="net-find-use">${esc(t("net.use"))}</span>
          </button>`).join("") : `<div class="net-find-none">${esc(t("net.none"))}</div>`}
        ${dupHint(devs)}`;
      findList.querySelector(".net-find-x")?.addEventListener("click", hideFind);
      findList.querySelectorAll<HTMLButtonElement>(".net-find-item").forEach(b => b.addEventListener("click", () => pick(b.dataset.addr!)));
      const grbl = devs.filter(d => d.kind === "grbl");
      appendToConsole(t("net.log", { n: devs.length, g: grbl.length }));
      // genau eine Maschine gefunden: gleich eintragen (Liste bleibt zum Nachsehen offen)
      if (grbl.length === 1 && ipInput) {
        ipInput.value = grbl[0].ip + ":" + grbl[0].port;
        try { localStorage.setItem(KEY_NET_GRBL, ipInput.value); } catch { /* egal */ }
      }
    } catch (e) {
      findList.innerHTML = `<div class="net-find-none">${esc(t("net.error", { e: String(e) }))}</div>`;
    } finally {
      finding = false;
      if (btn) btn.disabled = false;
    }
  };
  $("net-find-btn")?.addEventListener("click", findDevices);
  const scan = async () => {
    if (isK40Machine()) {
      // K40-Original-Board ist kein serieller Port, sondern ein USB-Gerät (CH341, 1a86:5512)
      const n = await k40Count();
      ports = [];
      portSelect.innerHTML = n
        ? Array.from({ length: n }, (_, i) => `<option value="k40:${i}">🔌 ${t("m.k40Usb")}${n > 1 ? " " + (i + 1) : ""}</option>`).join("")
        : `<option value="k40:0">🔌 ${t("m.k40Usb")} – ${t("m.k40NotFound")}</option>`;
      syncIpField();
      showInfo();
      return;
    }
    ports = await listPorts();
    const ruida = isRuidaMachine();
    const net = netCapable();
    const last = get(ruida ? KEY_LAST_RUIDA : KEY_LAST);
    const cur = portSelect.value === NET ? "" : portSelect.value;
    const keep = ruida ? (last || NET) : (last === NET && net ? NET : (cur || last));
    const list = ports.map(p => {
      const extra = [p.chip, p.product].filter(Boolean).join(" · ");
      const hint = chipHint(p);
      // Namen kommen vom USB-Gerät selbst – nie ungeprüft als HTML einsetzen
      return `<option value="${escHtml(p.name)}" title="${escHtml(hint)}">${escHtml(p.name)}${extra ? " – " + escHtml(extra) : ""}${hint ? " (" + escHtml(hint) + ")" : ""}</option>`;
    }).join("");
    portSelect.innerHTML = (net ? `<option value="${NET}">🌐 ${t("m.ruidaNet")}</option>` : "")
      + (list || (ruida ? "" : `<option value="">${t("m.noPorts")}</option>`));
    if (keep && (ports.some(p => p.name === keep) || (net && keep === NET))) portSelect.value = keep;
    else if (!ruida && net && list) portSelect.value = ports[0].name;
    else if (ruida) portSelect.value = NET;
    syncIpField();
    showInfo();
  };
  window.addEventListener("cnc-protocol-changed", () => { if (!machine.connected) scan(); });
  $("scan-btn")?.addEventListener("click", scan);
  portSelect?.addEventListener("focus", () => { if (!machine.connected) scan(); });
  scan();

  // ---------------- Verbinden ----------------
  const showInfo = () => {
    const info = $("machine-info");
    if (!info) return;
    if (machine.connected) {
      const bi = machine.info;
      const board = bi.version
        ? t("m.boardLine", { name: bi.name || machine.firmware, v: bi.version, d: bi.date ? fmtBuildDate(bi.date) : "–" })
        : "";
      const host = bi.host ? "\n" + t("m.hostLine", { h: bi.host }) : "";
      info.textContent = machine.firmware
        ? t("m.infoConnected", { fw: machine.firmware, v: machine.version, port: machine.port }) + (board ? "\n" + board : "") + host
        : t("m.infoWaiting", { port: machine.port });
    } else if (isK40Machine()) {
      info.textContent = t("m.k40Hint");
    } else if (isRuidaMachine()) {
      info.textContent = portSelect.value === NET ? t("m.ruidaNetHint") : t("m.ruidaUsbHint");
    } else if (portSelect.value === NET) {
      info.textContent = t("m.netHint");
    } else {
      const p = ports.find(x => x.name === portSelect.value);
      info.textContent = p && chipHint(p) ? t("m.infoChip", { chip: p.chip, hint: chipHint(p) }) : "";
    }
  };
  portSelect?.addEventListener("change", () => { syncIpField(); showInfo(); });

  const setConnectedUi = (on: boolean) => {
    state.isDeviceConnected = on;
    connectBtn.innerHTML = on ? `⏏ ${t("m.disconnect")}` : `🔌 ${t("rp.connect")}`;
    connectBtn.classList.toggle("btn-danger-outline", on);
    portSelect.disabled = on;
    baudSelect.disabled = on;
    if (ipInput) ipInput.disabled = on;
    const fb = $("net-find-btn") as HTMLButtonElement | null;
    if (fb) fb.disabled = on;
    if (on) hideFind();
    syncWifiBtn();
    const dot = $("header-conn-dot"), txt = $("header-conn-text");
    if (dot) dot.classList.toggle("online", on);
    const others = connectedCount() - (on ? 1 : 0);
    if (dot && others > 0) dot.classList.add("online");
    if (txt) txt.textContent = (on ? (machine.firmware ? `${machine.firmware} ${machine.version}`.trim() : t("nav.online")) : others > 0 ? t("ms.notConnected") : t("nav.offline"))
      + (others > 0 ? ` (+${others})` : "");
    if (!on) setStateBadge("Offline");
    showInfo();
    updateButtons();
  };

  connectBtn?.addEventListener("click", async () => {
    if (machine.connected) {
      if (machine.job.active && !window.confirm(t("m.confirmDisconnect"))) return;
      await disconnect();
      appendToConsole(t("m.disconnected"));
      setConnectedUi(machine.connected); // war noch eine andere Maschine verbunden, ist jetzt sie ausgewählt
      return;
    }
    if (isK40Machine()) {
      const index = parseInt((portSelect.value || "k40:0").split(":")[1] || "0", 10) || 0;
      appendToConsole(t("m.connectingK40"));
      connectBtn.disabled = true;
      try {
        await connectK40(index);
        setConnectedUi(true);
      } catch (e) {
        const k = "m.why." + String(e);
        appendToConsole(t("m.connectFailed", { port: "K40 USB", e: t(k) !== k ? t(k) : String(e) }));
        setConnectedUi(false);
      } finally {
        connectBtn.disabled = false;
      }
      return;
    }
    if (isRuidaMachine()) {
      const target = portSelect.value === NET ? (ipInput?.value || "").trim() : portSelect.value;
      if (!target) { appendToConsole(portSelect.value === NET ? t("m.ruidaNoIp") : t("m.choosePort")); return; }
      appendToConsole(t("m.connectingRuida", { target }));
      connectBtn.disabled = true;
      try {
        await connectRuida(target);
        try {
          localStorage.setItem(KEY_LAST_RUIDA, portSelect.value);
          if (portSelect.value === NET) localStorage.setItem(KEY_RUIDA_IP, target);
        } catch { /* egal */ }
        setConnectedUi(true);
      } catch (e) {
        appendToConsole(t("m.connectFailed", { port: target, e: whyText(e) }));
        appendToConsole(t("m.ruidaConnectHelp"));
        setConnectedUi(false);
      } finally {
        connectBtn.disabled = false;
      }
      return;
    }
    let port = portSelect.value;
    if (port === NET) {
      // GRBL über Netzwerk
      const addr = (ipInput?.value || "").trim().replace(/^tcp:\/\//, "");
      if (!addr) { appendToConsole(t("m.ruidaNoIp")); return; }
      try { localStorage.setItem(KEY_NET_GRBL, addr); localStorage.setItem(KEY_LAST, NET); } catch { /* egal */ }
      port = "tcp://" + addr;
    }
    if (!port) { appendToConsole(t("m.choosePort")); await scan(); return; }
    if (await doConnect(port)) return;
    // Netzwerk-Maschine nicht erreichbar: oft hat der Router ihr eine neue Adresse gegeben -> suchen
    if (port.startsWith("tcp://") && ipInput) {
      connectBtn.disabled = true;
      const oldAddr = port.slice(6);
      appendToConsole(t("net.autoSearch"));
      try {
        const r = await netScan(hints());
        rememberFound(r.devices || []);
        const grbl = (r.devices || []).filter(d => d.kind === "grbl" && `${d.ip}:${d.port}` !== oldAddr);
        // dieselbe Maschine wie beim letzten Mal bevorzugen (gleiche Firmware/gleicher Name)
        const before = knownDevices().find(d => `${d.ip}:${d.port}` === oldAddr || d.ip === oldAddr);
        // Hat die Maschine einen eigenen Namen, zählt NUR der – sonst landet man bei mehreren gleichen Boards an der falschen
        const named = before?.host && !isDefaultHost(before.host) ? before.host : "";
        const same = named ? grbl.filter(d => d.host === named)
          : before ? grbl.filter(d => (d.firmware && d.firmware === before.firmware) || (d.name && d.name === before.name)) : [];
        const pickDev = same.length === 1 ? same[0] : !named && grbl.length === 1 ? grbl[0] : null;
        if (pickDev) {
          const addr = `${pickDev.ip}:${pickDev.port}`;
          ipInput.value = addr;
          try { localStorage.setItem(KEY_NET_GRBL, addr); } catch { /* egal */ }
          appendToConsole(t("net.autoFound", { addr }));
          connectBtn.disabled = false;
          await doConnect("tcp://" + addr);
        } else {
          appendToConsole(t(grbl.length ? "net.autoMany" : "net.autoNone"));
          connectBtn.disabled = false;
          if (grbl.length) void findDevices();
        }
      } catch {
        connectBtn.disabled = false;
      }
    }
  });

  /** Verbinden; true = hat geklappt */
  async function doConnect(port: string): Promise<boolean> {
    appendToConsole(t("m.connecting", { port, baud: baudSelect.value }));
    try {
      const baud = parseInt(baudSelect.value, 10) || 115200;
      if (isMarlinMachine()) await connectMarlin(port, baud, currentMachine()?.kind === "laser");
      else {
        await connect(port, baud);
        // Meldet sich keine GRBL-Firmware, läuft evtl. etwas anderes (z. B. Estlcam auf einem Arduino)
        setTimeout(() => {
          if (machine.connected && machine.protocol === "grbl" && !machine.firmware) appendToConsole(t("m.noGrblAnswer"));
        }, 4500);
      }
      if (!port.startsWith("tcp://")) { try { localStorage.setItem(KEY_LAST, port); } catch { /* egal */ } }
      setConnectedUi(true);
      return true;
    } catch (e) {
      appendToConsole(String(e) === "already-connected" ? `[${t("ms.title")}] ${whyText(e)}.` : t("m.connectFailed", { port, e: whyText(e) }));
      setConnectedUi(false);
      return false;
    }
  }

  // ---------------- Status-Anzeige ----------------
  const stateClass = (s: string) => {
    if (s === "Idle") return "m-state-idle";
    if (s === "Run" || s === "Jog" || s === "Home") return "m-state-run";
    if (s === "Hold" || s === "Door" || s === "Check" || s === "Sleep") return "m-state-hold";
    if (s === "Alarm") return "m-state-alarm";
    return "m-state-off";
  };
  const setStateBadge = (s: string) => {
    const el = $("machine-state");
    if (!el) return;
    const key = `m.state.${s}`;
    const label = t(key) === key ? s : t(key);
    el.textContent = machine.job.toolChange && s === "Idle" ? t("m.state.ToolChange") : label;
    el.className = "m-state " + (machine.job.toolChange && s === "Idle" ? "m-state-hold" : stateClass(s));
  };

  const fmt = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
  const updateButtons = () => {
    const can = canCommand();
    const alarm = machine.status.state === "Alarm";
    document.querySelectorAll<HTMLButtonElement>("#m-home, #m-zero-xy, #m-zero-z, #m-goto-zero").forEach(b => { b.disabled = !can || (alarm && b.id !== "m-home"); });
    const unlock = $("m-unlock") as HTMLButtonElement | null;
    if (unlock) { unlock.disabled = !machine.connected; unlock.classList.toggle("m-attention", alarm); }
    const reset = $("m-reset") as HTMLButtonElement | null;
    if (reset) reset.disabled = !machine.connected;
  };

  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type, data } = (e as CustomEvent).detail || {};
    if (type === "status") {
      const s = machine.status;
      liveMachinePos.x = s.wpos[0]; liveMachinePos.y = s.wpos[1]; liveMachinePos.z = s.wpos[2];
      const px = $("pos-x"), py = $("pos-y"), pz = $("pos-z");
      if (px) px.textContent = fmt(s.wpos[0]);
      if (py) py.textContent = fmt(s.wpos[1]);
      if (pz) pz.textContent = fmt(s.wpos[2]);
      const mp = $("machine-mpos");
      // ausgelöste Eingänge zeigt ui/pinLeds.ts als Lämpchen
      if (mp) mp.textContent = t("m.mpos", { x: fmt(s.mpos[0]), y: fmt(s.mpos[1]), z: fmt(s.mpos[2]) });
      const fs = $("machine-fs");
      if (fs) fs.textContent = s.state === "Run" || s.state === "Jog" ? `F${Math.round(s.feed)} S${Math.round(s.spindle)}` : "";
      // Vorschub-/Spindel-Override zeigt ui/spindlePanel.ts (mit Schiebereglern)
      document.querySelectorAll<HTMLElement>("[data-rt^=rapid]").forEach(b => b.classList.toggle("active", b.textContent === `${s.ov[1]}%`));
      setStateBadge(s.state);
      const al = $("machine-alarm");
      if (al) {
        const show = s.state === "Alarm";
        al.style.display = show ? "" : "none";
        if (show) al.innerHTML = `⚠ ${machine.lastAlarm ? alarmText(machine.lastAlarm) : t("m.alarmGeneric")}<br><b>${t("m.alarmHelp")}</b>`;
      }
      updateButtons();
      redraw();
    } else if (type === "info") {
      showInfo();
    } else if (type === "welcome" || type === "connected") {
      setConnectedUi(true);
    } else if (type === "disconnected") {
      setConnectedUi(false);
    } else if (type === "alarm") {
      const al = $("machine-alarm");
      if (al) { al.style.display = ""; al.innerHTML = `⚠ ${alarmText(data.code)}<br><b>${t("m.alarmHelp")}</b>`; }
    } else if (type === "job-progress" || type === "job-done" || type === "job-toolchange") {
      updateButtons();
      setStateBadge(machine.status.state || "Offline");
    }
  });

  // ---------------- Mehrere Maschinen ----------------
  // Liste aller Verbindungen: anklicken = auswählen (Befehle und Jobs gehen an die ausgewählte),
  // „+“ = weiteren Platz zum Verbinden, „Alle stoppen“ = laufende Jobs überall anhalten
  const MODE_ICON: Record<string, string> = { mill: "🛠️", laser: "🔦", plasma: "🔥" };
  const shortPort = (p: string) => p.replace(/^tcp:\/\//, "").replace(/^\/dev\/(cu\.|tty\.?)?/, "");
  const slotsBox = $("m-slots");
  function renderSlots() {
    if (!slotsBox) return;
    const n = connectedCount();
    if (n === 0) { slotsBox.style.display = "none"; slotsBox.innerHTML = ""; return; }
    slotsBox.style.display = "";
    const rows = machineSlots().map((s, i) => {
      const st = s.connected ? (s.state || "Idle") : "Offline";
      const pct = s.job.total ? Math.round((s.job.acked / s.job.total) * 100) : 0;
      const sub = s.connected ? [s.info.host || s.info.name || s.firmware, shortPort(s.port)].filter(Boolean).join(" · ") : t("ms.notConnected");
      return `<button type="button" class="m-slot${s.active ? " active" : ""}" data-id="${escHtml(s.id)}" data-tip="${escHtml(t("ms.selectTip"))}">
          <span class="m-slot-dot ${stateClass(st)}"></span>
          <span class="m-slot-text"><b>${MODE_ICON[s.mode] || ""} ${escHtml(t("ms.machineN", { n: i + 1 }))} · ${escHtml(t("mode." + s.mode))}</b>
            <small>${escHtml(sub)}</small></span>
          ${s.job.active ? `<span class="m-slot-job">${pct} %${s.job.paused ? " ⏸" : ""}</span>` : ""}
        </button>`;
    }).join("");
    slotsBox.innerHTML = `<div class="m-slots-title">${escHtml(t("ms.title"))}</div>${rows}
      <div class="m-slots-btns">
        ${machine.connected ? `<button type="button" id="m-slot-add" class="btn-secondary btn-compact">➕ ${escHtml(t("ms.add"))}</button>` : ""}
        ${n >= 2 ? `<button type="button" id="m-stop-all" class="btn-secondary btn-compact btn-danger-outline" data-tip="${escHtml(t("ms.stopAllTip"))}">⛔ ${escHtml(t("ms.stopAll"))}</button>` : ""}
      </div>`;
    slotsBox.querySelectorAll<HTMLButtonElement>(".m-slot").forEach(b => b.addEventListener("click", () => { void selectMachine(b.dataset.id!); }));
    slotsBox.querySelector("#m-slot-add")?.addEventListener("click", async () => {
      await newMachineSlot();
      appendToConsole(t("ms.addHint"));
      void scan();
    });
    slotsBox.querySelector("#m-stop-all")?.addEventListener("click", async () => {
      const k = await stopAllMachines();
      appendToConsole(t("ms.stopped", { n: k }));
    });
  }
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const type = (e as CustomEvent).detail?.type;
    if (type === "slots" || type === "switched") renderSlots();
    if (type === "switched") {
      setConnectedUi(machine.connected);
      if (machine.connected) setStateBadge(machine.status.state || "Idle");
    }
  });

  // ---------------- Steuerknöpfe ----------------
  const guard = (fn: () => Promise<any>) => async () => {
    if (!machine.connected) { appendToConsole(t("conn.connectFirst")); return; }
    try { await fn(); } catch (e) { appendToConsole(`${t("log.error")} ${t("m.why." + String(e)) !== "m.why." + String(e) ? t("m.why." + String(e)) : String(e)}`); }
  };
  $("m-unlock")?.addEventListener("click", guard(async () => { await send("$X"); machine.lastAlarm = 0; }));
  $("m-home")?.addEventListener("click", guard(() => send("$H")));
  $("m-reset")?.addEventListener("click", guard(async () => { appendToConsole("> Ctrl-X (Reset)"); await realtime(RT.reset); }));
  $("m-zero-xy")?.addEventListener("click", guard(() => send("G10 L20 P1 X0 Y0")));
  $("m-zero-z")?.addEventListener("click", guard(() => send("G10 L20 P1 Z0")));
  $("m-goto-zero")?.addEventListener("click", guard(async () => {
    // erst Z hoch (falls Z unter 5 mm steht), dann XY auf 0
    if (machine.status.wpos[2] < 5) await send("G21 G90 G0 Z5");
    await send("G21 G90 G0 X0 Y0");
  }));
  document.querySelectorAll<HTMLElement>("[data-rt]").forEach(b => {
    b.addEventListener("click", guard(() => realtime((RT as any)[b.dataset.rt!])));
  });

  // ---------------- Bettgröße aus $130/$131 ----------------
  $("btn-sync-bed")?.addEventListener("click", guard(async () => {
    if (machine.protocol === "ruida") {
      const b = machine.ruidaBed;
      const w = $("bed-w") as HTMLInputElement, h = $("bed-h") as HTMLInputElement;
      if (!b) { appendToConsole(t("conn.ruidaNoBed")); return; }
      w.value = b.w.toFixed(0); h.value = b.h.toFixed(0);
      appendToConsole(t("conn.syncedX", { v: w.value })); appendToConsole(t("conn.syncedY", { v: h.value }));
      w.dispatchEvent(new Event("input")); h.dispatchEvent(new Event("input"));
      redraw();
      return;
    }
    appendToConsole(t("conn.readingLimits"));
    if (!machine.settings.has("$130")) await sendAndWait("$$", 5000, true);
    const x = parseFloat(machine.settings.get("$130") || ""), y = parseFloat(machine.settings.get("$131") || "");
    const w = $("bed-w") as HTMLInputElement, h = $("bed-h") as HTMLInputElement;
    if (x > 0 && w) { w.value = x.toFixed(0); appendToConsole(t("conn.syncedX", { v: w.value })); w.dispatchEvent(new Event("input")); }
    if (y > 0 && h) { h.value = y.toFixed(0); appendToConsole(t("conn.syncedY", { v: h.value })); h.dispatchEvent(new Event("input")); }
    redraw();
  }));

  // ---------------- WLAN einrichten ----------------
  // Knopf nur bei Boards mit WLAN (FluidNC, grblHAL, Grbl_ESP32, MKS DLC32 …)
  function syncWifiBtn() {
    const b = $("wifi-setup-btn");
    if (b) b.style.display = machine.connected && wifiFirmware() !== "none" ? "" : "none";
  }
  window.addEventListener(MACHINE_EVENT, syncWifiBtn);
  $("wifi-setup-btn")?.addEventListener("click", () => openWifiSetup(appendToConsole));

  // ---------------- Konsole ----------------
  const sendCommand = async () => {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    // Einstellung mit Zeichen, die GRBL unterwegs abfängt (z. B. WLAN-Passwort mit ! ? ~ oder Umlauten)
    if ((cmd.startsWith("$") || cmd.startsWith("[ESP")) && cmd.includes("=") || cmd.startsWith("[ESP")) {
      const r = analyze(cmd.replace(/^[^=\]]*[=\]]/, ""));
      if (r.realtime.length || r.nonAscii.length) {
        appendToConsole(t("wifi.consoleWarn", { c: [...r.realtime, ...r.nonAscii].join(" ") }));
        if (wifiFirmware() !== "none") openWifiSetup(appendToConsole);
        return;
      }
    }
    cmdInput.value = "";
    if (!machine.connected) { appendToConsole(`> ${cmd}`); appendToConsole(t("m.demoCmd")); return; }
    // Echtzeit-Kürzel in der Konsole
    if (cmd === "?" || cmd === "!" || cmd === "~") { appendToConsole(`> ${cmd}`); await realtime(cmd.charCodeAt(0)); return; }
    try { await send(cmd); } catch (e) { appendToConsole(`${t("log.error")} ${t("m.why." + String(e)) !== "m.why." + String(e) ? t("m.why." + String(e)) : String(e)}`); }
  };
  $("send-cmd-btn")?.addEventListener("click", sendCommand);
  cmdInput?.addEventListener("keypress", (e: KeyboardEvent) => { if (e.key === "Enter") sendCommand(); });

  // ---------------- Manuelles Fahren ----------------
  let activeStep = 1;
  const customStep = $("jog-step-custom") as HTMLInputElement;
  const stepButtons = document.querySelectorAll<HTMLElement>(".btn-step");
  const feedSlider = $("jog-feed-slider") as HTMLInputElement;
  const feedDisplay = $("jog-feed-display");
  feedSlider?.addEventListener("input", () => { if (feedDisplay) feedDisplay.textContent = `${feedSlider.value} mm/min`; });
  stepButtons.forEach(btn => btn.addEventListener("click", () => {
    stepButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeStep = parseFloat(btn.dataset.step || "1");
    if (customStep) customStep.value = "";
  }));
  customStep?.addEventListener("input", () => {
    const v = parseFloat(customStep.value);
    if (v > 0) { stepButtons.forEach(b => b.classList.remove("active")); activeStep = v; }
  });
  const distance = () => {
    const v = parseFloat(customStep?.value || "");
    return v > 0 ? v : activeStep;
  };
  const feed = () => (feedSlider ? parseInt(feedSlider.value, 10) : 1000);

  document.querySelectorAll<HTMLElement>(".btn-jog[data-cmd]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!machine.connected) {
        // Demo: Position nur anzeigen
        handleJogClick(btn, distance, feed, true, appendToConsole, redraw);
        return;
      }
      if (!canCommand()) { appendToConsole(t("m.why.job running")); return; }
      const st = machine.status.state;
      if (st === "Alarm") { appendToConsole(t("m.unlockFirst")); return; }
      if (st !== "Idle" && st !== "Jog") { appendToConsole(t("m.jogNotIdle", { s: st })); return; }
      const d = distance();
      const axes = (btn.dataset.cmd || "").split(" ").map(p => `${p[0]}${(parseInt(p.slice(1), 10) * d).toFixed(3)}`);
      try { await send(`$J=G21 G91 ${axes.join(" ")} F${feed()}`); } catch (e) { appendToConsole(`${t("log.error")} ${e}`); }
    });
  });
  // Mitte: Joggen sofort abbrechen
  $("jog-home")?.addEventListener("click", async () => {
    if (machine.connected) { await realtime(RT.jogCancel).catch(() => {}); appendToConsole(t("m.jogCancelled")); }
  });

  // Tooltips der neuen Knöpfe beim Sprachwechsel mitziehen
  window.addEventListener("cnc-language-changed", () => { setConnectedUi(machine.connected); scan(); });
  setConnectedUi(false);
}
