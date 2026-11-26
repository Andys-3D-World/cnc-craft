/** WERKZEUGMAGAZIN vor dem Start: Plätze prüfen, nachfragen, was in der Spindel steckt. Gestartet wird hier nie */
import { t } from "../i18n/i18n";
import { machine, MACHINE_EVENT } from "../machine";
import { getTools, toolLabel } from "../toolLibrary";
import { slotForTool, slotOf, toolNumbersIn } from "../magazine";
import { magazine, rackOn, setInSpindle } from "../magazineStore";
import { atcBlocked, atcManual } from "../toolChange";
import { askChoice } from "./unsavedDialog";

/** Hat der Nutzer seit dem Verbinden bestätigt, was in der Spindel steckt? (von Hand getauscht sieht das Programm nicht) */
let sure = "";
window.addEventListener(MACHINE_EVENT, (e: Event) => {
  const type = (e as CustomEvent).detail?.type;
  if (type === "disconnected" || type === "welcome" || type === "switched") sure = "";
});

export function spindleText(n = magazine().inSpindle): string {
  if (n < 0) return t("mag.spUnknown");
  if (n === 0) return t("mag.spEmpty");
  const s = slotOf(magazine(), n), tl = getTools().find(x => x.id === s?.toolId);
  return t("mag.slotN", { n }) + (tl ? " · " + toolLabel(tl) : "");
}

/** true = der Nutzer bestätigt, was in der Spindel steckt */
export async function confirmSpindle(): Promise<boolean> {
  const key = `${machine.port}|${magazine().inSpindle}`;
  if (sure === key) return true;
  const r = await askChoice(t("mag.sureTitle"), t("mag.sureText", { what: spindleText() }), [
    { key: "no", label: t("mag.sureNo"), cancel: true }, { key: "yes", label: t("mag.sureYes"), primary: true }
  ]);
  if (r !== "yes") { setInSpindle(-1); return false; }
  if (`${machine.port}|${magazine().inSpindle}` !== key) return false;
  sure = key;
  return true;
}
/** Nach einem eigenen Wechsel weiß das Programm es wieder sicher */
export function spindleKnown() { sure = `${machine.port}|${magazine().inSpindle}`; }

export async function magazineAllowsStart(lines: string[], firstTool: string, resume: boolean, log: (s: string) => void): Promise<boolean> {
  if (!rackOn() || machine.protocol !== "grbl") return true;
  const m = magazine(), nums = toolNumbersIn(lines), tools = getTools();
  const first = !resume && firstTool ? slotForTool(m, firstTool) : null;
  if (!nums.length && (!first || first.n === m.inSpindle)) return true;
  const hand = async (text: string) => (await askChoice(t("mag.title"), text, [
    { key: "no", label: t("dlg.cancel"), cancel: true, primary: true }, { key: "hand", label: t("mag.byHand") }
  ])) === "hand";
  const missing = nums.filter(n => !n || !slotForTool(m, tools[n - 1]?.id || ""));
  if (missing.length) return hand(t("mag.missing", { list: missing.map(n => (n ? "T" + n + (tools[n - 1] ? " " + tools[n - 1].name : "") : "T?")).join(", ") }));
  const b = atcBlocked();
  if (b.why) return hand(t("mag.why." + b.why, { n: b.n }));
  if (!await confirmSpindle()) { log(t("mag.why.spindle")); return false; }
  if (first && first.n !== magazine().inSpindle) {
    const r = await askChoice(t("mag.title"), t("mag.firstAsk", { tool: tools.find(x => x.id === firstTool)?.name || "?", n: first.n, now: spindleText() }), [
      { key: "no", label: t("dlg.cancel"), cancel: true }, { key: "get", label: t("mag.firstGet"), primary: true }
    ]);
    if (r === "get" && await atcManual("get", first.n)) { spindleKnown(); log(t("mag.firstDone")); }
    return false; // Start ist immer ein eigener Klick
  }
  return true;
}
