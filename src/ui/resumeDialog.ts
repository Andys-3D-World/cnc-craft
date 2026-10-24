/**
 * DIALOG „JOB FORTSETZEN“ (Reiter Maschine und Simulation)
 *
 * Startzeile wählen (Zahl, Form/Ebene aus der Liste oder „kurz vor dem Abbruch“), Vorspann ansehen, starten.
 * Die Simulation springt beim Ändern an die Stelle (Ereignis "cnc-sim-seek-line").
 * „Kurz vor dem Abbruch“: GRBL bestätigt Zeilen schon, wenn sie im Puffer liegen (bis ~15 Bewegungen) –
 * die bestätigte Zeile liegt also hinter der echten Stelle. Deshalb ein paar Zeilen früher anfangen
 * (Fräse: die Stelle wird dann nur in der Luft nachgefahren).
 */
import { t } from "../i18n/i18n";
import { streamState, startStreaming } from "../machineStream";
import { buildResume } from "../jobResume";
import { getMachineMode } from "../machineMode";
import { machine } from "../machine";

const BACK = 20; // so viele Zeilen vor der zuletzt bestätigten Zeile beginnen

export function openResumeDialog(log: (s: string) => void, startLine?: number) {
  const st = streamState;
  if (!st.totalLines) { log(t("stream.noGcode")); return; }
  if (st.isRunning) { log(t("stream.alreadyRunning")); return; }
  const near = st.abortLine > 0 ? Math.max(1, st.abortLine - BACK) : -1;
  let line = Math.min(st.totalLines - 1, Math.max(1, startLine ?? (near > 0 ? near : 1)));

  document.getElementById("res-dialog-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "res-dialog-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:540px;">
      <h3>⏭ ${t("res.title")}</h3>
      <div class="dlg-hint" id="res-job"></div>
      <label class="dlg-row"><span>${t("res.line")}</span>
        <span class="dlg-num"><input id="res-line" type="number" min="2" max="${st.totalLines}" step="1"><em>/ ${st.totalLines}</em></span></label>
      <label class="dlg-row" id="res-mark-row"><span>${t("res.mark")}</span>
        <select id="res-mark" style="max-width:300px;"><option value="">–</option></select></label>
      ${near > 0 ? `<button id="res-near" class="btn-secondary btn-compact" type="button">↶ ${t("res.near", { n: near + 1 })}</button>` : ""}
      <div class="dlg-hint" id="res-warn" style="color:#ffb454;"></div>
      <div class="dlg-hint">${t("res.preTitle")}</div>
      <pre id="res-pre" style="font-size:0.72rem;max-height:170px;overflow:auto;margin:0;padding:6px 8px;border-radius:6px;background:var(--bg-input,#191920);white-space:pre-wrap;"></pre>
      <div class="dlg-hint">${t("res.hint")}</div>
      <div class="dlg-buttons">
        <button id="res-cancel" class="btn-secondary">${t("dlg.cancel")}</button>
        <button id="res-ok" class="btn-primary">▶ ${t("res.go")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  // Name und Formen-Beschriftungen stammen aus Dateien -> nur als Text
  $<HTMLElement>("res-job").textContent = t("res.job", { name: st.label, n: st.totalLines })
    + (st.abortLine > 0 ? " " + t("res.abortedAt", { n: st.abortLine }) : "");
  const sel = $<HTMLSelectElement>("res-mark");
  st.marks.filter(m => m.line > 0).forEach(m => {
    const o = document.createElement("option");
    o.value = String(m.line);
    o.textContent = `${t("res.lineShort", { n: m.line + 1 })} · ${m.label}`;
    sel.appendChild(o);
  });
  if (sel.options.length <= 1) $<HTMLElement>("res-mark-row").style.display = "none";

  const update = () => {
    $("res-line").value = String(line + 1);
    sel.value = st.marks.some(m => m.line === line) ? String(line) : "";
    const pre = $<HTMLElement>("res-pre"), warn = $<HTMLElement>("res-warn"), ok = $<HTMLButtonElement>("res-ok");
    try {
      const p = buildResume(st.loadedLines, line, getMachineMode());
      pre.textContent = [...p.pre, `→ ${p.rest[0]}`, ...p.rest.slice(1, 3), "…"].join("\n");
      const w: string[] = [];
      if (p.toolNote) w.push(t("res.toolNote", { note: p.toolNote }));
      if (p.pos.x === null || p.pos.y === null) w.push(t("res.noPos"));
      warn.textContent = w.join(" ");
      ok.disabled = false;
    } catch (e) {
      pre.textContent = "";
      warn.textContent = (e as Error).message || String(e);
      ok.disabled = true;
    }
    window.dispatchEvent(new CustomEvent("cnc-sim-seek-line", { detail: { line } }));
  };
  const setLine = (n: number) => { line = Math.min(st.totalLines - 1, Math.max(1, Math.round(n))); update(); };
  $("res-line").addEventListener("change", () => setLine((parseFloat($("res-line").value) || 2) - 1));
  sel.addEventListener("change", () => { if (sel.value) setLine(parseInt(sel.value, 10)); });
  ov.querySelector("#res-near")?.addEventListener("click", () => setLine(near));
  update();

  const close = () => ov.remove();
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  $<HTMLElement>("res-cancel").onclick = close;
  $<HTMLElement>("res-ok").onclick = () => {
    if (!window.confirm(t("res.confirm", { n: line + 1 }))) return;
    close();
    startStreaming(() => machine.connected, log, line);
  };
}
