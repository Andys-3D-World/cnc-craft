/**
 * DREHBANK: Einstellungen, Kontur aus der Zeichnung und fertiges Programm. Gerechnet wird in turn.ts.
 * Die Zeichnung ist die halbe Kontur von der Seite: waagerecht = Drehachse, rechts = Planfläche (Z0), links = Futter.
 */
import { t, ascii, tMm } from "../i18n/i18n";
import { MM_TO_PIXEL, shapeToPaths } from "../shapeTransform";
import { recordingPost, postInApp, notePost } from "../camPost";
import { latheRustJob } from "./latheRust";
import { DEFAULT_LATHE_TOOLS, latheGcode, planLathe, type LatheJob, type LatheOp, type LatheOut, type LathePlan, type LatheTool, type Pt } from "./turn";

const KEY = "cnc_craft_lathe", KEY_TOOLS = "cnc_craft_lathe_tools";
export interface LatheSettings { job: LatheJob; out: LatheOut; material: string; watt: number; post: "front" | "rear"; axis: "bottom" | "middle" | "zero"; profile: string[] }

const DEF_OPS = (): LatheOp[] => [
  { kind: "face", on: true, tool: "l1" }, { kind: "rough", on: true, tool: "l1" }, { kind: "finish", on: true, tool: "l2" },
  { kind: "drill", on: false, tool: "l4", depth: 10 }, { kind: "groove", on: false, tool: "l3", z: -10, width: 2, d: 10 }, { kind: "part", on: false, tool: "l3", d: 0 },
];
const DEFAULTS = (): LatheSettings => ({
  job: { stockD: 30, faceAllow: 1, stickOut: 60, margin: 3, allowX: 0.2, allowZ: 0.05, vc: 90, maxRpm: 1500, safeX: 3, safeZ: 5, clear: 0.5, tailOn: false, tailD: 12, tailZ: 0, ops: DEF_OPS() },
  out: { xMode: "radius", xSign: 1, spindle: "auto", dir: "M3" }, material: "steel", watt: 850, post: "front", axis: "bottom", profile: [],
});
const LIM: Record<string, [number, number]> = {
  stockD: [1, 1000], faceAllow: [0, 20], stickOut: [1, 3000], margin: [0.5, 50], allowX: [0, 3], allowZ: [0, 3], vc: [1, 1000], maxRpm: [10, 10000],
  safeX: [1, 100], safeZ: [1, 200], clear: [0.1, 5], tailD: [0, 500], tailZ: [-3000, 200],
};
const num = (v: any, [lo, hi]: [number, number], d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
/** Gespeichertes oder fremdes Projekt: nur bekannte Felder, nur sinnvolle Werte */
export function cleanLathe(raw: any): LatheSettings {
  const d = DEFAULTS(), j = raw?.job ?? {}, o = raw?.out ?? {};
  for (const k of Object.keys(LIM)) (d.job as any)[k] = num(j[k], LIM[k], (d.job as any)[k]);
  d.job.tailOn = j.tailOn === true;
  if (["radius", "dia", "g8", "g7"].includes(o.xMode)) d.out.xMode = o.xMode;
  if (o.xSign === -1) d.out.xSign = -1;
  if (o.spindle === "hand" || o.spindle === "m8") d.out.spindle = o.spindle;
  if (o.dir === "M4") d.out.dir = "M4";
  if (typeof raw?.material === "string" && /^[a-z]{1,20}$/.test(raw.material)) d.material = raw.material;
  if (raw?.post === "rear") d.post = "rear";
  d.watt = num(raw?.watt, [10, 50000], d.watt);
  if (["bottom", "middle", "zero"].includes(raw?.axis)) d.axis = raw.axis;
  if (Array.isArray(raw?.profile)) d.profile = raw.profile.filter((x: any) => typeof x === "string" && x.length < 80).slice(0, 2000);
  if (Array.isArray(j.ops)) {
    const ok = j.ops.filter((x: any) => x && ["face", "rough", "finish", "drill", "groove", "part"].includes(x.kind)).slice(0, 40)
      .map((x: any): LatheOp => ({ kind: x.kind, on: x.on === true, tool: typeof x.tool === "string" ? x.tool.slice(0, 60) : "", z: num(x.z, [-3000, 0], -10), width: num(x.width, [0.1, 500], 2), d: num(x.d, [0, 1000], x.kind === "part" ? 0 : 10), depth: num(x.depth, [0, 1000], 10) }));
    const one = (k: string) => ok.find((x: LatheOp) => x.kind === k) ?? DEF_OPS().find(x => x.kind === k)!;
    const gr = ok.filter((x: LatheOp) => x.kind === "groove");
    // feste Reihenfolge: Planen, Schruppen, Schlichten, Bohren, Einstiche, zuletzt Abstechen
    d.job.ops = [one("face"), one("rough"), one("finish"), one("drill"), ...(gr.length ? gr : [one("groove")]), one("part")];
  }
  return d;
}
export function cleanTools(raw: any): LatheTool[] {
  if (!Array.isArray(raw)) return DEFAULT_LATHE_TOOLS.map(x => ({ ...x }));
  const out: LatheTool[] = [];
  for (const x of raw.slice(0, 200)) {
    if (!x || !["turn", "groove", "drill"].includes(x.type)) continue;
    const id = typeof x.id === "string" ? x.id.replace(/[^\w-]/g, "").slice(0, 40) : "";
    if (!id || out.some(y => y.id === id)) continue;
    out.push({ id, num: Math.round(num(x.num, [0, 999], out.length + 1)), name: String(x.name ?? "").slice(0, 60), type: x.type, hand: x.hand === "L" || x.hand === "N" ? x.hand : "R",
      nose: num(x.nose, [0, 10], 0.4), kappa: num(x.kappa, [30, 117], 95), eps: num(x.eps, [10, 120], 80), width: num(x.width, [x.type === "groove" ? 0.3 : 0, 20], 2), dia: num(x.dia, [x.type === "drill" ? 0.3 : 0, 100], 5),
      ap: num(x.ap, [0.01, 20], 0.5), feed: num(x.feed, [0.001, 2], 0.1), vcPct: num(x.vcPct, [1, 500], 100) });
  }
  return out.length ? out : DEFAULT_LATHE_TOOLS.map(x => ({ ...x }));
}
const read = (k: string) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
export let latheSettings: LatheSettings = cleanLathe(read(KEY));
export let latheTools: LatheTool[] = cleanTools(read(KEY_TOOLS));
export function saveLathe() { try { localStorage.setItem(KEY, JSON.stringify(latheSettings)); } catch { /* egal */ } }
export function setLatheSettings(raw: any) { latheSettings = cleanLathe(raw); saveLathe(); }
export function setLatheTools(list: LatheTool[]) { latheTools = cleanTools(list); try { localStorage.setItem(KEY_TOOLS, JSON.stringify(latheTools)); } catch { /* egal */ } if (typeof window !== "undefined") window.dispatchEvent(new Event("cnc-lathe-tools")); }
/** Sicherung: Liste ausgeben und wieder einlesen (hinzufügen überspringt gleiche, ersetzen tauscht alles). Ergebnis: Anzahl übernommener */
export const exportLatheLibrary = () => ({ tools: latheTools.map(x => ({ ...x })) });
export function importLatheLibrary(d: { tools: any[] }, replace: boolean): number {
  const isTool = (x: any) => !!x && ["turn", "groove", "drill"].includes(x.type);
  const list = (Array.isArray(d?.tools) ? d.tools : []).filter(isTool);
  if (!list.length) return 0;
  const inc = cleanTools(list.map((x, i) => ({ ...x, id: "i" + i })));
  if (replace) { setLatheTools(inc.map((x, i) => ({ ...x, id: "l" + (i + 1) }))); return inc.length; }
  const key = (x: LatheTool) => JSON.stringify({ ...x, id: "", num: 0 }), have = new Set(latheTools.map(key)), out = latheTools.slice();
  let n = 0;
  for (const x of inc) {
    if (have.has(key(x))) continue;
    let k = 1; while (out.some(y => y.id === "l" + k)) k++;
    out.push({ ...x, id: "l" + k }); have.add(key(x)); n++;
  }
  if (n) setLatheTools(out);
  return n;
}

/** Formen der Kontur: die übernommenen, sonst alles in der Zeichnung */
export function profileShapes(shapes: any[], s = latheSettings): any[] {
  const use = shapes.filter(x => !x.keepOut && x.type !== "image"), ids = new Set(s.profile), own = use.filter(x => ids.has(x.id));
  return own.length ? own : use;
}
/** Kontur in mm: rechtes Ende bei z = 0, Drehmitte bei r = 0 */
export function profileFromShapes(shapes: any[], s = latheSettings): Pt[][] {
  const lines: { x: number; y: number }[][] = [];
  for (const sh of profileShapes(shapes, s)) {
    let paths: any[] = [];
    try { paths = shapeToPaths(sh); } catch { /* ohne Bahn */ }
    for (const p of paths) {
      const pts = p.pts.map((q: any) => ({ x: q.x / MM_TO_PIXEL, y: q.y / MM_TO_PIXEL }));
      if (p.closed && pts.length > 2) pts.push({ ...pts[0] });
      if (pts.length > 1) lines.push(pts);
    }
  }
  if (!lines.length) return [];
  let x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of lines) for (const p of l) { x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const axis = s.axis === "middle" ? (y0 + y1) / 2 : s.axis === "zero" ? 0 : y0;
  return lines.map(l => l.map(p => ({ z: p.x - x1, r: Math.max(0, p.y - axis) })));
}

export function planFromDesign(shapes: any[], s = latheSettings, tools = latheTools): LathePlan {
  return planLathe({ job: s.job, tools, profile: profileFromShapes(shapes, s) });
}
const opName = (plan: { op: number }, s: LatheSettings) => (plan.op >= 0 ? t("lathe.op." + s.job.ops[plan.op].kind) + ": " : "");
/** Meldungen als Sätze, harte zuerst */
export function issueTexts(plan: LathePlan, s = latheSettings): { hard: string[]; soft: string[] } {
  const txt = (i: LathePlan["issues"][number]) => opName(i, s) + t("lathe.err." + i.code, { v: i.v ?? "" });
  return { hard: plan.issues.filter(i => i.hard).map(txt), soft: plan.issues.filter(i => !i.hard).map(txt) };
}
export function gcodeFromPlan(plan: LathePlan, s = latheSettings): string {
  return latheGcode(plan, s.job, s.out, (k, v) => ascii(tMm("lathe.gc." + k, v)));
}
export function latheGcodeFromDesign(shapes: any[]): { gcode: string | null; warnings: string[]; notes: string[] } {
  const plan = planFromDesign(shapes), m = issueTexts(plan);
  const res = m.hard.length ? { gcode: null, warnings: m.hard, notes: [] }
    : !plan.runs.length ? { gcode: null, warnings: [t("lathe.nothing")], notes: [] }
    : { gcode: gcodeFromPlan(plan), warnings: m.soft, notes: [] };
  // in der App rechnet Rust dieselben Bahnen und denselben G-Code daneben und vergleicht (lathe.rs, camPost.ts)
  if (recordingPost() && postInApp()) {
    const s = latheSettings;
    const job = latheRustJob(s.job, latheTools, profileFromShapes(shapes, s), s.out, k => tMm("lathe.gc." + k), ascii);
    notePost("lathe_generate", { job }, { gcode: res.gcode, warnings: res.warnings },
      (r: { gcode: string | null; issues: { code: string; op: number; v?: number | null; hard: boolean }[]; runs: number }) => {
        const issues = r.issues.map(i => ({ ...i, v: i.v ?? undefined }));
        const txt = issueTexts({ issues } as unknown as LathePlan, s), hard = issues.some(i => i.hard);
        return { gcode: r.gcode, warnings: hard ? txt.hard : !r.runs ? [t("lathe.nothing")] : txt.soft };
      });
  }
  return res;
}
