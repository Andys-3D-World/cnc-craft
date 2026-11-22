/**
 * Post-processor choice (router only): rows under "Save G-code". Only the saved file is affected –
 * the notes next to the choice say what has not run on a real machine.
 */
import { t, T, tip } from "../i18n/i18n";
import { POSTS, postById } from "../post/posts";
import { postSetting, loadPostSetting, savePostSetting } from "../post/postSetting";

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function postRowsHtml(): string {
  return `
    <div class="only-mill rp-box" id="post-box" data-unit-scope="none">
      <div class="prop-row" ${tip("post.tip")}>${T("post.label")}
        <select id="post-id" class="prop-input" style="width: 150px;">${POSTS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select>
      </div>
      <div class="prop-row" ${tip("post.unitTip")}>${T("post.unit")}
        <select id="post-unit" class="prop-input" style="width: 150px;">
          <option value="mm" data-i18n="post.unitMm">mm (G21)</option>
          <option value="inch" data-i18n="post.unitInch">inch (G20)</option>
        </select>
      </div>
      <div class="prop-row" id="post-tools-row" ${tip("post.toolsTip")}>${T("post.tools")}
        <select id="post-tools" class="prop-input" style="width: 150px;">
          <option value="table" data-i18n="post.toolsTable">Tool table</option>
          <option value="pause" data-i18n="post.toolsPause">Pause</option>
        </select>
      </div>
      <div id="post-note" class="tool-info"></div>
    </div>`;
}

export function initPostPanel(root: HTMLElement) {
  loadPostSetting();
  const id = root.querySelector<HTMLSelectElement>("#post-id"), unit = root.querySelector<HTMLSelectElement>("#post-unit");
  const tools = root.querySelector<HTMLSelectElement>("#post-tools"), toolsRow = root.querySelector<HTMLElement>("#post-tools-row");
  const note = root.querySelector<HTMLElement>("#post-note");
  if (!id || !unit || !tools || !toolsRow || !note) return;
  const show = () => {
    const def = postById(postSetting.id);
    id.value = def.id;
    unit.value = postSetting.inch ? "inch" : "mm";
    tools.value = postSetting.toolTable ? "table" : "pause";
    toolsRow.style.display = def.hasToolTable ? "" : "none";
    const lines: string[] = [];
    if (!def.rewrite && !postSetting.inch) lines.push(t("post.note.grbl"));
    else {
      lines.push(t("post.note.fileOnly", { ext: def.ext }));
      for (const k of def.notes) lines.push(t(k, { name: def.name }));
      if (!def.rewrite) lines.push(t("post.note.grblInch"));
      if (def.hasToolTable) lines.push(t(postSetting.toolTable ? "post.note.table" : "post.note.pause"));
    }
    note.replaceChildren(...lines.map(l => { const d = document.createElement("div"); d.textContent = l; return d; }));
    note.classList.toggle("warn", def.rewrite || postSetting.inch);
  };
  id.addEventListener("change", () => { postSetting.id = postById(id.value).id; savePostSetting(); show(); });
  unit.addEventListener("change", () => { postSetting.inch = unit.value === "inch"; savePostSetting(); show(); });
  tools.addEventListener("change", () => { postSetting.toolTable = tools.value === "table"; savePostSetting(); show(); });
  window.addEventListener("cnc-language-changed", show);
  show();
}
