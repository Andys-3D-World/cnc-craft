/**
 * Koordinatensystem G54–G59 im Reiter „Maschine“: Auswahl (zeigt, was die Steuerung wirklich meldet)
 * und „Nullpunkt hier“. Gesperrt während Job, Antasten, Werkzeugwechsel und Alarm. Nur GRBL-Familie.
 */
import { t, T, tip } from "../i18n/i18n";
import { machine, MACHINE_EVENT, send } from "../machine";
import { WCS_LIST, zeroCommand, type Wcs } from "../wcs";
import { initWcsSync, selectWcs, wcsLocked } from "../wcsSync";

export function wcsRowHtml(): string {
  return `
    <div class="m-wcs not-ruida not-k40 not-marlin" ${tip("wcs.tip")}>
      <label for="m-wcs-sel">${T("wcs.label")}</label>
      <select id="m-wcs-sel" disabled>
        <option value="">—</option>
        ${WCS_LIST.map(w => `<option value="${w}">${w}</option>`).join("")}
      </select>
      <button id="m-wcs-zero" class="btn-secondary" disabled ${tip("wcs.zeroTip")}>${T("wcs.zero")}</button>
    </div>`;
}

export function initWcsPanel(logFn: (s: string) => void) {
  initWcsSync(logFn);
  const sel = document.getElementById("m-wcs-sel") as HTMLSelectElement | null;
  const zero = document.getElementById("m-wcs-zero") as HTMLButtonElement | null;
  if (!sel || !zero) return;
  const update = () => {
    const locked = wcsLocked();
    sel.disabled = locked;
    zero.disabled = locked;
    if (document.activeElement !== sel || locked) sel.value = machine.connected ? machine.wcs : "";
  };
  sel.addEventListener("change", async () => {
    const w = sel.value as Wcs;
    if (w) await selectWcs(w);
    sel.value = machine.wcs;
    sel.blur();
  });
  zero.addEventListener("click", () => {
    if (wcsLocked()) return;
    send(zeroCommand("XYZ")).catch(e => logFn(`${t("log.error")} ${e}`));
  });
  window.addEventListener(MACHINE_EVENT, update);
  update();
}
