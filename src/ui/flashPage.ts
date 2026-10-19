/**
 * BOARD FLASHEN (Reiter "Board flashen")
 *
 *  0. Board wählen (Hersteller/Modell) – danach werden NUR passende Dateien angenommen:
 *       richtige Dateiart (.bin/.elf für ESP32-Boards, .hex für Arduino), richtiger Chip
 *       (ESP32 / ESP32-S3 …), passende Größe. Falsche Dateien werden gesperrt, nicht nur gewarnt.
 *  1. Firmware-Datei wählen – wird sofort geprüft:
 *       .bin (ESP32-Familie): Chip, Komplettdatei oder nur App, Ziel-Adresse, Flash-Größe, Version
 *       .elf (ESP32-Familie): wird beim Flashen in ein startfähiges Abbild umgewandelt (wie esptool elf2image)
 *       .hex (Arduino/GRBL):  Größe, GRBL-Version – GRBL 1.1h ist mitgeliefert
 *  2. Port + Geschwindigkeit wählen
 *  3. $$-Einstellungen vorher sichern (Komplettdateien setzen sie zurück!)
 *  4. „Auf eigene Gefahr“ bestätigen, dann flashen (Rust: src-tauri/src/flash.rs).
 *     Beim Flashen prüft der Rust-Teil zusätzlich den ECHTEN Chip am Board und bricht bei
 *     falschem Chip ab (ESP-Chipkennung bzw. AVR-Signatur).
 *  5. Danach: Einstellungen auf Wunsch zurückspielen
 *     (nach einem Firmware-Wechsel, z. B. MKS -> grblHAL, nur die Werte, die bei beiden dasselbe bedeuten)
 *
 *  grblHAL: Der Web Builder liefert eine .zip (Bootloader, Partitionen, Firmware). Sie wird im Rust-Teil
 *  geprüft (fwzip.rs: Adressen, Chip, Flash-Größe, Board-Name in der Firmware) und in EINEM Durchgang geflasht.
 *
 * Kein esptool, kein avrdude, keine Arduino-IDE nötig.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, listPorts, connect, disconnect, sendAndWait, PortInfo, lastBoardInfo, fmtBuildDate } from "../machine";

interface FileInfo {
  path: string;
  name: string;
  kind: "esp" | "avr" | "elf" | "zip";
  size: number;
  chip: string;          // "ESP32-S3", "ESP32", … bzw. "ATmega328P (Arduino)"
  chipId: number | null; // ESP-Chipkennung aus dem Datei-Kopf (null = unbekannt)
  merged: boolean;       // Komplettdatei (Bootloader + Partitionen + App)
  offset: number;
  flashSize: number;     // Bytes
  version: string;
  warnings: string[];
  parts?: { name: string; role: string; offset: number; size: number }[]; // nur ZIP
  boardOk?: boolean | null;  // ZIP: steht der Board-Name in der Firmware? (null = nicht prüfbar)
}

/** Boards, die man auswählen kann – nur dafür passende Dateien werden angenommen */
interface Board {
  id: string;
  nameKey?: string;      // Übersetzung …
  name?: string;         // … oder fester Name
  kind: "esp" | "avr";
  chipId?: number;       // ESP: 0 = ESP32, 9 = ESP32-S3 …
  chip: string;
  flash?: number;        // Flash-Größe in Bytes (falls sicher bekannt)
  maxHex?: number;       // AVR: größte erlaubte Programmgröße
  max?: boolean | null;  // MKS DLC32: true = MAX, false = normales DLC32
  links: string[];       // Schlüssel aus LINKS
  fwExpect?: string;     // dieser Text steht in einer grblHAL-Firmware für genau dieses Board
  /** Eigene grblHAL-Anleitung dieses Boards: Texte fl.hal.<halGuide>.howto / .after / .web.
   *  Jedes Board bekommt seine eigene – ohne Eintrag wird keine Anleitung gezeigt. */
  halGuide?: string;
  /** Eigene Anleitung „Original-Firmware aufspielen“: Texte fl.orig.<origGuide>.howto / .after */
  origGuide?: string;
}

const BOARDS: Board[] = [
  { id: "mks-dlc32-max", name: "MKS DLC32 MAX (V1.0 / V1.2)", kind: "esp", chipId: 9, chip: "ESP32-S3", flash: 8 * 1048576, max: true, links: ["fl.link.mksMax", "fl.link.grblhal"],
    fwExpect: "MKS DLC32 MAX", halGuide: "max", origGuide: "max" },
  { id: "mks-dlc32", name: "MKS DLC32 (V2.0 / V2.1)", kind: "esp", chipId: 0, chip: "ESP32", max: false, links: ["fl.link.mks", "fl.link.fluidnc", "fl.link.grblhal"],
    fwExpect: "MKS DLC32 2." },
  { id: "esp32", nameKey: "fl.board.esp32", kind: "esp", chipId: 0, chip: "ESP32", links: ["fl.link.fluidnc", "fl.link.grblhal"] },
  { id: "esp32s3", nameKey: "fl.board.esp32s3", kind: "esp", chipId: 9, chip: "ESP32-S3", links: ["fl.link.grblhal"] },
  { id: "arduino-uno", nameKey: "fl.board.uno", kind: "avr", chip: "ATmega328P", maxHex: 32256, links: ["fl.link.grbl"] },
  { id: "arduino-nano", nameKey: "fl.board.nano", kind: "avr", chip: "ATmega328P", maxHex: 30720, links: ["fl.link.grbl"] }
];

const BACKUP_KEY = "cnc_craft_settings_backup";
const BOARD_KEY = "cnc_craft_flash_board";
const LINKS: Record<string, string> = {
  "fl.link.mksMax": "https://github.com/makerbase-mks/MKS-DLC32/tree/main/MKS--DLC32-MAX-main/firmware",
  "fl.link.mks": "https://github.com/makerbase-mks/MKS-DLC32/tree/main/MKS-DLC32-main",
  "fl.link.grbl": "https://github.com/gnea/grbl/releases",
  "fl.link.fluidnc": "https://github.com/bdring/FluidNC/releases",
  "fl.link.grblhal": "https://webbuilder.grblhal.org/",
  // Weboberfläche für grblHAL (ESP3D-WebUI v3) – muss nach jedem Flashen neu aufs Board
  "fl.link.webuiFile": "https://github.com/luc-github/ESP3D-WEBUI/tree/3.0/dist/CNC/GRBLHal"
};

let board: Board | null = null;
let file: FileInfo | null = null;
let riskOk = false; // „auf eigene Gefahr“ bestätigt (gilt nur für die aktuelle Datei)
let ports: PortInfo[] = [];
let busy = false;
let stage = "";
let pct = 0;
let resultHtml = "";
let log: (s: string) => void = () => {};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
const hex = (n: number) => "0x" + n.toString(16).toUpperCase();
const mb = (n: number) => (n / 1048576).toFixed(n >= 1048576 ? 1 : 2) + " MB";
const boardName = (b: Board) => b.nameKey ? t(b.nameKey) : (b.name || b.id);

// ---------------------------------------------------------------------
// Datei prüfen
// ---------------------------------------------------------------------

const ESP_CHIPS: Record<number, string> = { 0: "ESP32", 2: "ESP32-S2", 9: "ESP32-S3", 5: "ESP32-C3", 12: "ESP32-C2", 13: "ESP32-C6", 16: "ESP32-H2" };
const FLASH_SIZES = [1, 2, 4, 8, 16, 32, 64, 128].map(m => m * 1048576);

/** Lesbare Versionsangaben im Binär-Inhalt suchen (z. B. "MKS DLC32 MAX", "V1.0.10", "Grbl 1.1h") */
function findVersion(bytes: Uint8Array, fileName: string): string {
  const fromName = fileName.match(/V\d+\.\d+(\.\d+)?/i)?.[0] || "";
  const n = Math.min(bytes.length, 4 * 1048576);
  let text = "";
  for (let i = 0; i < n; i++) { const c = bytes[i]; text += c >= 32 && c < 127 ? String.fromCharCode(c) : "\n"; }
  const hits = new Set<string>();
  for (const re of [/MKS DLC32[ A-Za-z]*/g, /FluidNC v?\d+\.\d+\.\d+/g, /Grbl[ _]?\d\.\d[a-z]?/g, /grblHAL[ \d.a-z]*/g]) {
    for (const m of text.match(re) || []) { if (m.length < 40) hits.add(m.trim()); if (hits.size > 3) break; }
  }
  const list = [...hits];
  // Version aus dem Dateinamen nur, wenn sie nicht schon im Inhalt steckt
  if (fromName && !list.some(h => h.toLowerCase().includes(fromName.toLowerCase().replace(/^v/, "")))) list.push(fromName);
  return list.slice(0, 3).join(" · ");
}

export function inspectBin(bytes: Uint8Array, name: string, path: string): FileInfo {
  const w: string[] = [];
  let hdr = -1;
  if (bytes[0] === 0xe9) hdr = 0;
  else if (bytes.length > 0x1010 && bytes[0x1000] === 0xe9) hdr = 0x1000;
  if (hdr < 0) w.push(t("fl.warn.noHeader"));
  const chipId = hdr >= 0 ? bytes[hdr + 12] | (bytes[hdr + 13] << 8) : null;
  const chip = chipId !== null ? (ESP_CHIPS[chipId] || `ESP (${chipId})`) : "?";
  // Komplettdatei = Partitionstabelle bei 0x8000
  const merged = bytes.length > 0x8002 && bytes[0x8000] === 0xaa && bytes[0x8001] === 0x50;
  // Bootloader liegt beim ESP32 bei 0x1000, bei S2/S3/C3 bei 0x0
  let offset = 0x10000;
  if (merged) offset = 0;
  else if (hdr >= 0 && chipId !== 0 && bytes.length < 0x8000) offset = 0; // nur Bootloader (S3)
  const fsCode = hdr >= 0 ? bytes[hdr + 3] >> 4 : 2;
  const flashSize = FLASH_SIZES[fsCode] || 4 * 1048576;
  if (!merged) w.push(t("fl.warn.appOnly", { o: hex(offset) }));
  if (bytes.length + offset > flashSize) w.push(t("fl.warn.tooBig", { s: mb(flashSize) }));
  return { path, name, kind: "esp", size: bytes.length, chip, chipId, merged, offset, flashSize, version: findVersion(bytes, name), warnings: w };
}

export function inspectHex(text: string, name: string, path: string): FileInfo {
  const w: string[] = [];
  let max = 0;
  const data: number[] = [];
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l.startsWith(":")) continue;
    const b = l.slice(1).match(/../g)?.map(x => parseInt(x, 16)) || [];
    if (b.length < 5) continue;
    const addr = (b[1] << 8) | b[2];
    if (b[3] === 0) {
      for (let i = 0; i < b[0]; i++) { data[base + addr + i] = b[4 + i]; }
      max = Math.max(max, base + addr + b[0]);
    } else if (b[3] === 2) base = ((b[4] << 8) | b[5]) << 4;
    else if (b[3] === 4) base = ((b[4] << 8) | b[5]) << 16;
  }
  const bytes = Uint8Array.from({ length: max }, (_, i) => data[i] ?? 0xff);
  if (!max) w.push(t("fl.warn.noHex"));
  return { path, name, kind: "avr", size: max, chip: "ATmega328P (Arduino Uno/Nano)", chipId: null, merged: false, offset: 0, flashSize: 32768, version: findVersion(bytes, name), warnings: w };
}

/** .elf prüfen (der Rust-Teil wandelt sie probeweise um) */
async function inspectElf(path: string, name: string): Promise<FileInfo> {
  const info = await invoke<any>("elf_inspect", { path });
  const version = [info.project, info.version].filter(Boolean).join(" ") + (info.idf ? ` (ESP-IDF ${info.idf})` : "");
  return {
    path, name, kind: "elf", size: info.size, chip: info.chip, chipId: info.chip_id, merged: false, offset: 0x10000,
    flashSize: board?.flash || 4 * 1048576, version: version.trim(), warnings: [t("fl.warn.elf")]
  };
}

/** grblHAL-ZIP prüfen (der Rust-Teil liest sie: Teile, Adressen, Chip, Flash-Größe, Board-Name) */
async function inspectZip(path: string, name: string): Promise<FileInfo> {
  const z = await invoke<any>("fw_zip_inspect", { path, expect: board?.fwExpect || null });
  const parts = (z.parts || []) as FileInfo["parts"];
  return {
    path, name, kind: "zip", size: parts!.reduce((a, p) => a + p.size, 0), chip: z.chip, chipId: z.chip_id ?? null,
    merged: true, offset: 0, flashSize: z.needs_flash, version: z.version || "", warnings: [], parts, boardOk: z.board_ok ?? null
  };
}

/**
 * Passt die Datei zum gewählten Board?
 * blocks = Flashen gesperrt, warns = Hinweise (mit „auf eigene Gefahr“ bestätigen)
 */
export function checkFile(b: Board | null, f: FileInfo | null): { blocks: string[]; warns: string[] } {
  const blocks: string[] = [], warns: string[] = [];
  if (!b) { blocks.push(t("fl.chk.noBoard")); return { blocks, warns }; }
  if (!f) return { blocks, warns };
  if (b.kind === "avr" && f.kind !== "avr") blocks.push(t("fl.chk.needHex", { board: boardName(b) }));
  if (b.kind === "esp" && f.kind === "avr") blocks.push(t("fl.chk.needBin", { board: boardName(b) }));
  if (b.kind === "avr" && f.kind === "zip") blocks.push(t("fl.chk.needHex", { board: boardName(b) }));
  if (b.kind === "esp" && f.kind !== "avr") {
    if (f.chipId === null) warns.push(t("fl.chk.chipUnknown", { chip: b.chip }));
    else if (f.chipId !== b.chipId) blocks.push(t("fl.chk.wrongChip", { file: ESP_CHIPS[f.chipId] || f.chip, board: boardName(b), chip: b.chip }));
    if (b.flash && f.size + f.offset > b.flash) blocks.push(t("fl.chk.tooBig", { s: mb(b.flash) }));
    if (f.kind === "zip") {
      if (b.flash && f.flashSize > b.flash) blocks.push(t("fl.chk.zipFlash", { need: mb(f.flashSize), have: mb(b.flash) }));
      // grblHAL-Firmware für ein anderes Board? (der Board-Name steht in der Firmware)
      if (f.boardOk === false) (/grblhal/i.test(f.version) ? blocks : warns).push(t("fl.chk.zipBoard", { board: boardName(b) }));
    }
    // MKS: Datei für das andere Modell (MAX ↔ normal)?
    if (b.max !== undefined && b.max !== null && /DLC32/i.test(`${f.name} ${f.version}`)) {
      const fileMax = /MAX/i.test(`${f.name} ${f.version}`);
      if (fileMax !== b.max) blocks.push(t("fl.chk.otherModel", { board: boardName(b) }));
    }
  }
  if (b.kind === "avr" && f.kind === "avr") {
    if (!f.size) blocks.push(t("fl.warn.noHex"));
    else if (b.maxHex && f.size > b.maxHex) blocks.push(t("fl.warn.hexTooBig", { n: f.size }));
  }
  return { blocks, warns };
}

// ---------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------

/** "1.0.10" vs "1.0.4" -> 1 / 0 / -1 (null = nicht vergleichbar) */
function cmpVersion(a: string, b: string): number | null {
  const pa = a.match(/\d+(\.\d+)+/)?.[0].split(".").map(Number);
  const pb = b.match(/\d+(\.\d+)+/)?.[0].split(".").map(Number);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Was ist gerade auf dem Board – und passt die Datei dazu? */
function boardCompareHtml(): string {
  const bi = machine.connected && machine.info.version ? { ...machine.info, seen: "" } : lastBoardInfo();
  if (!bi || !bi.version) return "";
  const when = bi.seen ? " · " + t("fl.board.seen", { d: new Date(bi.seen).toLocaleDateString() }) : "";
  let cmp = "";
  if (file) {
    const fileName = `${file.version} ${file.name}`;
    const c = cmpVersion(fileName.match(/V?(\d+\.\d+\.\d+)/i)?.[1] || "", bi.version);
    if (c === 1) cmp = `<div class="fl-cmp fl-newer">⬆ ${t("fl.board.newer")}</div>`;
    else if (c === 0) cmp = `<div class="fl-cmp">＝ ${t("fl.board.same")}</div>`;
    else if (c === -1) cmp = `<div class="fl-cmp fl-older">⬇ ${t("fl.board.older")}</div>`;
    // MAX-Datei für normales DLC32 oder umgekehrt?
    const boardMax = /MAX/i.test(bi.name), fileMax = /MAX/i.test(fileName);
    if (/DLC32/i.test(bi.name) && /DLC32/i.test(fileName) && boardMax !== fileMax) {
      cmp += `<div class="sp-warn">⚠ ${t("fl.board.otherModel", { board: esc(bi.name) })}</div>`;
    }
  }
  return `<div class="fl-board">${t("fl.board.now")}: <b>${esc([bi.name, bi.version].filter(Boolean).join(" · "))}</b>${bi.date ? ` (${esc(fmtBuildDate(bi.date))})` : ""}${when}</div>${cmp}`;
}

function portLabel(p: PortInfo) {
  return `${p.name}${p.chip ? " – " + p.chip : ""}${p.product ? " · " + p.product : ""}`;
}

/** Board automatisch vorwählen: gemerkte Wahl, sonst das verbundene / zuletzt gesehene Board */
function guessBoard(): Board | null {
  try {
    const id = localStorage.getItem(BOARD_KEY);
    const b = BOARDS.find(x => x.id === id);
    if (b) return b;
  } catch { /* egal */ }
  const name = (machine.connected ? machine.info.name : lastBoardInfo()?.name) || "";
  if (/DLC32/i.test(name)) return BOARDS.find(x => x.id === (/MAX/i.test(name) ? "mks-dlc32-max" : "mks-dlc32")) || null;
  return null;
}

function setBoard(b: Board | null) {
  board = b;
  riskOk = false;
  try { if (b) localStorage.setItem(BOARD_KEY, b.id); } catch { /* egal */ }
  if (file && file.kind === "elf" && b?.flash) file.flashSize = b.flash;
}

function render() {
  const root = document.getElementById("flash-page");
  if (!root) return;
  const sel = (document.getElementById("fl-port") as HTMLSelectElement | null)?.value || machine.port || "";
  const selBaud = (document.getElementById("fl-baud") as HTMLSelectElement | null)?.value || "921600";
  const backup = loadBackup();
  const jtagPort = ports.find(p => p.name === sel)?.chip?.startsWith("ESP32-S3/C3");
  const chk = checkFile(board, file);
  const canFlash = !!board && !!file && !busy && chk.blocks.length === 0 && riskOk;
  const accept = board ? (board.kind === "avr" ? ".hex" : ".bin / .elf / .zip") : "";
  const links = board ? board.links : Object.keys(LINKS);
  root.innerHTML = `
    <h2>⚡ ${T("fl.title")}</h2>
    <p class="panel-desc">${T("fl.desc")}</p>

    <section class="sp-card">
      <h3>1 · ${T("fl.step.board")}</h3>
      <div class="fl-row">
        <select id="fl-board" ${busy ? "disabled" : ""}>
          <option value="">${t("fl.board.choose")}</option>
          ${BOARDS.map(b => `<option value="${b.id}" ${board?.id === b.id ? "selected" : ""}>${esc(boardName(b))} – ${b.chip}</option>`).join("")}
        </select>
      </div>
      ${board ? `<div class="tool-scope">${t("fl.board.accepts", { files: accept, chip: board.chip })}</div>` : `<div class="sp-warn">⚠ ${t("fl.chk.noBoard")}</div>`}
      ${boardCompareHtml()}
    </section>

    <section class="sp-card">
      <h3>2 · ${T("fl.step.file")}</h3>
      <div class="fl-row">
        <button id="fl-pick" class="btn-secondary" ${busy || !board ? "disabled" : ""}>📂 ${T("fl.pick")}</button>
        <span class="fl-file">${file ? esc(file.name) : t("fl.noFile")}</span>
      </div>
      ${!board || board.kind === "avr" ? `<div class="fl-row">
        <button id="fl-bundled" class="btn-secondary btn-compact" ${busy ? "disabled" : ""} ${tip("fl.bundledTip")}>📦 ${T("fl.bundled")}</button>
      </div>` : ""}
      ${file ? `
      <div class="fl-info">
        <div><span>${t("fl.info.chip")}</span><b>${esc(file.chip)}</b></div>
        <div><span>${t("fl.info.type")}</span><b>${file.kind === "avr" ? t("fl.type.hex") : file.kind === "elf" ? t("fl.type.elf") : file.kind === "zip" ? t("fl.type.zip") : file.merged ? t("fl.type.merged") : t("fl.type.app")}</b></div>
        <div><span>${t("fl.info.size")}</span><b>${mb(file.size)}</b></div>
        ${file.kind === "zip" ? `<div><span>${t("fl.info.flash")}</span><b>${mb(file.flashSize)}</b></div>
        <div class="fl-wide"><span>${t("fl.info.parts")}</span><b>${(file.parts || []).map(p => `${esc(p.name)} → ${hex(p.offset)}`).join(" · ")}</b></div>` : ""}
        ${file.kind !== "avr" && file.kind !== "zip" ? `<div><span>${t("fl.info.offset")}</span><b><input id="fl-offset" class="sp-input" value="${hex(file.offset)}" ${tip("fl.offsetTip")}></b></div>
        <div><span>${t("fl.info.flash")}</span><b>${mb(file.flashSize)}</b></div>` : ""}
        ${file.version ? `<div class="fl-wide"><span>${t("fl.info.version")}</span><b>${esc(file.version)}</b></div>` : ""}
      </div>
      ${chk.blocks.map(w => `<div class="fl-block">⛔ ${esc(w)}</div>`).join("")}
      ${file.warnings.concat(chk.warns).map(w => `<div class="sp-warn">⚠ ${esc(w)}</div>`).join("")}
      ${file.kind === "esp" && file.merged ? `<div class="sp-warn">⚠ ${t("fl.warn.mergedResets")}</div>` : ""}` : ""}
      ${board?.origGuide ? `<details class="fl-help fl-hal"><summary>🏭 ${t("fl.orig.title")}</summary>
        <div>${t(`fl.orig.${board.origGuide}.howto`)}</div>
        ${board.links[0] ? `<button class="btn-secondary btn-compact" data-url="${LINKS[board.links[0]]}">🌐 ${t("fl.orig.open")}</button>` : ""}
        <h4 class="fl-hal-h">${t("fl.hal.afterTitle")}</h4>
        <div>${t(`fl.orig.${board.origGuide}.after`)}</div>
      </details>` : ""}
      ${board?.halGuide ? `<details class="fl-help fl-hal"><summary>🧩 ${t("fl.hal.title")}</summary>
        <div>${t(`fl.hal.${board.halGuide}.howto`)}</div>
        <button class="btn-secondary btn-compact" data-url="${LINKS["fl.link.grblhal"]}">🌐 ${t("fl.hal.open")}</button>
        <h4 class="fl-hal-h">${t("fl.hal.afterTitle")}</h4>
        <div>${t(`fl.hal.${board.halGuide}.after`)}</div>
        <h4 class="fl-hal-h">${t("fl.hal.webTitle")}</h4>
        <div>${t(`fl.hal.${board.halGuide}.web`)}</div>
        <button class="btn-secondary btn-compact" data-url="${LINKS["fl.link.webuiFile"]}">⬇ ${t("fl.hal.webuiFile")}</button>
      </details>` : ""}
      <div class="fl-links">${t("fl.where")} ${links.map(k => `<a href="#" data-url="${LINKS[k]}">${t(k)}</a>`).join(" · ")}</div>
    </section>

    <section class="sp-card">
      <h3>3 · ${T("fl.step.port")}</h3>
      <div class="fl-row">
        <select id="fl-port" ${busy ? "disabled" : ""}>${ports.length ? ports.map(p => `<option value="${esc(p.name)}" ${p.name === sel ? "selected" : ""}>${esc(portLabel(p))}</option>`).join("") : `<option value="">${t("m.noPorts")}</option>`}</select>
        <button id="fl-scan" class="btn-secondary btn-icon" ${tip("m.scanTip")} ${busy ? "disabled" : ""}>🔍</button>
        ${!file || file.kind !== "avr" ? `<select id="fl-baud" ${tip("fl.baudTip")} ${busy ? "disabled" : ""}>
          ${["921600", "460800", "230400", "115200"].map(b => `<option ${b === selBaud ? "selected" : ""}>${b}</option>`).join("")}
        </select>` : ""}
      </div>
      ${jtagPort ? `<div class="tool-scope">${t("fl.usbJtag")}</div>` : ""}
      ${machine.connected ? `<div class="tool-scope">${t("fl.willDisconnect")}</div>` : ""}
    </section>

    <section class="sp-card">
      <h3>4 · ${T("fl.step.backup")}</h3>
      <label class="fl-row" style="cursor:pointer;"><input type="checkbox" id="fl-backup" checked ${busy ? "disabled" : ""}> ${t("fl.backupBefore")}</label>
      <div class="tool-scope">${backup ? t("fl.backupHave", { n: Object.keys(backup.settings).length, date: new Date(backup.date).toLocaleString(), fw: esc(backup.firmware) }) : t("fl.backupNone")}</div>
      ${backup ? `<button id="fl-restore" class="btn-secondary btn-compact" ${busy ? "disabled" : ""} ${tip("fl.restoreTip")}>↩ ${T("fl.restore")}</button>` : ""}
    </section>

    <section class="sp-card">
      <h3>5 · ${T("fl.step.flash")}</h3>
      <div class="fl-risk">
        <label><input type="checkbox" id="fl-risk" ${riskOk ? "checked" : ""} ${busy || !file || chk.blocks.length ? "disabled" : ""}>
        <span>${t("fl.risk")}</span></label>
        <div class="tool-scope">${t("fl.riskHw")}</div>
      </div>
      <div class="fl-row">
        <button id="fl-go" class="btn-primary" ${canFlash ? "" : "disabled"}>⚡ ${T("fl.go")}</button>
        ${busy ? `<button id="fl-cancel" class="btn-secondary">✕ ${T("dlg.cancel")}</button>` : ""}
      </div>
      <div class="fl-progress"><div id="fl-bar" style="width:${pct}%"></div></div>
      <div id="fl-stage" class="fl-stage">${esc(stage)}</div>
      ${resultHtml}
      <details class="fl-help"><summary>${t("fl.helpTitle")}</summary><div>${t("fl.help")}</div></details>
    </section>`;
  bind();
}

function bind() {
  const $ = (id: string) => document.getElementById(id);
  $("fl-board")?.addEventListener("change", () => {
    const id = ($("fl-board") as HTMLSelectElement).value;
    setBoard(BOARDS.find(b => b.id === id) || null);
    resultHtml = "";
    render();
  });
  $("fl-pick")?.addEventListener("click", pickFile);
  $("fl-bundled")?.addEventListener("click", () => { selectBundledGrbl(); });
  $("fl-scan")?.addEventListener("click", async () => { ports = await listPorts(); render(); });
  $("fl-port")?.addEventListener("change", render);
  $("fl-risk")?.addEventListener("change", () => { riskOk = ($("fl-risk") as HTMLInputElement).checked; render(); });
  $("fl-go")?.addEventListener("click", startFlash);
  $("fl-cancel")?.addEventListener("click", () => { invoke("flash_cancel").catch(() => {}); });
  $("fl-restore")?.addEventListener("click", () => restoreSettings());
  $("fl-offset")?.addEventListener("change", () => {
    const el = $("fl-offset") as HTMLInputElement;
    const v = parseInt(el.value, el.value.trim().toLowerCase().startsWith("0x") ? 16 : 10);
    if (file && Number.isFinite(v) && v >= 0) file.offset = v;
    riskOk = false;
    render();
  });
  document.querySelectorAll<HTMLElement>("#flash-page [data-url]").forEach(a => a.addEventListener("click", (e) => {
    e.preventDefault();
    openUrl(a.dataset.url!).catch(() => log(a.dataset.url!));
  }));
}

// ---------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------

/** Mitgelieferte GRBL-1.1h-Datei für Arduino UNO/Nano auswählen (z. B. statt Estlcam-Firmware) */
export async function selectBundledGrbl(boardId?: "arduino-uno" | "arduino-nano") {
  try {
    if (boardId) setBoard(BOARDS.find(b => b.id === boardId) || null);
    else if (!board || board.kind !== "avr") setBoard(BOARDS.find(b => b.id === "arduino-uno") || null);
    const text = await invoke<string>("bundled_firmware", { name: "grbl" });
    file = inspectHex(text, "grbl_v1.1h.20190825.hex", "bundled:grbl");
    file.version = "GRBL 1.1h (20190825)";
    riskOk = false;
    resultHtml = ""; stage = ""; pct = 0;
    if (!ports.length) ports = await listPorts();
    render();
    log(t("fl.bundledChosen", { btn: t("fl.go") }));
  } catch (e) { log(`${t("log.error")} ${e}`); }
}

async function pickFile() {
  if (!board) { log(t("fl.chk.noBoard")); return; }
  try {
    const ext = board.kind === "avr" ? ["hex"] : ["bin", "elf", "zip"];
    const p = await open({ multiple: false, directory: false, title: t("fl.pick"), filters: [{ name: `Firmware (${ext.map(e => "." + e).join(", ")})`, extensions: ext }] });
    if (!p) return;
    const path = String(typeof p === "object" && p !== null ? (p as any).path : p);
    const name = path.split(/[\\/]/).pop() || path;
    if (/\.zip$/i.test(name)) {
      try { file = await inspectZip(path, name); }
      catch (e) { file = null; log(t("fl.zipFailed", { e: String(e) })); render(); return; }
    } else if (/\.elf$/i.test(name)) {
      try { file = await inspectElf(path, name); }
      catch (e) { file = null; log(t("fl.elfFailed", { e: String(e) })); render(); return; }
    } else {
      const bytes = await readFile(path);
      file = /\.hex$/i.test(name) ? inspectHex(new TextDecoder().decode(bytes), name, path) : inspectBin(bytes, name, path);
    }
    riskOk = false;
    resultHtml = ""; stage = ""; pct = 0;
    render();
  } catch (e) { log(`${t("log.error")} ${e}`); }
}

interface Backup { date: string; firmware: string; settings: Record<string, string> }
function loadBackup(): Backup | null {
  try { const r = localStorage.getItem(BACKUP_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

async function backupNow(): Promise<boolean> {
  if (!machine.connected) return false;
  if (machine.settings.size === 0) await sendAndWait("$$", 8000, true);
  if (machine.settings.size === 0) return false;
  const b: Backup = { date: new Date().toISOString(), firmware: `${machine.firmware} ${machine.version}`.trim(), settings: Object.fromEntries(machine.settings) };
  try { localStorage.setItem(BACKUP_KEY, JSON.stringify(b)); } catch { return false; }
  log(t("fl.backupDone", { n: machine.settings.size }));
  return true;
}

async function startFlash() {
  if (!file || busy || !board) return;
  // nochmal prüfen – gesperrte Kombinationen werden nie geflasht
  const chk = checkFile(board, file);
  if (chk.blocks.length) { log(`${t("log.error")} ${chk.blocks[0]}`); return; }
  if (!riskOk) { log(t("fl.riskNeeded")); return; }
  const port = (document.getElementById("fl-port") as HTMLSelectElement).value;
  if (!port) { log(t("m.choosePort")); return; }
  const baud = parseInt((document.getElementById("fl-baud") as HTMLSelectElement | null)?.value || "115200", 10);
  const wantBackup = (document.getElementById("fl-backup") as HTMLInputElement).checked;
  const pinfo = ports.find(p => p.name === port);
  const usbJtag = !!pinfo && pinfo.vid === 0x303a;

  if (!window.confirm(t("fl.confirm", { file: file.name, chip: `${file.chip} → ${boardName(board)}`, port }))) return;

  busy = true; resultHtml = ""; pct = 0; stage = t("fl.stage.prepare"); render();
  if (wantBackup && machine.connected) {
    const ok = await backupNow();
    if (!ok && !window.confirm(t("fl.confirmNoBackup"))) { busy = false; stage = ""; render(); return; }
  }
  if (machine.connected) await disconnect();

  try {
    const res = file.kind === "zip"
      ? await invoke<string>("flash_zip", { port, path: file.path, baud, usbJtag, flashSize: board.flash || file.flashSize })
      : await invoke<string>("flash_firmware", {
        port, path: file.path, kind: file.kind, offset: file.offset, baud, usbJtag, flashSize: board.flash || file.flashSize
      });
    let info: any = {};
    try { info = JSON.parse(res); } catch { /* egal */ }
    pct = 100;
    stage = t("fl.stage.done");
    resultHtml = `<div class="fl-ok">✔ ${t("fl.success", { chip: info.chip || file.chip, kb: Math.round((info.bytes || file.size) / 1024), s: info.seconds ?? "–" })}</div>
      <div class="tool-scope">${t(/grblhal/i.test(file.version) ? "fl.hal.after" : "fl.afterHint")}</div>`;
    log(t("fl.successLog", { file: file.name }));
  } catch (e) {
    const msg = String(e);
    stage = "";
    resultHtml = `<div class="fl-err">✕ ${esc(errorHelp(msg))}</div>`;
    log(`${t("fl.failedLog")} ${msg}`);
  }
  busy = false;
  riskOk = false;
  render();
}

function errorHelp(msg: string): string {
  if (msg === "no bootloader") return t("fl.err.noBoot");
  if (msg === "cancelled") return t("fl.err.cancelled");
  if (msg.startsWith("wrong chip")) return t("fl.err.wrongChip", { m: msg.replace("wrong chip: ", "") });
  if (msg.startsWith("baud")) return t("fl.err.baud");
  if (msg.includes("too large")) return t("fl.err.tooLarge", { m: msg });
  if (msg.startsWith("verify")) return t("fl.err.verify");
  if (msg.startsWith("elf:")) return t("fl.elfFailed", { e: msg });
  if (msg.startsWith("zip:")) return t("fl.zipFailed", { e: msg });
  if (/busy|denied|Permission|in use|Access/i.test(msg)) return t("fl.err.portBusy", { m: msg });
  return t("fl.err.other", { m: msg });
}

/** Gesicherte Einstellungen zurück aufs Board (verbindet bei Bedarf selbst) */
/** Firmware-Familie: grblHAL / FluidNC / GRBL (inkl. Grbl_ESP32, MKS) */
function fwFamily(fw: string): string {
  return /grblhal/i.test(fw) ? "hal" : /fluidnc/i.test(fw) ? "fluid" : "grbl";
}
/** $-Werte, die bei allen GRBL-Abkömmlingen dasselbe bedeuten (Achsen-Werte und Grundeinstellungen) */
const COMMON_KEYS = new Set<string>([0, 1, 2, 3, 11, 12, 13, 20, 23, 24, 25, 26, 27, 30, 31,
  100, 101, 102, 103, 110, 111, 112, 113, 120, 121, 122, 123, 130, 131, 132, 133].map(n => "$" + n));

async function restoreSettings() {
  const b = loadBackup();
  if (!b || busy) return;
  const port = (document.getElementById("fl-port") as HTMLSelectElement | null)?.value || machine.port;
  if (!window.confirm(t("fl.confirmRestore", { n: Object.keys(b.settings).length, date: new Date(b.date).toLocaleString() }))) return;
  busy = true; stage = t("fl.stage.restore"); pct = 0; render();
  try {
    if (!machine.connected) {
      await connect(port, 115200);
      // warten, bis sich das Board meldet
      const t0 = Date.now();
      while (!machine.firmware && Date.now() - t0 < 10000) await new Promise(r => setTimeout(r, 200));
    }
    await sendAndWait("$$", 8000, true);
    // Andere Firmware als beim Sichern (z. B. MKS -> grblHAL)? Dann bedeuten viele Nummern etwas anderes –
    // nur die Werte zurückspielen, die bei GRBL, grblHAL, Grbl_ESP32/MKS gleich sind
    const changedFw = fwFamily(b.firmware) !== fwFamily(`${machine.firmware} ${machine.version}`);
    if (changedFw) log(t("fl.restoreCommonOnly", { from: b.firmware || "?", to: `${machine.firmware} ${machine.version}`.trim() }));
    const keys = Object.keys(b.settings).filter(k => machine.settings.has(k) && machine.settings.get(k) !== b.settings[k]
      && (!changedFw || COMMON_KEYS.has(k)));
    let ok = 0, fail = 0;
    for (let i = 0; i < keys.length; i++) {
      const r = await sendAndWait(`${keys[i]}=${b.settings[keys[i]]}`, 4000, true);
      if (r.ok) ok++; else fail++;
      pct = Math.round(((i + 1) / keys.length) * 100);
      const bar = document.getElementById("fl-bar"); if (bar) bar.style.width = pct + "%";
    }
    await sendAndWait("$$", 8000, true);
    stage = t("fl.restored", { ok, fail, same: Object.keys(b.settings).length - keys.length });
    log(stage);
  } catch (e) {
    stage = "";
    log(`${t("log.error")} ${e}`);
  }
  busy = false;
  render();
}

export async function initFlashPage(logFn: (s: string) => void) {
  log = logFn;
  board = guessBoard();
  try {
    await listen("flash-progress", (e: any) => {
      const p = e.payload || {};
      const key = `fl.stage.${p.stage}`;
      stage = t(key) === key ? String(p.stage) : t(key);
      if (p.stage === "chip" && p.msg) stage += `: ${p.msg}`;
      if (p.stage === "write" && p.total) {
        pct = Math.round((p.done / p.total) * 100);
        stage += ` ${pct}%`;
      }
      const bar = document.getElementById("fl-bar");
      const st = document.getElementById("fl-stage");
      if (bar) bar.style.width = `${pct}%`;
      if (st) st.textContent = stage;
    });
  } catch { /* Browser-Test */ }
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "info" && !board) board = guessBoard();
    if ((type === "connected" || type === "disconnected" || type === "info") && !busy) render();
  });
  window.addEventListener("cnc-language-changed", render);
  // Ports erst holen, wenn der Reiter geöffnet wird
  document.querySelector('[data-tab="tab-flash"]')?.addEventListener("click", async () => { ports = await listPorts(); if (!busy) render(); });
  render();
}
