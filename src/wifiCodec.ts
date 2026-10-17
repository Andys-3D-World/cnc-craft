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
}

/**
 * Was wird wie geschickt?
 * canWeb = Weboberfläche des Boards erreichbar (Adresse bekannt)
 * hal39  = aktueller Wert von $39 bei grblHAL (null = unbekannt)
 */
export function planWifi(fw: WifiFw, mode: WifiMode, ssid: string, pw: string, canWeb: boolean, hal39: string | null = null): WifiPlan {
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

  // Grbl_ESP32 / MKS DLC32: ESP3D-Befehle ([ESP100] Heimnetz-Name, [ESP101] Passwort, [ESP110] Funk-Art)
  plan.lines = mode === "sta"
    ? [`[ESP100]${ssid}`, `[ESP101]${pw}`, "[ESP110]STA"]
    : [`[ESP105]${ssid}`, `[ESP106]${pw}`, "[ESP110]AP"];
  plan.secret = [1];
  plan.restart = "[ESP444]RESTART";
  const risky = r.realtime.length || r.nonAscii.length;
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
