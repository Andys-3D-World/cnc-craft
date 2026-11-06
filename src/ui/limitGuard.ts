/**
 * MASCHINENGRENZEN: Prüfung beim Start (nur GRBL-Familie, Rechnung in softLimits.ts)
 *
 * Über der Grenze: Start gesperrt, rote Meldung mit Achsen und Betrag. „Trotzdem starten“ gibt es nur bewusst im Fenster,
 * weil die Einstellungen der Steuerung falsch sein können oder eine Firmware ihren Bereich anders legt.
 * Nicht prüfbar (nicht referenziert, $13x fehlt, G92 im Job …): deutliche Warnung, der Start bleibt erlaubt.
 */
import { t } from "../i18n/i18n";
import { machine, sendAndWait } from "../machine";
import { rotary } from "../rotary";
import { isPlasma } from "../machineMode";
import { checkLimits, scanJobExtents, LimitOver } from "../softLimits";
import { askChoice } from "./unsavedDialog";

let asking = false;

const fmt = (v: number) => v.toFixed(2);

function overText(o: LimitOver): string {
  if (o.kind === "span") return t("lim.span", { axis: o.axis, by: fmt(o.by) });
  return t("lim.over", { axis: o.axis, by: fmt(o.by), dir: o.kind === "+" ? "+" : "−" });
}

/** Für das Einrichteblatt: nur die sicheren Überschreitungen als Text (keine Maschine: nichts) */
export function limitReport(lines: string[]): string[] {
  if (!machine.connected || machine.protocol !== "grbl") return [];
  const { res } = evaluate(lines);
  return res.over.length ? [t("sheet.limitOver", { list: res.over.map(overText).join(", ") })] : [];
}

function evaluate(lines: string[]) {
  const num = (k: string) => parseFloat(machine.settings.get(k) ?? "");
  const { mpos, wpos } = machine.status;
  const wco = [mpos[0] - wpos[0], mpos[1] - wpos[1], mpos[2] - wpos[2]];
  const ext = scanJobExtents(lines, { wpos, wco, activeWcs: machine.wcs });
  // Referenziert? $22 aus: Zählerstand ohne Bezug. Nach Alarm/$X auch nicht. Sonst ($22 an, kein Alarm seit Verbinden): ja.
  const homed = ((num("$22") | 0) & 1) === 1 && machine.homeState !== "lost";
  const skip = rotary.on && rotary.axis !== "a" && !isPlasma() ? [rotary.along === "y" ? 0 : 1] : [];
  const res = checkLimits(ext, {
    travel: [num("$130"), num("$131"), num("$132")],
    homeDirMask: num("$23") | 0,
    pulloff: num("$27"),
    homed, mpos, wpos, skip
  });
  return { ext, res };
}

export async function limitsAllowStart(lines: string[], log: (s: string) => void): Promise<boolean> {
  if (machine.protocol !== "grbl") return true;
  if (asking) return false;
  if (!machine.settings.has("$130") && machine.status.state === "Idle") {
    try { await sendAndWait("$$", 5000, true); } catch { /* unten: Warnung „Einstellungen fehlen“ */ }
  }
  const { ext, res } = evaluate(lines);

  if (res.notHomed) log(`⚠ ${t("lim.notHomed")}`);
  if (res.noSettings.length) log(`⚠ ${t("lim.noSettings", { axes: res.noSettings.join(", ") })}`);
  if (res.unknownAxes.length) log(`⚠ ${t("lim.unknownPos", { axes: res.unknownAxes.join(", ") })}`);
  for (const n of ext.notes) log(`⚠ ${t("lim.note." + n)}`);
  if (res.zLaterOver.length) log(`⚠ ${t("lim.zLater", { list: res.zLaterOver.map(overText).join(", ") })}`);
  if (!res.over.length) return true;

  const list = res.over.map(overText);
  log(`⛔ ${t("lim.blocked", { list: list.join(", ") })}`);
  asking = true;
  try {
    const choice = await askChoice(t("lim.title"), `${list.join("\n")}\n\n${t("lim.hint")}`, [
      { key: "force", label: t("lim.force") },
      { key: "cancel", label: t("lim.cancel"), primary: true, cancel: true }
    ], true);
    if (choice !== "force") return false;
    log(`⚠ ${t("lim.forced")}`);
    return true;
  } finally { asking = false; }
}
