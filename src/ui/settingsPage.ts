/**
 * $$-EINSTELLUNGEN – verständlich erklärt (Reiter "Einstellungen ($$)")
 *
 *  - alle GRBL-1.1-Einstellungen mit Name, Einheit und Erklärung in Klartext
 *  - Achsen als Tabelle (Schritte/mm, max. Geschwindigkeit, Beschleunigung, Verfahrweg)
 *  - Ja/Nein als Haken, Achsen-Masken ($3, $23 …) als X/Y/Z-Haken
 *  - geänderte Werte werden markiert und erst mit "Schreiben" an die Maschine geschickt
 *  - Sichern in eine Datei / Wiederherstellen aus einer Datei
 *  - Werkseinstellung: $RST=$ (Einstellungen), $RST=# (Nullpunkte), $RST=* (alles) – vorher automatisch sichern
 *  - Schritte/mm-Rechner: Soll-Strecke fahren, nachmessen, neuen Wert übernehmen
 *  - unbekannte Einstellungen (grblHAL, FluidNC …) werden trotzdem angezeigt und sind änderbar
 */
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readTextFile } from "@tauri-apps/plugin-fs";
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, sendAndWait, send, errorText, canCommand, fmtBuildDate } from "../machine";

type Kind = "int" | "float" | "bool" | "mask" | "enum" | "text";
interface Def { n: number; kind: Kind; unit?: string; group: string; opts?: number[] }

const DEFS: Def[] = [
  { n: 0, kind: "int", unit: "µs", group: "motor" },
  { n: 1, kind: "int", unit: "ms", group: "motor" },
  { n: 2, kind: "mask", group: "motor" },
  { n: 3, kind: "mask", group: "motor" },
  { n: 4, kind: "bool", group: "motor" },
  { n: 5, kind: "bool", group: "limits" },
  { n: 6, kind: "bool", group: "motor" },
  { n: 10, kind: "int", group: "general" },
  { n: 11, kind: "float", unit: "mm", group: "general" },
  { n: 12, kind: "float", unit: "mm", group: "general" },
  { n: 13, kind: "bool", group: "general" },
  { n: 20, kind: "bool", group: "limits" },
  { n: 21, kind: "bool", group: "limits" },
  { n: 22, kind: "bool", group: "limits" },
  { n: 23, kind: "mask", group: "limits" },
  { n: 24, kind: "float", unit: "mm/min", group: "limits" },
  { n: 25, kind: "float", unit: "mm/min", group: "limits" },
  { n: 26, kind: "int", unit: "ms", group: "limits" },
  { n: 27, kind: "float", unit: "mm", group: "limits" },
  { n: 30, kind: "float", unit: "S", group: "spindle" },
  { n: 31, kind: "float", unit: "S", group: "spindle" },
  { n: 32, kind: "bool", group: "spindle" },
  // ---- MKS-Boards (DLC32, DLC32 MAX) – nur sichtbar, wenn das Board sie meldet ----
  { n: 40, kind: "bool", group: "mks" },
  { n: 41, kind: "bool", group: "mks" },
  { n: 42, kind: "enum", group: "mks", opts: [0, 1, 2] },
  { n: 43, kind: "enum", group: "mks", opts: [0, 1, 2] },
  { n: 44, kind: "enum", group: "mks", opts: [0, 1, 2] },
  { n: 45, kind: "enum", group: "mks", opts: [0, 1, 2] },
  { n: 46, kind: "enum", group: "mks", opts: [1, 2] },
  { n: 47, kind: "bool", group: "mks" },
  { n: 48, kind: "enum", group: "mks", opts: [0, 1, 2] },
  { n: 50, kind: "enum", group: "mks", opts: [0, 1, 2, 3] },
  { n: 51, kind: "text", group: "mks" },
  { n: 52, kind: "text", group: "mks" },
  { n: 53, kind: "text", group: "mks" },
  { n: 54, kind: "text", group: "mks" },
  { n: 453, kind: "float", unit: "mm", group: "mks" },
  { n: 454, kind: "float", unit: "mm", group: "mks" },
  { n: 455, kind: "float", unit: "mm", group: "mks" },
  { n: 456, kind: "float", unit: "mm/min", group: "mks" },
  { n: 457, kind: "float", unit: "mm/min", group: "mks" }
];
const AXIS_BASE = [100, 110, 120, 130];          // Schritte/mm, Geschw., Beschl., Verfahrweg
const AXIS_UNITS = ["steps/mm", "mm/min", "mm/s²", "mm"];
const AXES = ["X", "Y", "Z", "A", "B", "C"];
const GROUPS = ["limits", "spindle", "motor", "general", "mks"];

/** GRBL-Optionen aus [OPT:…] (Buchstaben) */
const OPT_KEYS = "VNMCPZHTADS0R+*$#IEWL2";

const edits = new Map<string, string>();   // geänderte Werte (noch nicht geschrieben)
let log: (s: string) => void = () => {};
let busy = false;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

const known = new Set<string>([...DEFS.map(d => "$" + d.n), ...AXIS_BASE.flatMap(b => AXES.map((_, i) => "$" + (b + i)))]);

function cur(key: string): string {
  return edits.has(key) ? edits.get(key)! : (machine.settings.get(key) ?? "");
}

function axisCount(): number {
  let n = 3;
  for (let i = 3; i < AXES.length; i++) if (machine.settings.has("$" + (100 + i))) n = i + 1;
  return n;
}

// ---------------------------------------------------------------------
// Darstellung
// ---------------------------------------------------------------------

function inputFor(key: string, kind: Kind, def?: Def): string {
  const v = cur(key);
  const changed = edits.has(key) ? " sp-changed" : "";
  const has = machine.settings.has(key) || edits.has(key);
  if (!has) return `<span class="sp-na">–</span>`;
  if (kind === "bool") {
    return `<label class="sp-bool${changed}"><input type="checkbox" data-key="${key}" data-kind="bool" ${v.trim() === "1" ? "checked" : ""}> ${t(v.trim() === "1" ? "sp.on" : "sp.off")}</label>`;
  }
  if (kind === "mask") {
    const m = parseInt(v, 10) || 0;
    return `<span class="sp-mask${changed}">${AXES.slice(0, Math.max(3, axisCount())).map((a, i) =>
      `<label><input type="checkbox" data-key="${key}" data-kind="mask" data-bit="${i}" ${m & (1 << i) ? "checked" : ""}>${a}</label>`).join("")}</span>`;
  }
  if (kind === "enum" && def?.opts) {
    const n = parseInt(v, 10);
    return `<select class="sp-input sp-select${changed}" data-key="${key}" data-kind="enum">
      ${def.opts.map(o => `<option value="${o}" ${o === n ? "selected" : ""}>${o} – ${esc(t(`set.${def.n}.o${o}`))}</option>`).join("")}
      ${def.opts.includes(n) ? "" : `<option value="${esc(v)}" selected>${esc(v)}</option>`}
    </select>`;
  }
  if (kind === "text") {
    return `<input type="text" class="sp-input sp-text${changed}" data-key="${key}" data-kind="text" value="${esc(v)}" spellcheck="false">`;
  }
  return `<input type="text" inputmode="decimal" class="sp-input${changed}" data-key="${key}" data-kind="${kind}" value="${esc(v)}">`;
}

function render() {
  const root = document.getElementById("settings-page");
  if (!root) return;
  if (machine.protocol === "k40" && machine.connected) {
    root.innerHTML = `
      <section class="sp-card sp-ruida">
        <h3>🔥 ${T("sp.k40.title")}</h3>
        <div>${t("sp.k40.text", { board: machine.version || "M2" })}</div>
        <ul><li>${t("sp.k40.li1")}</li><li>${t("sp.k40.li2")}</li><li>${t("sp.k40.li3")}</li></ul>
      </section>`;
    return;
  }
  if (machine.protocol === "marlin" && machine.connected) {
    // Marlin hat keine $$-Werte – Einstellungen per M503 (anzeigen), M92/M203 … (ändern), M500 (speichern)
    root.innerHTML = `
      <section class="sp-card sp-ruida">
        <h3>🖨️ ${T("sp.marlin.title")}</h3>
        <div>${t("sp.marlin.text", { v: machine.version || "?" })}</div>
        <ul><li>${t("sp.marlin.li1")}</li><li>${t("sp.marlin.li2")}</li><li>${t("sp.marlin.li3")}</li></ul>
        <button id="sp-m503" class="btn-secondary" style="margin-top:8px;">📋 ${T("sp.marlin.show")}</button>
      </section>`;
    document.getElementById("sp-m503")?.addEventListener("click", () => { send("M503").catch(e => log(`${t("log.error")} ${e}`)); });
    return;
  }
  if (machine.protocol === "ruida" && machine.connected) {
    // Ruida hat keine $$-Werte – Einstellungen macht man am Display bzw. in RDWorks („Vendor settings“)
    root.innerHTML = `
      <section class="sp-card sp-ruida">
        <h3>🔥 ${T("sp.ruida.title")}</h3>
        <div>${t("sp.ruida.text", { card: machine.version || "?" })}</div>
        <ul><li>${t("sp.ruida.li1")}</li><li>${t("sp.ruida.li2")}</li><li>${t("sp.ruida.li3")}</li></ul>
      </section>`;
    return;
  }
  const connected = machine.connected;
  const haveData = machine.settings.size > 0;
  const fluid = machine.firmware === "FluidNC";
  const axes = axisCount();

  const axisTable = `
    <table class="sp-axes">
      <thead><tr><th></th>${AXIS_BASE.map((b, i) => `<th ${tip("sp.axis." + b)}>${T("sp.axis." + b)}<small>${AXIS_UNITS[i]}</small></th>`).join("")}</tr></thead>
      <tbody>${AXES.slice(0, axes).map((a, ai) => `<tr><th>${a}</th>${AXIS_BASE.map(b => `<td>${inputFor("$" + (b + ai), "float")}<small class="sp-key">$${b + ai}</small></td>`).join("")}</tr>`).join("")}</tbody>
    </table>
    <div class="sp-axis-help">${AXIS_BASE.map(b => `<p><b>${t("sp.axis." + b)}</b> ($${b}…): ${t("sp.axisHelp." + b)}</p>`).join("")}</div>`;

  const groupHtml = (g: string) => (g === "mks" && !DEFS.some(d => d.group === "mks" && machine.settings.has("$" + d.n))) ? "" : `
    <section class="sp-card">
      <h3>${T("sp.group." + g)}</h3>
      ${DEFS.filter(d => d.group === g).map(d => {
        const key = "$" + d.n;
        return `<div class="sp-row${edits.has(key) ? " sp-row-changed" : ""}">
          <div class="sp-key">${key}</div>
          <div class="sp-main">
            <div class="sp-name">${t(`set.${d.n}.n`)}</div>
            <div class="sp-desc">${t(`set.${d.n}.d`)}</div>
          </div>
          <div class="sp-val">${inputFor(key, d.kind, d)}${d.unit ? `<span class="sp-unit">${d.unit}</span>` : ""}</div>
        </div>`;
      }).join("")}
    </section>`;

  const others = [...machine.settings.keys()].filter(k => !known.has(k)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const otherHtml = others.length ? `
    <section class="sp-card">
      <h3>${T("sp.group.other")} <small>(${others.length})</small></h3>
      <p class="sp-desc">${t("sp.otherDesc", { fw: machine.firmware || "?" })}</p>
      <div class="sp-other">${others.map(k => `<label class="sp-other-item${edits.has(k) ? " sp-row-changed" : ""}"><span class="sp-key">${k}</span>${inputFor(k, Number.isFinite(parseFloat(machine.settings.get(k) || "")) ? "float" : "text")}</label>`).join("")}</div>
    </section>` : "";

  const ax = ["X", "Y", "Z"].slice(0, Math.max(3, axes));
  root.innerHTML = `
    <div class="sp-head">
      <div>
        <h2>⚙️ ${T("sp.title")}</h2>
        <p class="panel-desc">${T("sp.desc")}</p>
      </div>
      <div class="sp-actions">
        <button id="sp-read" class="btn-secondary" ${tip("sp.readTip")} ${connected && !busy ? "" : "disabled"}>⟳ ${busy ? t("sp.reading") : T("sp.read")}</button>
        <button id="sp-write" class="btn-primary" ${tip("sp.writeTip")} ${connected && edits.size && !busy ? "" : "disabled"}>💾 ${t("sp.write", { n: edits.size })}</button>
        <button id="sp-discard" class="btn-secondary" ${edits.size && !busy ? "" : "disabled"}>✕ ${T("sp.discard")}</button>
        <button id="sp-backup" class="btn-secondary" ${tip("sp.backupTip")} ${haveData ? "" : "disabled"}>⬇ ${T("sp.backup")}</button>
        <button id="sp-restore" class="btn-secondary" ${tip("sp.restoreTip")} ${haveData ? "" : "disabled"}>⬆ ${T("sp.restore")}</button>
        <button id="sp-factory" class="btn-secondary sp-factory" ${tip("sp.rst.tip")} ${connected && !busy ? "" : "disabled"}>🏭 ${T("sp.rst.btn")}</button>
      </div>
    </div>
    <div class="sp-status">${connected
      ? (haveData ? t("sp.statusData", { fw: `${machine.firmware} ${machine.version}`.trim() || "GRBL", n: machine.settings.size }) : t("sp.statusNoData"))
      : t("sp.statusOffline")}</div>
    ${boardInfoHtml()}
    ${fluid ? `<div class="sp-warn">${t("sp.fluidnc")}</div>` : ""}
    ${!haveData ? `<div class="sp-empty">${t(connected ? "sp.emptyConnected" : "sp.emptyOffline")}</div>` : `
    <section class="sp-card">
      <h3>${T("sp.group.axes")}</h3>
      ${axisTable}
    </section>
    <section class="sp-card">
      <h3>📏 ${T("sp.calc.title")}</h3>
      <p class="sp-desc">${t("sp.calc.desc")}</p>
      <div class="sp-calc">
        <label>${T("sp.calc.axis")}<select id="sp-calc-axis">${ax.map(a => `<option>${a}</option>`).join("")}</select></label>
        <label>${T("sp.calc.target")}<input id="sp-calc-target" type="number" value="100" step="1"> mm</label>
        <button id="sp-calc-move" class="btn-secondary" ${tip("sp.calc.moveTip")} ${connected ? "" : "disabled"}>➜ ${T("sp.calc.move")}</button>
        <label>${T("sp.calc.measured")}<input id="sp-calc-measured" type="number" step="0.01" placeholder="mm"> mm</label>
        <span id="sp-calc-result" class="sp-calc-result"></span>
        <button id="sp-calc-apply" class="btn-primary" disabled>✔ ${T("sp.calc.apply")}</button>
      </div>
    </section>
    ${GROUPS.map(groupHtml).join("")}
    ${otherHtml}`}`;
  bind();
}

/** Karte "Board-Info": Name, Firmware-Version, Datum, GRBL-Optionen, Puffer, ESP-Firmware */
function boardInfoHtml(): string {
  const bi = machine.info;
  if (!machine.connected || (!bi.version && !bi.name && !bi.raw.length)) return "";
  const opts = [...(bi.options || "")].filter(c => OPT_KEYS.includes(c)).map(c => {
    const k = `sp.opt.${c === "$" ? "dollar" : c === "#" ? "hash" : c === "*" ? "star" : c === "+" ? "plus" : c}`;
    return t(k) === k ? c : t(k);
  });
  const row = (label: string, value: string) => value ? `<div><span>${label}</span><b>${esc(value)}</b></div>` : "";
  return `
    <section class="sp-card sp-board">
      <h3>🧩 ${T("sp.board.title")}</h3>
      <div class="fl-info">
        ${row(t("sp.board.name"), bi.name)}
        ${row(t("sp.board.version"), bi.version)}
        ${row(t("sp.board.date"), bi.date ? fmtBuildDate(bi.date) : "")}
        ${row(t("sp.board.firmware"), `${machine.firmware} ${machine.version}`.trim())}
        ${row(t("sp.board.buffer"), bi.rx ? `${bi.rx} ${t("sp.board.chars")}` : "")}
        ${row(t("sp.board.esp"), bi.fw)}
        ${opts.length ? `<div class="fl-wide"><span>${t("sp.board.options")}</span><b>${esc(opts.join(" · "))}</b></div>` : ""}
      </div>
      ${bi.raw.length ? `<details class="fl-help"><summary>${t("sp.board.raw")}</summary><div class="sp-raw">${bi.raw.map(esc).join("\n")}</div></details>` : ""}
    </section>`;
}

// ---------------------------------------------------------------------
// Bedienung
// ---------------------------------------------------------------------

function setEdit(key: string, value: string) {
  const orig = machine.settings.get(key);
  if (orig !== undefined && normalize(orig) === normalize(value)) edits.delete(key);
  else edits.set(key, value);
}
function normalize(v: string) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? String(n) : v.trim();
}

function bind() {
  const root = document.getElementById("settings-page");
  if (!root) return;
  root.querySelectorAll<HTMLInputElement>("input[data-key], select[data-key]").forEach(inp => {
    inp.addEventListener("change", () => {
      const key = inp.dataset.key!;
      const kind = inp.dataset.kind as Kind;
      if (kind === "bool") setEdit(key, inp.checked ? "1" : "0");
      else if (kind === "enum") setEdit(key, inp.value);
      else if (kind === "text") {
        const v = inp.value.trim();
        if (!v) { inp.value = cur(key); return; }
        setEdit(key, v);
      }
      else if (kind === "mask") {
        let m = parseInt(cur(key), 10) || 0;
        const bit = 1 << parseInt(inp.dataset.bit!, 10);
        m = inp.checked ? (m | bit) : (m & ~bit);
        setEdit(key, String(m));
      } else {
        const v = inp.value.trim().replace(",", ".");
        if (v === "" || !Number.isFinite(parseFloat(v))) { inp.value = cur(key); return; }
        setEdit(key, v);
      }
      render();
    });
  });

  document.getElementById("sp-read")?.addEventListener("click", readAll);
  document.getElementById("sp-write")?.addEventListener("click", writeAll);
  document.getElementById("sp-discard")?.addEventListener("click", () => { edits.clear(); render(); });
  document.getElementById("sp-backup")?.addEventListener("click", backup);
  document.getElementById("sp-restore")?.addEventListener("click", restore);
  document.getElementById("sp-factory")?.addEventListener("click", openFactoryReset);

  // ---- Schritte/mm-Rechner ----
  const axisSel = document.getElementById("sp-calc-axis") as HTMLSelectElement | null;
  const target = document.getElementById("sp-calc-target") as HTMLInputElement | null;
  const measured = document.getElementById("sp-calc-measured") as HTMLInputElement | null;
  const result = document.getElementById("sp-calc-result");
  const apply = document.getElementById("sp-calc-apply") as HTMLButtonElement | null;
  let newVal = 0;
  const calc = () => {
    if (!axisSel || !target || !measured || !result || !apply) return;
    const key = "$" + (100 + ["X", "Y", "Z", "A", "B", "C"].indexOf(axisSel.value));
    const old = parseFloat(cur(key));
    const soll = parseFloat(target.value), ist = parseFloat(measured.value);
    if (old > 0 && soll > 0 && ist > 0) {
      newVal = Math.round((old * soll / ist) * 1000) / 1000;
      result.textContent = t("sp.calc.result", { key, old: old.toFixed(3), v: newVal.toFixed(3) });
      apply.disabled = false;
    } else {
      result.textContent = "";
      apply.disabled = true;
    }
  };
  [axisSel, target, measured].forEach(el => el?.addEventListener("input", calc));
  apply?.addEventListener("click", () => {
    if (!axisSel || !(newVal > 0)) return;
    const key = "$" + (100 + ["X", "Y", "Z", "A", "B", "C"].indexOf(axisSel.value));
    setEdit(key, String(newVal));
    render();
    log(t("sp.calc.applied", { key, v: newVal }));
  });
  document.getElementById("sp-calc-move")?.addEventListener("click", async () => {
    if (!axisSel || !target) return;
    if (!canCommand()) { log(t("conn.connectFirst")); return; }
    const d = parseFloat(target.value);
    if (!(d > 0)) return;
    if (!window.confirm(t("sp.calc.confirmMove", { a: axisSel.value, d }))) return;
    try { await send(`$J=G21 G91 ${axisSel.value}${d} F500`); } catch (e) { log(`${t("log.error")} ${e}`); }
  });
}

async function readAll() {
  if (!machine.connected) return;
  busy = true; render();
  const res = await sendAndWait("$$", 8000);
  busy = false;
  if (res.ok || machine.settings.size > 0) log(t("sp.readOk", { n: machine.settings.size }));
  else log(t("sp.readFailed"));
  render();
}

async function writeAll() {
  if (!edits.size || !machine.connected) return;
  if (!canCommand()) { log(t("m.why.job running")); return; }
  if (!window.confirm(t("sp.confirmWrite", { n: edits.size }))) return;
  busy = true; render();
  const keys = [...edits.keys()].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const unsure: Array<{ key: string; v: string }> = [];
  let ok = 0, failed = 0;
  for (const key of keys) {
    const v = edits.get(key)!;
    const r = await sendAndWait(`${key}=${v}`, 4000);
    if (r.ok) { ok++; edits.delete(key); }
    else if (r.code !== undefined && r.code > 0) { failed++; log(t("sp.writeFailed", { key, v, text: errorText(r.code) })); }
    else unsure.push({ key, v }); // keine Antwort – nach dem Zurücklesen prüfen
  }
  busy = false;
  // Zurücklesen: was wirklich auf der Maschine steht, zählt
  await readAll();
  for (const u of unsure) {
    const now = machine.settings.get(u.key);
    if (now !== undefined && normalize(now) === normalize(u.v)) { ok++; edits.delete(u.key); }
    else { failed++; log(t("sp.writeFailed", { key: u.key, v: u.v, text: t("sp.noAnswer") })); }
  }
  log(t("sp.written", { ok, failed }));
  render();
}

async function backup(): Promise<boolean> {
  try {
    const p = await save({ title: t("sp.backup"), defaultPath: `grbl-settings-${(machine.firmware || "grbl").toLowerCase()}.txt`, filters: [{ name: "Text", extensions: ["txt", "nc"] }] });
    if (!p) return false;
    const keys = [...machine.settings.keys()].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
    const text = `; CNC Craft – ${machine.firmware} ${machine.version} – ${new Date().toISOString()}\n` + keys.map(k => `${k}=${machine.settings.get(k)}`).join("\n") + "\n";
    await writeFile(String(p), new TextEncoder().encode(text));
    log(t("sp.backupSaved", { p: String(p) }));
    return true;
  } catch (e) { log(`${t("log.error")} ${e}`); return false; }
}

// ---------------------------------------------------------------------
// Werkseinstellung (GRBL 1.1, grblHAL, Grbl_ESP32 / MKS, FluidNC)
//   $RST=$  alle $-Einstellungen auf die Werte der Firmware
//   $RST=#  Nullpunkte G54–G59, G28/G30, G92 und Werkzeuglänge löschen
//   $RST=*  beides (bei ESP32-Boards zusätzlich die WLAN-Zugangsdaten)
// ---------------------------------------------------------------------

type RstKind = "$" | "#" | "*";

function isEsp32Board(): boolean {
  const s = `${machine.firmware} ${machine.version} ${machine.info.name || ""} ${machine.info.fw || ""}`;
  return /FluidNC|ESP32|MKS|DLC32/i.test(s) || machine.port.startsWith("tcp://");
}

function openFactoryReset() {
  if (!machine.connected) return;
  if (!canCommand() || machine.job.active) { log(t("m.why.job running")); return; }
  document.getElementById("sp-rst-overlay")?.remove();
  const esp = isEsp32Board();
  const viaWifi = machine.port.startsWith("tcp://");
  const haveData = machine.settings.size > 0;
  const fluid = machine.firmware === "FluidNC";
  const ov = document.createElement("div");
  ov.id = "sp-rst-overlay";
  ov.className = "dlg-overlay";
  const opt = (k: RstKind, checked: boolean) => `
    <label class="sp-rst-opt">
      <input type="radio" name="sp-rst" value="${k}" ${checked ? "checked" : ""}>
      <span><b>${esc(t("sp.rst.o" + (k === "$" ? "1" : k === "#" ? "2" : "3")))}</b> <code>$RST=${k}</code><br>
      <small>${esc(t("sp.rst.d" + (k === "$" ? "1" : k === "#" ? "2" : "3")))}${k === "*" && esp ? " " + esc(t("sp.rst.wifi")) : ""}</small></span>
    </label>`;
  ov.innerHTML = `
    <div class="dlg-box sp-rst-box" role="dialog">
      <h3>🏭 ${esc(t("sp.rst.title"))}</h3>
      <div class="dlg-hint">${esc(t("sp.rst.intro"))}</div>
      ${opt("$", true)}${opt("#", false)}${opt("*", false)}
      ${fluid ? `<div class="sp-rst-warn">${esc(t("sp.rst.fluid"))}</div>` : ""}
      <div class="sp-rst-warn" id="sp-rst-wifiwarn" style="display:none;">${esc(t("sp.rst.viaWifi"))}</div>
      <label class="sp-rst-opt"><input type="checkbox" id="sp-rst-backup" ${haveData ? "checked" : "disabled"}>
        <span>${esc(t("sp.rst.backup"))}</span></label>
      <div class="dlg-hint">${esc(t("sp.rst.after"))}</div>
      <div class="dlg-buttons">
        <button type="button" id="sp-rst-cancel" class="btn-secondary" style="flex:1;">${esc(t("sp.rst.cancel"))}</button>
        <button type="button" id="sp-rst-go" class="btn-primary sp-rst-go" style="flex:1;">🏭 ${esc(t("sp.rst.go"))}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  (ov.querySelector("#sp-rst-cancel") as HTMLButtonElement).onclick = close;
  const kind = () => ((ov.querySelector('input[name="sp-rst"]:checked') as HTMLInputElement)?.value || "$") as RstKind;
  const upd = () => { (ov.querySelector("#sp-rst-wifiwarn") as HTMLElement).style.display = kind() === "*" && esp && viaWifi ? "" : "none"; };
  ov.querySelectorAll('input[name="sp-rst"]').forEach(r => r.addEventListener("change", upd));
  (ov.querySelector("#sp-rst-go") as HTMLButtonElement).onclick = async () => {
    const k = kind();
    if (!window.confirm(t("sp.rst.confirm", { what: t("sp.rst.o" + (k === "$" ? "1" : k === "#" ? "2" : "3")) }))) return;
    const wantBackup = (ov.querySelector("#sp-rst-backup") as HTMLInputElement).checked;
    if (wantBackup && k !== "#") {
      // ohne gespeicherte Sicherung kein Zurücksetzen (Abbrechen im Speichern-Dialog = abbrechen)
      if (!(await backup())) { log(t("sp.rst.noBackup")); return; }
    }
    close();
    await factoryReset(k);
  };
}

async function factoryReset(k: RstKind) {
  if (!machine.connected) return;
  busy = true; render();
  log(t("sp.rst.running", { cmd: `$RST=${k}` }));
  const r = await sendAndWait(`$RST=${k}`, 8000);
  busy = false;
  if (!r.ok && r.code !== undefined && r.code > 0) {
    log(t("sp.rst.failed", { text: errorText(r.code) }));
    render();
    return;
  }
  edits.clear();
  log(t(k === "#" ? "sp.rst.doneOffsets" : "sp.rst.done"));
  if (k !== "#") {
    machine.settings.clear();
    await new Promise(res => setTimeout(res, 600));
    if (machine.connected) await readAll();
  }
  render();
}

async function restore() {
  try {
    const p = await open({ multiple: false, directory: false, title: t("sp.restore"), filters: [{ name: "Text", extensions: ["txt", "nc", "gcode"] }] });
    if (!p) return;
    const path = typeof p === "object" && p !== null ? (p as any).path : p;
    const text = await readTextFile(String(path));
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(\$\d+)\s*=\s*([-\d.]+)/);
      if (!m) continue;
      if (!machine.settings.has(m[1])) continue;
      setEdit(m[1], m[2]);
      n++;
    }
    log(t("sp.restoreLoaded", { n, changed: edits.size }));
    render();
  } catch (e) { log(`${t("log.error")} ${e}`); }
}

export function initSettingsPage(logFn: (s: string) => void) {
  log = logFn;
  let pending = 0;
  let autoReadAt = 0; // Board meldet sich evtl. zweimal (Status + Startmeldung) -> nur einmal lesen
  window.addEventListener(MACHINE_EVENT, (e: Event) => {
    const { type } = (e as CustomEvent).detail || {};
    if (type === "setting") {
      // viele Zeilen hintereinander -> nur einmal neu zeichnen
      clearTimeout(pending);
      pending = window.setTimeout(render, 120);
    } else if (type === "welcome") {
      // Beim Verbinden gleich lesen (kurz warten, bis $I durch ist)
      if (machine.protocol === "grbl" && Date.now() - autoReadAt > 5000) {
        autoReadAt = Date.now();
        setTimeout(() => { if (machine.connected && !machine.job.active && !busy) readAll(); }, 700);
      }
      render();
    } else if (type === "info") {
      clearTimeout(pending);
      pending = window.setTimeout(render, 150);
    } else if (type === "connected" || type === "disconnected") {
      if (type === "disconnected") edits.clear();
      render();
    }
  });
  window.addEventListener("cnc-language-changed", render);
  render();
}
