/**
 * FEHLER MELDEN (aus dem ⓘ-Fenster)
 *
 *   - Kurzer Titel, was passiert ist, Schritte, was erwartet war, Bereich + wie schlimm
 *   - Zum Abwählen: Version + System, Maschine/Board/Firmware, letzte 50 Konsolenzeilen
 *     (alles bereinigt – keine IPs, WLAN-Namen/-Passwörter, Benutzernamen in Pfaden; bugReport.ts)
 *   - „Auf GitHub öffnen“: Seite „Neues Issue“ im Browser, Felder vorausgefüllt – abschicken tut der Nutzer dort
 *   - „Kopieren“: alles als Markdown in die Zwischenablage (falls der Browser nicht aufgeht)
 */
import { t } from "../i18n/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { appInfo } from "../update/updater";
import { machine, lastBoardInfo } from "../machine";
import { getMachineMode } from "../machineMode";
import {
  AREAS, SEVERITIES, BugInfo, BugReport, consoleTail, issueUrl, reportMarkdown, machineText, osText, cleanText
} from "../bugReport";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Text der Konsole (rechts unten), so wie er dort steht */
function consoleLines(): string[] {
  return Array.from(document.querySelectorAll("#console-log p"), p => p.textContent || "");
}

function currentInfo(version: string, os: string, arch: string): BugInfo {
  const last = lastBoardInfo();
  const board = machine.info?.name || last?.name || "";
  const firmware = machine.firmware ? `${machine.firmware} ${machine.version}`.trim() : last?.firmware || "";
  const p = machine.port || "";
  const net = p.startsWith("tcp://") || /^\d+\.\d+\.\d+\.\d+/.test(p);
  return { version, os, arch, mode: getMachineMode(), board, firmware, connection: machine.connected ? (net ? "net" : "usb") : "" };
}

export async function openBugReportDialog(log: (s: string) => void) {
  document.getElementById("bug-dialog-overlay")?.remove();
  const me = await appInfo();
  const info = currentInfo(me.version, me.os, me.arch);
  const lines = consoleTail(consoleLines(), 50);
  const ov = document.createElement("div");
  ov.id = "bug-dialog-overlay";
  ov.className = "dlg-overlay";
  const opt = (list: string[], key: string) =>
    `<option value="">${esc(t("bug.choose"))}</option>` + list.map((v, i) => `<option value="${esc(v)}">${esc(t(`${key}.${i}`))}</option>`).join("");
  ov.innerHTML = `
    <div class="dlg-box bug-box" role="dialog">
      <h3>🐞 ${esc(t("bug.title"))}</h3>
      <div class="dlg-hint">${esc(t("bug.intro"))}</div>
      <label class="bug-field">${esc(t("bug.f.title"))}<input type="text" id="bug-title" maxlength="200" placeholder="${esc(t("bug.ph.title"))}"></label>
      <div class="bug-two">
        <label class="bug-field">${esc(t("bug.f.area"))}<select id="bug-area">${opt(AREAS, "bug.area")}</select></label>
        <label class="bug-field">${esc(t("bug.f.severity"))}<select id="bug-sev">${opt(SEVERITIES, "bug.sev")}</select></label>
      </div>
      <label class="bug-field">${esc(t("bug.f.what"))}<textarea id="bug-what" rows="3" placeholder="${esc(t("bug.ph.what"))}"></textarea></label>
      <label class="bug-field">${esc(t("bug.f.steps"))}<textarea id="bug-steps" rows="3" placeholder="${esc(t("bug.ph.steps"))}"></textarea></label>
      <label class="bug-field">${esc(t("bug.f.expected"))}<textarea id="bug-expected" rows="2"></textarea></label>
      <div class="bug-section">
        <div class="bug-sub">${esc(t("bug.attach"))}</div>
        <label class="about-check"><input type="checkbox" id="bug-sys" checked> ${esc(t("bug.sys"))} <span class="bug-val"></span></label>
        <label class="about-check"><input type="checkbox" id="bug-mach" checked> ${esc(t("bug.mach"))} <span class="bug-val"></span></label>
        <label class="about-check"><input type="checkbox" id="bug-con" ${lines.length ? "checked" : "disabled"}> ${esc(t("bug.console", { n: lines.length }))}</label>
        <details class="bug-prev"><summary>${esc(t("bug.preview"))}</summary><pre id="bug-pre" class="upd-notes"></pre></details>
        <div class="dlg-hint">🔒 ${esc(t("bug.privacy"))}</div>
      </div>
      <div class="dlg-hint">${esc(t("bug.github"))}</div>
      <div id="bug-status" class="about-status" style="display:none;"></div>
      <div class="dlg-buttons">
        <button id="bug-cancel" class="btn-secondary">${esc(t("dlg.cancel"))}</button>
        <button id="bug-copy" class="btn-secondary">📋 ${esc(t("bug.copy"))}</button>
        <button id="bug-open" class="btn-primary" style="flex:1;">🌐 ${esc(t("bug.open"))}</button>
      </div>
    </div>`;
  // Werte vom Board/System nur als Text einsetzen
  const vals = ov.querySelectorAll<HTMLElement>(".bug-val");
  vals[0].textContent = `(${cleanText(me.version)} · ${osText(me.os, me.arch)})`;
  const mt = machineText(info);
  vals[1].textContent = mt ? `(${mt})` : "";
  document.body.appendChild(ov);

  const $ = <T extends HTMLElement>(id: string) => ov.querySelector<T>("#" + id)!;
  const val = (id: string) => ($(id) as HTMLInputElement).value;
  const on = (id: string) => ($(id) as HTMLInputElement).checked;
  const status = $("bug-status");
  const say = (s: string) => { status.textContent = s; status.style.display = ""; };
  const report = (): BugReport => ({
    title: val("bug-title"), what: val("bug-what"), steps: val("bug-steps"), expected: val("bug-expected"),
    area: val("bug-area"), severity: val("bug-sev"),
    info: on("bug-sys") ? info : null, machine: on("bug-mach") && on("bug-sys"),
    consoleLines: on("bug-con") ? lines : []
  });
  const pre = $("bug-pre");
  const refresh = () => {
    ($("bug-mach") as HTMLInputElement).disabled = !on("bug-sys");
    pre.textContent = reportMarkdown(report());
  };
  ov.addEventListener("input", refresh);
  ov.addEventListener("change", refresh);
  refresh();

  const close = () => ov.remove();
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  $("bug-cancel").onclick = close;

  const copy = async () => {
    try { await navigator.clipboard.writeText(reportMarkdown(report())); return true; } catch { return false; }
  };
  $("bug-copy").onclick = async () => say(t(await copy() ? "bug.copied" : "bug.copyErr"));
  $("bug-open").onclick = async () => {
    const r = report();
    if (!r.title.trim() || !r.what.trim()) {
      (r.title.trim() ? $("bug-what") : $("bug-title")).classList.add("dlg-invalid");
      say(t("bug.need"));
      return;
    }
    const { url, full } = issueUrl(r);
    // passt nicht alles in die Adresse: kompletter Bericht liegt in der Zwischenablage
    if (!full && await copy()) say(t("bug.tooLong"));
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
    log(t("bug.log"));
    if (full) close();
  };
  ov.querySelectorAll("input, textarea").forEach(el => el.addEventListener("input", () => el.classList.remove("dlg-invalid")));
  $("bug-title").focus();
}
