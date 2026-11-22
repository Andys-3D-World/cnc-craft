/**
 * Which post-processor the saved G-code file goes through (router only). A setting of the program, kept under
 * `cnc_craft_post`. It is not part of a machine profile: LinuxCNC and Mach machines cannot be connected to
 * CNC Craft, the choice only matters for the file.
 */
import { DEFAULT_POST, postById, type PostDef } from "./posts.ts";

const KEY = "cnc_craft_post";

export const postSetting = { id: DEFAULT_POST, inch: false, toolTable: true };

export function loadPostSetting() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (typeof o.id === "string") postSetting.id = postById(o.id).id;
    if (typeof o.inch === "boolean") postSetting.inch = o.inch;
    if (typeof o.toolTable === "boolean") postSetting.toolTable = o.toolTable;
  } catch { /* defaults */ }
}

export function savePostSetting() {
  try { localStorage.setItem(KEY, JSON.stringify(postSetting)); } catch { /* storage locked */ }
}

export interface ActivePost { def: PostDef; inch: boolean; toolTable: boolean; plain: boolean }

/** @param router false in laser and plasma mode: there the file is always written as before */
export function activePost(router: boolean): ActivePost {
  const def = postById(router ? postSetting.id : DEFAULT_POST);
  const inch = router && postSetting.inch;
  return { def, inch, toolTable: def.hasToolTable && postSetting.toolTable, plain: !def.rewrite && !inch };
}
