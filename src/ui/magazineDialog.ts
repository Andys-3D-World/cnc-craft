/** WERKZEUGMAGAZIN – Fenster: welche Werkzeuge liegen wo, und (Reihe) wie gewechselt wird. Rechnung: magazine.ts */
import { t } from "../i18n/i18n";
import { machine, MACHINE_EVENT } from "../machine";
import { getTools, toolLabel } from "../toolLibrary";
import { insertRackZone } from "../rackView";
import { drawingZero } from "../drawingZero";
import { cleanMagazine, cleanOutput, forgetTests, MAX_SLOTS, rackBox, rackProblem, type Magazine } from "../magazine";
import { magazine, MAGAZINE_CHANGED, saveMagazine } from "../magazineStore";
import { atcBlocked, atcManual, onToolChange, toolChangeBusy, type AtcJob } from "../toolChange";
import { confirmSpindle, spindleKnown, spindleText } from "./magazineStart";
import { reportsInches } from "../units";
import { esc } from "../setupSheet";
import { isMill } from "../machineMode";

let listening = false;
let paintOpen: (() => void) | null = null;

export function openMagazine(log: (s: string) => void) {
  if (!isMill()) return;
  document.getElementById("mag-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "mag-overlay";
  ov.className = "dlg-overlay";
  document.body.appendChild(ov);
  const close = () => { paintOpen = null; ov.remove(); };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });

  const put = (next: Magazine) => { saveMagazine(forgetTests(magazine(), cleanMagazine(next))); };
  const row = (label: string, input: string, tipKey = "") => `<label class="dlg-row"${tipKey ? ` title="${esc(t(tipKey))}"` : ""}><span>${esc(label)}</span>${input}</label>`;
  const num = (key: string, v: number, unit: string, step = "1") => `<span class="dlg-num"><input type="number" step="${step}" data-g="${key}" value="${v}"${unit === "mm" || unit === "mm/min" ? "" : ' data-unit="none"'}><em>${unit}</em></span>`;
  const sel = (key: string, v: string, list: [string, string][]) => `<select data-g="${key}">${list.map(([k, l]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

  const paint = () => {
    const m = magazine(), rack = m.kind === "rack", tools = getTools();
    const act = document.activeElement as HTMLElement | null;
    if (act && ov.contains(act) && act.tagName === "INPUT" && ov.dataset.ready) return; // nicht unter dem Tippen wegziehen
    ov.dataset.ready = "1";
    const b = rack ? atcBlocked() : { why: "" as const, n: 0 }, p = rackProblem(m), busy = toolChangeBusy() || machine.job.active;
    const scroll = ov.querySelector(".dlg-box")?.scrollTop || 0;
    ov.innerHTML = `
    <div class="dlg-box mag-dlg" role="dialog" style="width:min(900px, calc(100vw - 32px));max-height:92vh;overflow:auto;">
      <h3>🔧 ${esc(t("mag.title"))}</h3>
      ${row(t("mag.kind"), sel("kind", m.kind, [["off", t("mag.kind.off")], ["hand", t("mag.kind.hand")], ["rack", t("mag.kind.rack")]]))}
      <div class="dlg-hint">${esc(t("mag.hint." + m.kind))}</div>
      ${rack ? `<div class="dlg-hint" style="color:var(--color-warning);">⚠ ${esc(t("mag.warn"))}</div>` : ""}
      ${m.kind === "off" ? "" : `
      <div style="overflow-x:auto;"><table class="mag-table"><thead><tr><th>${esc(t("mag.slot"))}</th><th>${esc(t("mag.tool"))}</th>${rack ? `<th>X</th><th>Y</th><th>Z</th><th></th><th>${esc(t("mag.tested"))}</th><th></th>` : ""}<th></th></tr></thead><tbody>
      ${m.slots.map(s => `<tr data-n="${s.n}">
        <td><b>${s.n}</b></td>
        <td><select data-s="toolId"><option value="">${esc(t("mag.empty"))}</option>${tools.map(x => `<option value="${esc(x.id)}"${x.id === s.toolId ? " selected" : ""}>${esc(toolLabel(x))}</option>`).join("")}</select></td>
        ${rack ? `${(["x", "y", "z"] as const).map(a => `<td><input type="number" step="0.01" data-unit="mm" data-s="${a}" value="${s.set ? s[a] : ""}"></td>`).join("")}
        <td><button type="button" class="btn-secondary btn-compact" data-a="here" title="${esc(t("mag.hereTip"))}">📍</button></td>
        <td title="${esc(t("mag.testedTip"))}">${s.okGet ? "✔" : "–"} / ${s.okPut ? "✔" : "–"}</td>
        <td style="white-space:nowrap;"><button type="button" class="btn-secondary btn-compact" data-a="look"${busy || !s.set ? " disabled" : ""} title="${esc(t("mag.lookTip"))}">${esc(t("mag.look"))}</button>
          <button type="button" class="btn-secondary btn-compact" data-a="get"${busy || !s.set ? " disabled" : ""}>${esc(t("mag.get"))}</button></td>` : ""}
        <td><button type="button" class="btn-secondary btn-compact" data-a="del" title="${esc(t("rem.delete"))}">🗑</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="dlg-buttons" style="justify-content:flex-start;"><button type="button" class="btn-secondary" id="mag-add"${m.slots.length >= MAX_SLOTS ? " disabled" : ""}>➕ ${esc(t("mag.add"))}</button></div>`}
      ${rack ? `
      <div class="mag-cols"><div>
        ${row(t("mag.inSpindle"), `<select id="mag-spindle"><option value="-1">${esc(t("mag.spUnknown"))}</option><option value="0">${esc(t("mag.spEmpty"))}</option>${m.slots.map(s => `<option value="${s.n}">${esc(spindleText(s.n))}</option>`).join("")}</select>`)}
        <button type="button" class="btn-secondary btn-compact" id="mag-put"${busy || m.inSpindle <= 0 ? " disabled" : ""}>${esc(t("mag.put"))}</button>
        ${row(t("mag.open"), `<input type="text" data-g="open" value="${esc(m.open)}" placeholder="M64 P0" style="width:110px;">`, "mag.outTip")}
        ${row(t("mag.close"), `<input type="text" data-g="close" value="${esc(m.close)}" placeholder="M65 P0" style="width:110px;">`, "mag.outTip")}
        ${row(t("mag.openS"), num("openS", m.openS, "s", "0.1"))}
        ${row(t("mag.spinS"), num("spinS", m.spinS, "s"), "mag.spinTip")}
        <label class="dlg-row" title="${esc(t("mag.alwaysTip"))}"><span>${esc(t("mag.always"))}</span><input type="checkbox" data-g="always"${m.always ? " checked" : ""} style="width:auto;"></label>
        <label class="dlg-row" title="${esc(t("mag.autoTip"))}"><span>${esc(t("mag.auto"))}</span><input type="checkbox" data-g="auto"${m.auto ? " checked" : ""} style="width:auto;"></label>
      </div><div>
        ${row(t("mag.entry"), sel("entry", m.entry, [["top", t("mag.entry.top")], ["fork", t("mag.entry.fork")]]))}
        ${m.entry === "fork" ? row(t("mag.dir"), sel("dir", m.dir, [["x+", "X+"], ["x-", "X−"], ["y+", "Y+"], ["y-", "Y−"]]), "mag.dirTip") + row(t("mag.slide"), num("slide", m.slide, "mm")) : ""}
        ${row(t("mag.zClear"), num("zClear", m.zClear, "mm", "0.5"), "mag.zClearTip")}
        ${row(t("mag.approach"), num("approach", m.approach, "mm"), "mag.approachTip")}
        ${row(t("mag.feedXY"), num("feedXY", m.feedXY, "mm/min", "100"))}
        ${row(t("mag.feedZ"), num("feedZ", m.feedZ, "mm/min", "50"))}
        ${row(t("mag.slow"), num("slow", m.slow, "mm/min", "10"))}
      </div></div>
      <div class="mag-cols"><div>${row(t("mag.size"), num("size", m.size, "mm"), "mag.sizeTip")}</div><div>${row(t("mag.top"), num("top", m.top, "mm"), "mag.topTip")}</div></div>
      <div class="dlg-buttons" style="justify-content:flex-start;"><button type="button" class="btn-secondary" id="mag-zone"${rackBox(m, { x: 0, y: 0 }) ? "" : " disabled"} title="${esc(t("mag.zoneTip"))}">${esc(t("mag.zone"))}</button></div>
      <div class="dlg-hint">${esc(t(drawingZero() ? "mag.shown" : "mag.notShown"))}</div>
      <div class="dlg-hint" id="mag-state" style="${p.why || b.why ? "color:var(--color-warning);" : "color:var(--color-success);"}">${p.why ? "⚠ " + esc(t("mag.why." + p.why, { n: p.n })) : b.why ? "⚠ " + esc(t("mag.why." + b.why, { n: b.n })) : "✔ " + esc(t("mag.ready"))}</div>
      <div class="dlg-hint">${esc(t("mag.order"))}</div>` : ""}
      <div class="dlg-buttons"><button type="button" class="btn-primary" id="mag-close" style="margin-left:auto;">${esc(t("dlg.close"))}</button></div>
    </div>`;
    ov.querySelector(".dlg-box")!.scrollTop = scroll;
    const spSel = ov.querySelector<HTMLSelectElement>("#mag-spindle");
    if (spSel) { spSel.value = String(m.inSpindle); spSel.disabled = busy; spSel.onchange = () => { saveMagazine({ ...magazine(), inSpindle: parseInt(spSel.value, 10) }); if (magazine().inSpindle >= 0) spindleKnown(); }; }
    ov.querySelector<HTMLElement>("#mag-close")!.onclick = close;
    ov.querySelector<HTMLElement>("#mag-add")?.addEventListener("click", () => {
      const cur = magazine(), n = cur.slots.length ? Math.max(...cur.slots.map(s => s.n)) + 1 : 1;
      put({ ...cur, slots: [...cur.slots, { n, toolId: "", x: 0, y: 0, z: 0, set: false, okGet: false, okPut: false }] });
    });
    ov.querySelector<HTMLElement>("#mag-zone")?.addEventListener("click", () => insertRackZone(log));
    ov.querySelector<HTMLElement>("#mag-put")?.addEventListener("click", () => void move("put", magazine().inSpindle));
    ov.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-g]").forEach(i => i.addEventListener("change", () => {
      if (toolChangeBusy()) { i.blur(); paint(); return; }
      const k = i.dataset.g!, cur: any = { ...magazine() };
      if (k === "open" || k === "close") { const c = cleanOutput(i.value); if (i.value.trim() && !c) log(t("mag.badOut")); cur[k] = c; }
      else if (k === "always" || k === "auto") cur[k] = (i as HTMLInputElement).checked;
      else if (i.tagName === "SELECT") cur[k] = i.value;
      else { const v = parseFloat(i.value); if (Number.isFinite(v)) cur[k] = v; }
      i.blur(); put(cur); paint();
    }));
    ov.querySelectorAll<HTMLElement>("tr[data-n]").forEach(tr => {
      const n = parseInt(tr.dataset.n!, 10);
      const change = (f: (s: any) => any) => { if (toolChangeBusy()) { paint(); return; } const cur = magazine(); put({ ...cur, slots: cur.slots.map(s => s.n === n ? f({ ...s }) : s) }); paint(); };
      tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-s]").forEach(i => i.addEventListener("change", () => {
        const k = i.dataset.s!;
        i.blur();
        if (k === "toolId") { change(s => ({ ...s, toolId: i.value })); return; }
        // eine Stelle gilt erst, wenn alle drei Zahlen da sind
        const val = (a: string) => parseFloat(tr.querySelector<HTMLInputElement>(`[data-s="${a}"]`)!.value);
        const x = val("x"), y = val("y"), z = val("z");
        if ([x, y, z].every(Number.isFinite)) change(s => ({ ...s, x, y, z, set: true }));
      }));
      tr.querySelector('[data-a="here"]')?.addEventListener("click", () => {
        const homed = ((parseFloat(machine.settings.get("$22") ?? "") | 0) & 1) === 1 && machine.homeState !== "lost" && machine.homeState !== "pending";
        const why = !machine.connected || machine.protocol !== "grbl" ? "grbl" : !homed ? "home" : reportsInches(machine.settings.get("$13")) ? "inch" : "";
        if (why) { log(t("mag.why." + why, { n })); return; }
        if (machine.status.state !== "Idle" || toolChangeBusy()) { log(t("m.jogNotIdle", { s: machine.status.state })); return; }
        const [x, y, z] = machine.status.mpos.map(v => +v.toFixed(3));
        change(s => ({ ...s, x, y, z, set: true }));
        log(t("mag.hereDone", { n, x, y, z }));
      });
      tr.querySelector('[data-a="look"]')?.addEventListener("click", () => void move("look", n));
      tr.querySelector('[data-a="get"]')?.addEventListener("click", () => void move("get", n));
      tr.querySelector('[data-a="del"]')?.addEventListener("click", () => { if (toolChangeBusy()) return; const cur = magazine(); put({ ...cur, slots: cur.slots.filter(s => s.n !== n) }); paint(); });
    });
  };
  const move = async (what: AtcJob, n: number) => {
    if (what !== "look") {
      const b = atcBlocked();
      if (b.why) { log(t("mag.why." + b.why, { n: b.n })); return; }
      if (!await confirmSpindle()) { paint(); return; }
    }
    close(); // oben muss „Stopp“ frei sein, solange sich etwas bewegt
    if (!await atcManual(what, n)) return;
    if (what !== "look") spindleKnown();
    openMagazine(log);
  };
  paintOpen = paint;
  if (!listening) {
    listening = true;
    window.addEventListener(MAGAZINE_CHANGED, () => paintOpen?.());
    window.addEventListener("cnc-language-changed", () => paintOpen?.());
    window.addEventListener(MACHINE_EVENT, (e: Event) => { const ty = (e as CustomEvent).detail?.type; if (ty && ty !== "status" && ty !== "text") paintOpen?.(); });
    onToolChange(() => paintOpen?.());
  }
  paint();
}
