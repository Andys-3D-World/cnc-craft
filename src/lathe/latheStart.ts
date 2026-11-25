/** Drehbank: vor jedem Start fragen, ob Futter, Schlüssel und Stahl sicher sind. Ohne Ja startet nichts. */
import { t } from "../i18n/i18n";
import { askChoice } from "../ui/unsavedDialog";
import { latheSettings } from "./latheJob";

export async function latheStartOk(): Promise<boolean> {
  const s = latheSettings;
  const text = ["lathe.ask.1", "lathe.ask.2", "lathe.ask.3", "lathe.ask.4", ...(s.out.spindle === "hand" ? [] : ["lathe.ask.sel"]), s.out.spindle === "hand" ? "lathe.ask.hand" : "lathe.ask.auto"].map(k => "• " + t(k, { rpm: s.job.maxRpm, d: s.job.stockD, l: s.job.stickOut })).join("\n");
  return (await askChoice(t("lathe.ask.title"), text, [
    { key: "cancel", label: t("dlg.cancel"), cancel: true, primary: true },
    { key: "ok", label: t("lathe.ask.ok") },
  ])) === "ok";
}
