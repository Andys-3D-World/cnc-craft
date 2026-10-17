/**
 * WLAN-ZUGANGSDATEN SICHER ANS BOARD SCHICKEN (ohne DOM – lässt sich einzeln prüfen)
 *
 * Das Problem: GRBL liest jedes Zeichen einzeln und fängt einige SOFORT ab, egal wo sie stehen:
 *   !  = Vorschub anhalten     ?  = Statusabfrage     ~  = weiter
 *   Bytes ab 0x80 (Umlaute, ß, € … in UTF-8) = Echtzeit-Befehle (Overrides …)
 * Steht so ein Zeichen im Passwort, kommt es nie an – das Passwort ist dann falsch.
 * ( ) ; können je nach Firmware als Kommentar gelten, Leerzeichen werden teils entfernt.
 *
 * Lösung je Firmware:
 *   FluidNC       – Werte dürfen %HH-kodiert sein (FluidNC dekodiert sie, „uriDecode“):
 *                   problematische Zeichen werden als %21, %3F, %C3%A4 … geschickt
 *   grblHAL       – ! ? ~ gehen, wenn $39=0 (druckbare Echtzeit-Zeichen aus) – kurz umstellen,
 *                   danach den alten Wert zurück. Umlaute: nur über die Weboberfläche
 *   Grbl_ESP32 / MKS DLC32 – kein Ausweg über die Leitung: dann über die Weboberfläche des Boards
 *                   (http://IP/command?plain=…), dort läuft nichts durch den Zeichenfilter
 *   MKS DLC32 MAX (und neuere MKS-Firmware) – kennt [ESP100]/[ESP101] NICHT („Invalid $ statement“),
 *                   dafür eigene Nummern: $50 WLAN-Art (1 = eigenes WLAN, 2 = Heimnetz), $51/$52 eigenes WLAN,
 *                   $53/$54 Heimnetz. Über die Weboberfläche mit [ESP401]P=53 T=S V=… (ohne Zeichenfilter)
 */

export type WifiFw = "fluidnc" | "grblhal" | "esp32" | "none";
export type WifiMode = "sta" | "ap";

export interface CharReport {
  realtime: string[];   // ! ? ~
  nonAscii: string[];   // Umlaute, Sonderzeichen außerhalb ASCII
  comment: string[];    // ( ) ;
  space: boolean;
  percent: boolean;
  control: boolean;     // Steuerzeichen (Tab, Zeilenumbruch …) – gehen nirgends
}

export function analyze(s: string): CharReport {
  const r: CharReport = { realtime: [], nonAscii: [], comment: [], space: false, percent: false, control: false };
  const add = (list: string[], c: string) => { if (!list.includes(c)) list.push(c); };
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (c === "!" || c === "?" || c === "~") add(r.realtime, c);
    else if (code > 126) add(r.nonAscii, c);
    else if (code < 32 || code === 127) r.control = true;
    else if (c === "(" || c === ")" || c === ";") add(r.comment, c);
    else if (c === " ") r.space = true;
    else if (c === "%") r.percent = true;
  }
  return r;
}

/** Für FluidNC: Zeichen, die unterwegs verloren gehen könnten, als %HH (UTF-8-Bytes einzeln) */
export function fluidEncode(s: string): string {
  let o = "";
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (code > 126 || "!?~%();= \t".includes(c) || code < 32) {
      for (const b of new TextEncoder().encode(c)) o += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    } else o += c;
  }
  return o;
}

/** Umkehrung (zum Prüfen) */
export function fluidDecode(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else for (const b of new TextEncoder().encode(s[i])) bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Länge in Bytes (WLAN zählt Bytes, nicht Buchstaben) */
export function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface WifiPlan {
  route: "serial" | "web" | "none";
  lines: string[];        // Befehle in Reihenfolge (über die Leitung oder die Weboberfläche)
  secret: number[];       // Indizes in lines, die das Passwort enthalten (nicht ins Protokoll schreiben)
  restart: string;        // Befehl für den Neustart ("" = von Hand aus-/einschalten)
  notes: string[];        // i18n-Schlüssel mit Hinweisen
  error: string;          // i18n-Schlüssel, warum es nicht geht ("" = geht)
  switchLast?: boolean;   // letzte Zeile schaltet das WLAN sofort um – keine Antwort darauf ist normal
}

/**
 * Was wird wie geschickt?
 * canWeb = Weboberfläche des Boards erreichbar (Adresse bekannt)
 * hal39  = aktueller Wert von $39 bei grblHAL (null = unbekannt)
 */
/**
 * Name der Maschine im Netzwerk (Hostname) – damit man mehrere gleiche Boards auseinanderhält.
 * Erlaubt sind nur a–z, 0–9 und „-“ (so verlangt es WLAN/mDNS): „Laser Garage“ -> „laser-garage“
 */
export function hostSlug(name: string): string {
  return name.trim().toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 32).replace(/-$/, "");
}

/** Befehl für den Namen je Firmware */
export function hostLine(fw: WifiFw, host: string): string {
  if (!host) return "";
  if (fw === "fluidnc") return `$Hostname=${host}`;
  if (fw === "grblhal") return `$300=${host}`;
  if (fw === "esp32") return `[ESP112]${host}`;
  return "";
}

/** Standard-Namen ab Werk – mehrere Boards heißen dann gleich */
export function isDefaultHost(h: string): boolean {
  return /^(mks[_-]?(grbl|dlc32?)?|grblesp|grbl|fluidnc|grblhal|esp3d|espressif|esp32[-_a-z0-9]*)$/i.test(h.trim());
}

export function planWifi(fw: WifiFw, mode: WifiMode, ssid: string, pw: string, canWeb: boolean, hal39: string | null = null, mks = false, host = ""): WifiPlan {
  const plan = planWifiCore(fw, mode, ssid, pw, canWeb, hal39, mks);
  const hl = hostLine(fw, host);
  if (hl && !plan.error && plan.lines.length) {
    // gleich hinter das Passwort, vor das Umschalten
    const at = Math.max(...plan.secret, 1) + 1;
    plan.lines.splice(at, 0, hl);
  }
  return plan;
}

function planWifiCore(fw: WifiFw, mode: WifiMode, ssid: string, pw: string, canWeb: boolean, hal39: string | null = null, mks = false): WifiPlan {
  const plan: WifiPlan = { route: "serial", lines: [], secret: [], restart: "", notes: [], error: "" };
  const both = ssid + pw;
  const r = analyze(both);
  // Grundregeln von WLAN selbst
  if (fw === "none") { plan.route = "none"; plan.error = "wifi.err.noWifi"; return plan; }
  if (!ssid.trim() || byteLen(ssid) > 32) { plan.route = "none"; plan.error = "wifi.err.ssid"; return plan; }
  if (pw && (byteLen(pw) < 8 || byteLen(pw) > 63)) { plan.route = "none"; plan.error = "wifi.err.pwLen"; return plan; }
  if (r.control) { plan.route = "none"; plan.error = "wifi.err.control"; return plan; }

  if (fw === "fluidnc") {
    const pre = mode === "sta" ? "$Sta" : "$AP";
    plan.lines = [`${pre}/SSID=${fluidEncode(ssid)}`, `${pre}/Password=${fluidEncode(pw)}`, `$WiFi/Mode=${mode === "sta" ? "STA>AP" : "AP"}`];
    plan.secret = [1];
    plan.restart = "$Bye";
    if (r.realtime.length || r.nonAscii.length || r.comment.length || r.space || r.percent) plan.notes.push("wifi.note.fluidEnc");
    if (mode === "sta") plan.notes.push("wifi.note.fluidFallback");
    return plan;
  }

  if (fw === "grblhal") {
    // grblHAL: $73 WLAN-Art (1 = Heimnetz, 2 = eigenes WLAN), $74/$75 Heimnetz, $76/$77 eigenes WLAN
    const [sId, pId, m] = mode === "sta" ? [74, 75, 1] : [76, 77, 2];
    if (r.nonAscii.length) {
      if (!canWeb) { plan.route = "none"; plan.error = "wifi.err.halUmlaut"; return plan; }
      plan.route = "web";
      plan.notes.push("wifi.note.web");
    }
    plan.lines = [`$${sId}=${ssid}`, `$${pId}=${pw}`, `$73=${m}`];
    plan.secret = [1];
    if (r.realtime.length && plan.route === "serial") {
      // druckbare Echtzeit-Zeichen kurz ausschalten, danach alten Wert zurück
      plan.lines = ["$39=0", ...plan.lines, `$39=${hal39 ?? "1"}`];
      plan.secret = [2];
      plan.notes.push("wifi.note.hal39");
    }
    if (r.comment.length || r.space) plan.notes.push("wifi.note.halComment");
    return plan;
  }

  if (mks) return planMks(plan, mode, ssid, pw, canWeb, r);

  // Grbl_ESP32 / MKS DLC32: ESP3D-Befehle ([ESP100] Heimnetz-Name, [ESP101] Passwort, [ESP110] Funk-Art)
  plan.lines = mode === "sta"
    ? [`[ESP100]${ssid}`, `[ESP101]${pw}`, "[ESP110]STA"]
    : [`[ESP105]${ssid}`, `[ESP106]${pw}`, "[ESP110]AP"];
  plan.secret = [1];
  plan.restart = "[ESP444]RESTART";
  const risky = r.realtime.length || r.nonAscii.length;
  // „]“ trennt bei [ESP…]-Befehlen Befehl und Wert – im Wert geht es nicht
  if (both.includes("]")) { plan.route = "none"; plan.error = "wifi.err.bracket"; return plan; }
  if (risky) {
    if (!canWeb) { plan.route = "none"; plan.error = "wifi.err.espNeedWeb"; return plan; }
    plan.route = "web";
    plan.notes.push("wifi.note.web");
  } else if ((r.comment.length || r.space) && canWeb) {
    // ( ) ; und Leerzeichen sind über die Leitung unsicher – über die Weboberfläche sicher
    plan.route = "web";
    plan.notes.push("wifi.note.webSafer");
  } else if (r.comment.length || r.space) {
    plan.notes.push("wifi.note.espComment");
  }
  return plan;
}

/** MKS DLC32 MAX: $50–$54 (über die Leitung) bzw. [ESP401] (über die Weboberfläche) */
function planMks(plan: WifiPlan, mode: WifiMode, ssid: string, pw: string, canWeb: boolean, r: CharReport): WifiPlan {
  const [sId, pId, m] = mode === "sta" ? [53, 54, 2] : [51, 52, 1];
  // $50 zuletzt: die MKS-Firmware wechselt dabei SOFORT das WLAN (das eigene WLAN verschwindet)
  const vals: Array<[number, string]> = [[sId, ssid], [pId, pw]];
  const modeVal: [number, string] = [50, String(m)];
  plan.switchLast = true;
  plan.restart = "[ESP444]RESTART";
  plan.secret = [1];
  const radio = mode === "sta" ? "[ESP110]STA" : "[ESP110]AP";
  const risky = r.realtime.length || r.nonAscii.length;
  const unsafe = r.comment.length || r.space;
  if (risky || (unsafe && canWeb)) {
    if (!canWeb) { plan.route = "none"; plan.error = "wifi.err.espNeedWeb"; return plan; }
    // [ESP401] zerlegt „P=… T=… V=…“ an „=“ und das Ende an „]“ – diese beiden gehen dort nicht
    if (/[=\]]/.test(ssid + pw)) { plan.route = "none"; plan.error = "wifi.err.mksWebChars"; return plan; }
    plan.route = "web";
    const w = ([n, v]: [number, string]) => `[ESP401]P=${n} T=${n === 50 ? "B" : "S"} V=${v}`;
    plan.lines = [...vals.map(w), radio, w(modeVal)];
    plan.notes.push(risky ? "wifi.note.web" : "wifi.note.webSafer");
    return plan;
  }
  plan.lines = [...vals.map(([n, v]) => `$${n}=${v}`), radio, `$${modeVal[0]}=${modeVal[1]}`];
  if (unsafe) plan.notes.push("wifi.note.espComment");
  return plan;
}

// ---------------------------------------------------------------------
// WLAN-Liste vom Board ([ESP410] – Grbl_ESP32, MKS DLC32, FluidNC, ESP3D)
// ---------------------------------------------------------------------

export interface ApInfo { ssid: string; signal: number; secure: boolean }

/**
 * Antwort auf [ESP410] auswerten: {"AP_LIST":[{"SSID":"…","SIGNAL":"80","IS_PROTECTED":"1"}, …]}
 * (einzeilig oder über mehrere Zeilen verteilt, Zahlen/Wahrheitswerte mit oder ohne Anführungszeichen).
 * Gleiche Namen nur einmal (stärkstes Signal), versteckte Netze (ohne Namen) weg, stärkste zuerst.
 */
export function parseApList(lines: string[]): ApInfo[] {
  const text = lines.join("\n");
  const out = new Map<string, ApInfo>();
  const obj = /\{[^{}]*?"SSID"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = obj.exec(text))) {
    let ssid = m[1];
    try { ssid = JSON.parse(`"${m[1]}"`); } catch { /* roh lassen */ }
    if (!ssid.trim()) continue;
    const body = m[0];
    const sig = body.match(/"SIGNAL"\s*:\s*"?(-?\d+)/);
    const prot = body.match(/"IS_PROTECTED"\s*:\s*"?(true|false|1|0)/i);
    let signal = sig ? parseInt(sig[1], 10) : 0;
    if (signal < 0) signal = Math.max(0, Math.min(100, 2 * (signal + 100))); // dBm -> %
    const ap: ApInfo = { ssid, signal: Math.max(0, Math.min(100, signal)), secure: prot ? /^(true|1)$/i.test(prot[1]) : true };
    const old = out.get(ssid);
    if (!old || old.signal < ap.signal) out.set(ssid, ap);
  }
  return [...out.values()].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

/** Signal als Balken ▂▄▆█ */
export function signalBars(p: number): string {
  const n = p >= 75 ? 4 : p >= 50 ? 3 : p >= 25 ? 2 : 1;
  return "▂▄▆█".slice(0, n) + "·".repeat(4 - n);
}
