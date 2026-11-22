/**
 * Saved G-code files and the post-processor: generate for the chosen controller, translate, read the result back
 * and compare it with the neutral program. A file whose path differs is not handed out.
 */
import { t, tMm, ascii } from "../i18n/i18n";
import { isLaser, isPlasma } from "../machineMode";
import { lintGcode } from "../gcodeLint";
import { postCtx } from "./postContext";
import { activePost, type ActivePost } from "./postSetting";
import { postProcess } from "./postProcess";
import { samePath } from "./pathCompare";

export const currentPost = (): ActivePost => activePost(!isLaser() && !isPlasma());

/** Run a generator so that it writes what the chosen post needs (tool numbers). Always switched back afterwards. */
export function withPost<T>(fn: () => T): T {
  const p = currentPost();
  postCtx.foreign = p.def.rewrite;
  postCtx.toolTable = p.def.rewrite && p.toolTable;
  try { return fn(); } finally { postCtx.foreign = false; postCtx.toolTable = false; }
}

/** File name with the ending of the chosen post (set before the save dialog – the path is not touched after it) */
export function postFileName(name: string): string {
  const p = currentPost();
  return p.plain ? name : name.replace(/\.[^./\\]+$/, "") + "." + p.def.ext;
}

/** Endings offered in the save dialog, the one of the chosen post first */
export function postExtensions(): string[] {
  const ext = currentPost().def.ext;
  return [ext, ...["gcode", "nc", "tap", "ngc"].filter(e => e !== ext)];
}

/**
 * The text to save for the chosen post, or null when it must not be saved (the reason is logged).
 * `neutral` has to come from a generator run inside withPost().
 */
export function postedText(neutral: string, log: (s: string) => void): string | null {
  const p = currentPost();
  if (p.plain) return neutral;
  const unit = p.inch ? "inch" : "mm";
  const note = (key: string, v?: Record<string, string | number>) => ascii(tMm(key, v));
  const info = [note("post.gc.head", { name: p.def.name, unit }), note("post.gc.untested")];
  if (p.inch) info.push(note("post.gc.commentsMm"));
  if (p.def.rewrite) info.push(note(p.toolTable ? "post.gc.table" : "post.gc.pause"));
  for (const k of p.def.fileNotes) info.push(note(k));

  const r = postProcess(neutral, p.def, { inch: p.inch, toolTable: p.toolTable, info, inchNote: note("post.gc.unitInch") });
  if (r.error) {
    log(`${t("log.error")} ${t("post.err." + r.error.code, { name: p.def.name, line: r.error.line, text: r.error.text })}`);
    return null;
  }
  const chk = samePath(neutral, r.gcode, p.inch);
  if (!chk.ok) {
    log(`${t("log.error")} ${t("post.verifyFail", { name: p.def.name, why: chk.why, line: chk.line, file: t(chk.inPosted ? "post.inPosted" : "post.inNeutral") })}`);
    return null;
  }
  const issues = lintGcode(r.gcode, { kind: "mill" });
  if (issues.length) log(t("job.lintWarn", { n: issues.length, line: issues[0].line, text: issues[0].text, rule: issues[0].rule }));
  // tMm: the difference stays in mm, whatever unit the screen shows
  log(tMm("post.done", { name: p.def.name, unit, dev: chk.maxDev.toFixed(4) }));
  log(`${t("log.warning")} ${t(p.def.rewrite ? "post.warnUntested" : "post.warnInch", { name: p.def.name })}`);
  return r.gcode;
}
