/**
 * MAKRO-KNÖPFE im Reiter „Maschine“ und der Fenster zum Bearbeiten.
 * Namen und G-Code kommen nur per textContent/value ins Fenster, nie als HTML.
 * Beim ersten Ausführen (und nach jeder Änderung des Inhalts) zeigt ein Fenster, was gesendet wird.
 */
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readTextFile } from "@tauri-apps/plugin-fs";
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT } from "../machine";
import { Macro, MACRO_MAX, MACRO_NAME_MAX, macroLines, macroProblem, macroBlock, sanitizeMacros, buildMacroFile, parseMacroFile } from "../macros";
import { macroRunning, runningMacroId, runMacro, cancelMacro } from "../macroRun";
import { toolChangeBusy } from "../toolChange";
import { probeRunning } from "../probe";
import { askChoice } from "./unsavedDialog";

const KEY = "cnc_craft_macros";
const newId = () => "mc" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let log: (s: string) => void = () => {};

function load(): Macro[] {
  try { return sanitizeMacros(JSON.parse(localStorage.getItem(KEY) || "[]"), false, newId); } catch { return []; }
}
function store(list: Macro[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* Speicher voll oder gesperrt */ }
}

export function macroPanelHtml(): string {
  return `
    <div class="menu-section-unified not-ruida not-k40" id="macro-section">
      <h3 class="menu-trigger">${T("macro.section")}</h3>
      <div class="menu-body rp-box">
        <div id="macro-buttons" class="m-btn-grid"></div>
        <div id="macro-empty" class="dlg-hint">${T("macro.empty")}</div>
        <button id="macro-edit" class="btn-secondary btn-compact" ${tip("macro.editTip")}>✎ ${T("macro.edit")}</button>
      </div>
    </div>`;
}

function blocked() {
  return macroBlock({
    connected: machine.connected, state: machine.status.state, jobActive: machine.job.active,
    busy: toolChangeBusy() || probeRunning()
  });
}

function render() {
  const box = document.getElementById("macro-buttons");
  const empty = document.getElementById("macro-empty");
  if (!box) return;
  const list = load();
  box.replaceChildren();
  list.forEach(m => box.appendChild(makeButton(m)));
  if (empty) empty.style.display = list.length ? "none" : "";
  update();
}

function makeButton(m: Macro): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn-secondary macro-btn";
  b.dataset.macro = m.id;
  b.textContent = m.name;
  b.title = macroLines(m.gcode).join("\n"); // zeigt immer, was der Knopf schickt
  b.addEventListener("click", () => { void click(m.id); });
  return b;
}

/** Sperren und Abbrechen-Anzeige, ohne die Knöpfe neu zu bauen */
function update() {
  const why = blocked();
  const run = runningMacroId();
  document.querySelectorAll<HTMLButtonElement>(".macro-btn").forEach(b => {
    const mine = b.dataset.macro === run;
    b.disabled = run ? !mine : why !== "";
    b.classList.toggle("m-attention", mine);
    const label = load().find(x => x.id === b.dataset.macro)?.name ?? "";
    b.textContent = mine ? `■ ${label}` : label;
  });
  const edit = document.getElementById("macro-edit") as HTMLButtonElement | null;
  if (edit) edit.disabled = macroRunning();
}

async function click(id: string) {
  if (runningMacroId() === id) { await cancelMacro(log); return; }
  if (macroRunning()) return;
  const why = blocked();
  if (why) { log(t("macro.block." + why)); return; }
  const list = load();
  const m = list.find(x => x.id === id);
  if (!m) return;
  const { problem, line } = macroProblem(m.gcode);
  if (problem) { log(t("macro.err." + problem, { line, name: m.name })); return; }
  if (!m.confirmed) {
    const lines = macroLines(m.gcode);
    const ok = await askChoice(t("macro.confirmTitle", { name: m.name }), `${t("macro.confirmText")}\n\n${lines.join("\n")}`, [
      { key: "cancel", label: t("dlg.cancel"), cancel: true },
      { key: "run", label: t("macro.confirmRun"), primary: true }
    ]);
    if (ok !== "run") return;
    // Während das Fenster offen war, kann sich alles geändert haben
    const again = blocked();
    if (again) { log(t("macro.block." + again)); return; }
    m.confirmed = true;
    store(list);
  }
  await runMacro(m, log, update);
}

// ---------------- Bearbeiten ----------------

function openEditor() {
  document.getElementById("macro-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "macro-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:520px;">
      <h3>${T("macro.edit")}</h3>
      <div class="dlg-hint">${T("macro.editHint")}</div>
      <div id="macro-rows" class="macro-rows"></div>
      <div id="macro-error" class="dlg-hint macro-error"></div>
      <div class="dlg-buttons">
        <button id="macro-add" class="btn-secondary">+ ${T("macro.add")}</button>
        <button id="macro-import" class="btn-secondary">${T("macro.import")}</button>
        <button id="macro-export" class="btn-secondary">${T("macro.export")}</button>
        <span style="flex:1"></span>
        <button id="macro-cancel" class="btn-secondary">${T("dlg.cancel")}</button>
        <button id="macro-save" class="btn-primary">${T("macro.save")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const rows = ov.querySelector<HTMLElement>("#macro-rows")!;
  const error = ov.querySelector<HTMLElement>("#macro-error")!;

  const addRow = (m: Macro) => {
    const row = document.createElement("div");
    row.className = "macro-row";
    row.dataset.id = m.id;
    const top = document.createElement("div");
    top.className = "macro-row-top";
    const name = document.createElement("input");
    name.type = "text"; name.className = "macro-name prop-input"; name.maxLength = MACRO_NAME_MAX; name.value = m.name;
    name.placeholder = t("macro.namePh");
    const up = document.createElement("button");
    up.type = "button"; up.className = "btn-secondary btn-compact"; up.textContent = "↑"; up.title = t("macro.up");
    up.addEventListener("click", () => { if (row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "btn-secondary btn-compact"; del.textContent = "✕"; del.title = t("macro.remove");
    del.addEventListener("click", () => row.remove());
    top.append(name, up, del);
    const code = document.createElement("textarea");
    code.className = "macro-code prop-input"; code.rows = 3; code.spellcheck = false; code.value = m.gcode;
    code.placeholder = "G53 G0 Z0\nG53 G0 X0 Y0";
    row.append(top, code);
    rows.appendChild(row);
    return name;
  };
  const before = load();
  before.forEach(addRow);

  const collect = (): Macro[] => [...rows.querySelectorAll<HTMLElement>(".macro-row")].map(r => {
    const id = r.dataset.id!;
    const gcode = r.querySelector<HTMLTextAreaElement>(".macro-code")!.value.replace(/\r\n/g, "\n");
    const old = before.find(x => x.id === id);
    // anderer Inhalt = beim nächsten Mal wieder zeigen und fragen
    return { id, name: r.querySelector<HTMLInputElement>(".macro-name")!.value.trim(), gcode, confirmed: !!old && old.confirmed && old.gcode === gcode };
  });
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);

  ov.querySelector("#macro-add")!.addEventListener("click", () => {
    if (rows.children.length >= MACRO_MAX) return;
    addRow({ id: newId(), name: "", gcode: "", confirmed: false }).focus();
  });
  ov.querySelector("#macro-cancel")!.addEventListener("click", close);
  ov.querySelector("#macro-save")!.addEventListener("click", () => {
    const list = collect();
    for (const m of list) {
      if (!m.name) { error.textContent = t("macro.err.noName"); return; }
      const { problem, line } = macroProblem(m.gcode);
      if (problem) { error.textContent = t("macro.err." + problem, { line, name: m.name }); return; }
    }
    store(list);
    close();
    render();
  });
  ov.querySelector("#macro-export")!.addEventListener("click", async () => {
    try {
      const path = await save({ defaultPath: "cnc-craft-macros.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await writeFile(path, new TextEncoder().encode(buildMacroFile(collect())));
      log(t("macro.exported", { n: rows.children.length }));
    } catch (e) { error.textContent = String(e); }
  });
  ov.querySelector("#macro-import")!.addEventListener("click", async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path || typeof path !== "string") return;
      const add = parseMacroFile(await readTextFile(path), newId);
      const room = MACRO_MAX - rows.children.length;
      add.slice(0, Math.max(0, room)).forEach(addRow);
      log(t("macro.imported", { n: Math.min(add.length, Math.max(0, room)) }));
    } catch (e) { error.textContent = (e as Error).message === "invalid" ? t("macro.err.file") : String(e); }
  });
}

export function initMacroPanel(logFn: (s: string) => void) {
  log = logFn;
  document.getElementById("macro-edit")?.addEventListener("click", openEditor);
  window.addEventListener(MACHINE_EVENT, update);
  render();
}
