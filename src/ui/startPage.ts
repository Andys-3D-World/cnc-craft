/**
 * STARTSEITE: zuletzt benutzte Projekte mit Bild. Beim Start nur, wenn es welche gibt, die Zeichnung leer ist und es nicht
 * abgeschaltet wurde. Über „Datei → Zuletzt benutzt“ jederzeit.
 */
import { t, currentLanguage } from "../i18n/i18n";
import { state } from "../main";
import { openProjectPath, openProjectWithDialog } from "../importers/importManager";
import { isDirty } from "../editor/projectDirty";
import { RecentItem, recentAllow, recentList, recentRemove } from "../recent";

const KEY = "cnc_craft_start_page";
const enabled = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };

export async function openStartPage(atStart: boolean, items?: RecentItem[]): Promise<void> {
  if (atStart && (!enabled() || state.shapes.length || isDirty())) return;
  const list = items ?? await recentList();
  if (atStart && (!list.length || state.shapes.length || document.querySelector(".dlg-overlay"))) return;
  document.getElementById("start-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "start-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:min(820px, calc(100vw - 32px));">
      <h3>📁 <span></span></h3>
      <div class="start-grid"></div>
      <div class="dlg-hint start-empty"></div>
      <div class="dlg-buttons">
        <button type="button" class="btn-primary" data-act="new"></button>
        <button type="button" class="btn-secondary" data-act="open"></button>
        <label class="eng-ck" style="margin-left:auto;"><input type="checkbox" class="start-on"> <span></span></label>
      </div>
    </div>`;
  const $ = (s: string) => ov.querySelector(s) as HTMLElement;
  $("h3 span").textContent = t("start.title");
  $('[data-act="new"]').textContent = t(atStart ? "start.new" : "dlg.close");
  $('[data-act="open"]').textContent = t("start.open");
  $("label span").textContent = t("start.atStart");
  const box = $(".start-on") as HTMLInputElement;
  box.checked = enabled();
  box.addEventListener("change", () => { try { localStorage.setItem(KEY, box.checked ? "1" : "0"); } catch { /* egal */ } });
  const close = () => ov.remove();
  const fill = (l: RecentItem[]) => {
    $(".start-empty").textContent = l.length ? "" : t("start.empty");
    const grid = $(".start-grid");
    grid.textContent = "";
    for (const r of l) {
      // Namen und Pfade sind fremder Text: nur als Text bzw. Eigenschaft setzen
      const card = document.createElement("div");
      card.className = "start-card" + (r.exists ? "" : " gone");
      const open = document.createElement("button");
      open.type = "button"; open.className = "start-open"; open.disabled = !r.exists; open.title = r.path;
      const img = document.createElement("div");
      img.className = "start-img";
      if (/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(r.thumb)) { const im = document.createElement("img"); im.src = r.thumb; im.alt = ""; img.append(im); }
      const name = document.createElement("b"); name.textContent = r.name;
      const sub = document.createElement("span"); sub.textContent = r.exists ? new Date(r.used * 1000).toLocaleString(currentLanguage(), { dateStyle: "medium", timeStyle: "short" }) : t("start.gone");
      const dir = document.createElement("small"); dir.textContent = r.folder;
      open.append(img, name, sub, dir);
      open.onclick = async () => {
        if (!await recentAllow(r.path)) { sub.textContent = t("start.gone"); card.classList.add("gone"); return; }
        close();
        await openProjectPath(r.path);
      };
      const del = document.createElement("button");
      del.type = "button"; del.className = "start-del"; del.textContent = "✕"; del.title = t("start.remove"); del.setAttribute("aria-label", t("start.remove"));
      del.onclick = async () => { await recentRemove(r.path); fill(await recentList()); };
      card.append(open, del);
      grid.append(card);
    }
  };
  fill(list);
  $('[data-act="new"]').onclick = close;
  $('[data-act="open"]').onclick = () => { close(); void openProjectWithDialog(); };
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  document.body.appendChild(ov);
  (ov.querySelector(".start-open:not(:disabled)") as HTMLElement | null ?? $('[data-act="new"]')).focus();
}
