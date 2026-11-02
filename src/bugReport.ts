/**
 * FEHLERBERICHT: Text für ein GitHub-Issue bauen und persönliche Daten entfernen
 *
 * Es gibt keinen sicheren Weg, direkt aus der App ein Issue anzulegen (ein GitHub-Schlüssel in der App
 * wäre öffentlich). Darum öffnen wir die Seite „Neues Issue“ im Browser – die Felder des Formulars
 * `.github/ISSUE_TEMPLATE/bug_report.yml` werden über die Adresse vorausgefüllt (?<Feld-id>=…).
 *
 * Bereinigt werden: IP- und MAC-Adressen, E-Mails, WLAN-Namen und -Passwörter, Hostnamen,
 * Benutzernamen in Dateipfaden. Ohne DOM/Tauri, damit `npm test` es prüfen kann (tests/bugReport.test.ts).
 */

export const ISSUE_REPO = "Andys-3D-World/cnc-craft";
export const BUG_TEMPLATE = "bug_report.yml";
/** GitHub nimmt längere Adressen nicht sicher an */
export const MAX_URL = 8000;

const HIDDEN = "•••";

/** Werte hinter diesen Schlüsseln sind geheim oder verraten das Heimnetz */
const SECRET_KEYS = /((?:\$?[\w/]*?(?:PWD|PASSWORD|PASSWORT|PASS|PSK|SSID|HOSTNAME|HOST\s*NAME|AP[_ ]?NAME))\s*[=:]\s*)([^\s:\]]+(?: [^\s:\]=]+)*)/gi;

/** Eine Zeile (oder mehrere) von persönlichen Daten befreien */
export function cleanText(s: string): string {
  return String(s)
    // Benutzername in Pfaden: /Users/andreas/…, /home/andreas/…, C:\Users\andreas\…
    .replace(/(\/Users\/|\/home\/)[^/\\\s"'<>]+/gi, "$1<user>")
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^/\\"'<>\n]+/gi, "$1<user>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    // MAC vor IPv6, sonst sieht 12:34:56:… wie IPv6 aus
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "<mac>")
    .replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "<ip>")
    .replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/gi, m => (m.includes("::") && /[a-f]/i.test(m)) || m.split(":").length >= 5 ? "<ip>" : m)
    // MKS/Grbl_ESP32: WLAN in $51–$54 (Name/Passwort), Hostname in $320/$310 (grblHAL)
    .replace(/(\$(?:5[1-4]|3[0-3]\d)\s*=\s*)\S.*$/gm, "$1" + HIDDEN)
    // [ESP100]Name, [ESP101]Passwort, [ESP112]Hostname … und „[ESP401]P=53 T=S V=…“
    .replace(/(\[ESP\d{3}\])\s*\S.*$/gm, "$1" + HIDDEN)
    .replace(/(\bP=\d+\s+T=\w\s+V=)\S.*$/gm, "$1" + HIDDEN)
    // Namen im Netz: tcp://laser-garage:23, mks_grbl.local
    .replace(/(tcp:\/\/)[^\s:/<]+/gi, "$1<host>")
    .replace(/\b[\w-]+\.local\b/gi, "<host>.local")
    .replace(SECRET_KEYS, "$1" + HIDDEN);
}

export interface BugInfo {
  version: string;
  os: string;          // "macos" | "windows" | "linux"
  arch: string;
  mode: string;        // "mill" | "laser" | "plasma"
  board: string;       // z. B. "MKS DLC32 MAX"
  firmware: string;    // z. B. "Grbl_ESP32 1.0.10"
  connection: "" | "usb" | "net";
}

export interface BugReport {
  title: string;
  what: string;
  steps: string;
  expected: string;
  area: string;        // Wert aus AREAS (englisch, wie im Formular)
  severity: string;    // Wert aus SEVERITIES
  info: BugInfo | null;     // null = Systemangaben abgewählt
  machine: boolean;         // Maschine/Board mitschicken
  consoleLines: string[];   // leer = Konsole abgewählt
}

/** Auswahl-Werte genau wie in bug_report.yml (GitHub füllt Auswahlfelder nur mit dem exakten Text) */
export const AREAS = [
  "Drawing / design", "Import (SVG, DXF, PDF, PLT, images, STL, 3MF, STEP)", "Export (SVG, DXF, PDF, PLT)",
  "Generators (box, gear, puzzle, name …)", "Router CAM / toolpaths", "Laser (layers, image engraving)", "Plasma",
  "Simulation / G-code editor", "Machine control / connection", "Flash board / Wi-Fi setup / settings ($$)",
  "Wiring diagrams", "Camera", "Updates / installation", "Other"
];
export const SEVERITIES = [
  "Small (looks wrong, typo, inconvenient)",
  "Medium (a feature does not work, but there is a workaround)",
  "Big (crash, data lost, job cannot be done)",
  "Safety (machine moved unexpectedly, did not stop, laser/spindle stayed on)"
];

const MODE_NAME: Record<string, string> = { mill: "Router", laser: "Laser", plasma: "Plasma" };

/** Betriebssystem so, wie es im Formular steht – nur wenn eindeutig (Windows 10/11, Linux-Paket wissen wir nicht) */
export function osOption(os: string, arch: string): string {
  if (os === "macos") return arch === "aarch64" ? "macOS (Apple chip)" : "macOS (Intel)";
  return "";
}

export function osText(os: string, arch: string): string {
  const n = os === "macos" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os || "?";
  return arch ? `${n} (${arch})` : n;
}

export function machineText(i: BugInfo): string {
  return [MODE_NAME[i.mode] || i.mode, i.board, i.firmware].filter(Boolean).map(cleanText).join(" · ");
}

/** Letzte n Konsolenzeilen, bereinigt */
export function consoleTail(lines: string[], n = 50): string[] {
  return lines.filter(l => l.trim()).slice(-n).map(cleanText);
}

/** Alles als Markdown – für „In die Zwischenablage kopieren“ */
export function reportMarkdown(r: BugReport): string {
  const out: string[] = [`## ${cleanText(r.title) || "Bug"}`, ""];
  const sec = (h: string, v: string) => { if (v.trim()) out.push(`### ${h}`, cleanText(v.trim()), ""); };
  if (r.info) {
    out.push(`- **Version:** ${cleanText(r.info.version)}`, `- **OS:** ${osText(r.info.os, r.info.arch)}`);
    if (r.machine) {
      out.push(`- **Machine:** ${machineText(r.info)}`);
      if (r.info.connection) out.push(`- **Connection:** ${r.info.connection === "net" ? "Wi-Fi / network" : "USB"}`);
    }
  }
  if (r.area) out.push(`- **Area:** ${r.area}`);
  if (r.severity) out.push(`- **Severity:** ${r.severity}`);
  out.push("");
  sec("What happened?", r.what);
  sec("Steps to reproduce", r.steps);
  sec("What did you expect instead?", r.expected);
  if (r.consoleLines.length) out.push("### Console output", "```text", ...r.consoleLines.map(cleanText), "```", "");
  return out.join("\n");
}

/**
 * Adresse der GitHub-Seite „Neues Issue“ mit vorausgefüllten Feldern.
 * Wird sie zu lang, fallen zuerst die ältesten Konsolenzeilen weg, danach wird der Text gekürzt.
 * full = false: nicht alles passte hinein (dann alles in die Zwischenablage legen).
 */
export function issueUrl(r: BugReport, max = MAX_URL): { url: string; full: boolean } {
  const build = (r: BugReport) => {
    const q = new URLSearchParams();
    q.set("template", BUG_TEMPLATE);
    q.set("title", "[Bug] " + cleanText(r.title).trim().slice(0, 200));
    if (r.info) {
      q.set("version", cleanText(r.info.version) + " Beta");
      const os = osOption(r.info.os, r.info.arch);
      if (os) q.set("os", os);
      if (r.machine) {
        const m = machineText(r.info);
        if (m) q.set("machine", m);
        if (r.info.connection) q.set("connection", r.info.connection === "net" ? "Wi-Fi / network" : "USB");
      }
    }
    if (r.area) q.set("area", r.area);
    if (r.severity) q.set("severity", r.severity);
    if (r.what.trim()) q.set("what", cleanText(r.what.trim()));
    if (r.steps.trim()) q.set("steps", cleanText(r.steps.trim()));
    if (r.expected.trim()) q.set("expected", cleanText(r.expected.trim()));
    if (r.consoleLines.length) q.set("console", r.consoleLines.map(cleanText).join("\n"));
    return `https://github.com/${ISSUE_REPO}/issues/new?${q.toString()}`;
  };
  let lines = r.consoleLines.slice();
  let url = build(r);
  while (url.length > max && lines.length) {
    lines = lines.slice(Math.max(1, Math.ceil(lines.length / 10)));
    url = build({ ...r, consoleLines: lines });
  }
  // Texte selbst zu lang (sehr selten): Beschreibung kürzen, bis es passt – alles steht auch in der Zwischenablage
  const full = lines.length === r.consoleLines.length;
  let keep = 1;
  while (url.length > max && keep > 0.05) {
    keep *= 0.7;
    const cut = (s: string) => s.slice(0, Math.floor(s.length * keep));
    url = build({ ...r, what: cut(r.what), steps: cut(r.steps), expected: cut(r.expected), consoleLines: [] });
  }
  return { url, full: full && keep === 1 };
}
