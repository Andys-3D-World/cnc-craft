/**
 * SCHRIFTEN: der eigene Text in jeder Schrift, mit Filtern, Favoriten, eigenen Dateien und der Prüfung „Passt der Fräser?“.
 * Ein Klick nimmt die Schrift für den nächsten Text. Alles ohne Internet.
 * Schriftnamen kommen aus dem System bzw. aus Dateien: nur über textContent einsetzen.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { icon } from "./icons";
import { t } from "../i18n/i18n";
import { addFontFiles, BUNDLED, customFontNames, fontFavs, FontCat, loadUserFont, previewFamily, removeUserFont, resolveFont, SINGLE_LINE_FONT, systemFonts, toggleFontFav, userFontList, userFontsReady } from "../editor/fonts";
import { largestTool, minHeight } from "../editor/fontFit";
import { setNextTextFont } from "../editor/textTool";
import { getTools } from "../toolLibrary";

const KEY = "cnc_craft_font_test";
type Source = "bundled" | "system" | "custom";
interface Entry { family: string; source: Source; cat?: FontCat; noPl?: boolean }
const CATS: FontCat[] = ["sans", "serif", "script", "stencil", "display", "mono", "single"];
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Verhältnis Werkzeug-Ø (Pixel) zu Großbuchstaben-Höhe, je Schrift und Text gemerkt. -1 = Einzellinie oder nicht messbar */
const fitCache = new Map<string, { tool: number; cap: number } | null>();
async function measure(family: string, text: string): Promise<{ tool: number; cap: number } | null> {
  const sample = text.replace(/\s+/g, " ").trim().slice(0, 14) || "Hamburg", key = family + "\n" + sample, had = fitCache.get(key);
  if (had !== undefined) return had;
  let r: { tool: number; cap: number } | null = null;
  try {
    const f = await resolveFont(family, false, false);
    if (!f.missing && !f.singleLine) {
      await document.fonts.load(`100px "${f.css}"`);
      const cv = document.createElement("canvas"), px = 150;
      let ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.font = `${px}px "${f.css}"`;
      const m = ctx.measureText(sample);
      const w = Math.min(2400, Math.ceil(m.width + px)), h = Math.ceil(px * 2.2);
      cv.width = w; cv.height = h;
      ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.font = `${px}px "${f.css}"`;
      ctx.fillText(sample, px / 2, px * 1.45);
      const d = ctx.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
      const tool = largestTool(mask, w, h), cap = ctx.measureText("H").actualBoundingBoxAscent;
      if (tool > 0 && cap > 0) r = { tool, cap };
    }
  } catch { /* nicht messbar */ }
  fitCache.set(key, r);
  return r;
}

export function openFontTester(log: (s: string) => void) {
  document.getElementById("font-test-overlay")?.remove();
  let saved: any = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { /* egal */ }
  const dias = [...new Set(getTools().filter(x => x.type === "endmill" || x.type === "ball" || x.type === "bullnose").map(x => x.diameter))].filter(d => d > 0).sort((a, b) => a - b);
  const o = { text: String(saved.text || t("ft.sample")), cols: Math.min(6, Math.max(1, Number(saved.cols) || 2)), size: Math.min(90, Math.max(14, Number(saved.size) || 34)), filled: saved.filled !== false,
    cat: "" as "" | FontCat, src: "" as "" | Source, show: "all" as "all" | "fav", pl: false, fit: false, d: Number(saved.d) > 0 ? Number(saved.d) : dias[0] ?? 3, h: Number(saved.h) > 0 ? Number(saved.h) : 30 };
  const ov = document.createElement("div");
  ov.id = "font-test-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box ft-box" role="dialog">
      <h3>${icon("text", 20)}${esc(t("ft.title"))}</h3>
      <div class="dlg-hint">${esc(t("ft.desc"))}</div>
      <div class="ft-bar">
        <input id="ft-text" type="text" maxlength="60" aria-label="${esc(t("ft.sampleLabel"))}">
        <input id="ft-search" class="prop-input" type="search" placeholder="${esc(t("text.fontSearch"))}">
        <label>${esc(t("ft.size"))} <input id="ft-size" type="range" min="14" max="90" step="1"></label>
        <label>${esc(t("ft.cols"))} <input id="ft-cols" type="range" min="1" max="6" step="1"></label>
        <label><input id="ft-fill" type="checkbox" style="width:auto;"> ${esc(t("ft.filled"))}</label>
      </div>
      <div class="ft-main">
        <div class="ft-side">
          <div class="c3d-sec">${esc(t("ft.show"))}</div><div id="ft-f-show" class="ft-filter"></div>
          <div class="c3d-sec">${esc(t("ft.kind"))}</div><div id="ft-f-cat" class="ft-filter"></div>
          <div class="c3d-sec">${esc(t("ft.source"))}</div><div id="ft-f-src" class="ft-filter"></div>
          <label class="ft-check"><input id="ft-pl" type="checkbox"> ${esc(t("ft.polish"))}</label>
          <div class="c3d-sec">${esc(t("ft.fitTitle"))}</div>
          <label class="ft-check" data-tip="${esc(t("ft.fitTip"))}"><input id="ft-fit" type="checkbox"> ${esc(t("ft.fitOnly"))}</label>
          <div class="dlg-row"><span>${esc(t("ft.fitD"))}</span><span class="dlg-num"><input id="ft-d" type="number" min="0.1" max="30" step="0.1" class="prop-input"><em>mm</em></span></div>
          <div class="dlg-row"><span>${esc(t("ft.fitH"))}</span><span class="dlg-num"><input id="ft-h" type="number" min="1" max="2000" step="1" class="prop-input"><em>mm</em></span></div>
          <button id="ft-add" class="btn-primary btn-compact" style="margin-top:10px;" data-tip="${esc(t("ft.addTip"))}">＋ ${esc(t("ft.add"))}</button>
          <div class="dlg-hint">${esc(t("ft.licHint"))}</div>
        </div>
        <div style="display:flex;flex-direction:column;min-width:0;min-height:0;"><div id="ft-count" class="dlg-hint"></div><div class="ft-grid" id="ft-grid"></div></div>
      </div>
      <div class="dlg-buttons" style="justify-content:flex-end;"><button id="ft-close" class="btn-secondary">${esc(t("upd.close"))}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const $ = <E extends HTMLElement = HTMLInputElement>(id: string) => ov.querySelector("#" + id) as E;
  const text = $("ft-text"), search = $("ft-search"), grid = $<HTMLElement>("ft-grid");
  text.value = o.text; $("ft-cols").value = String(o.cols); $("ft-size").value = String(o.size); $("ft-fill").checked = o.filled; $("ft-d").value = String(o.d); $("ft-h").value = String(o.h);
  let sys: string[] = [], run = 0;
  const all = (): Entry[] => {
    const known = new Set<string>(), out: Entry[] = [];
    const put = (e: Entry) => { if (!known.has(e.family)) { known.add(e.family); out.push(e); } };
    customFontNames().forEach(f => put({ family: f, source: "custom" }));
    BUNDLED.forEach(b => put({ family: b.family, source: "bundled", cat: b.cat, noPl: b.noPl }));
    sys.forEach(f => put({ family: f, source: "system" }));
    return out;
  };
  const match = (e: Entry, favs: Set<string>, skip = "") => {
    const q = search.value.trim().toLowerCase();
    return (!q || e.family.toLowerCase().includes(q)) && (skip === "show" || o.show !== "fav" || favs.has(e.family)) && (skip === "cat" || !o.cat || e.cat === o.cat)
      && (skip === "src" || !o.src || e.source === o.src) && (!o.pl || (e.source === "bundled" && !e.noPl));
  };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ text: text.value, cols: o.cols, size: o.size, filled: o.filled, d: o.d, h: o.h })); } catch { /* egal */ } };
  const filters = () => {
    const list = all(), favs = fontFavs();
    const box = (id: string, key: "show" | "cat" | "src", items: [string, string][], count: (v: string) => number) => {
      const b = $<HTMLElement>(id); b.textContent = "";
      for (const [v, label] of items) {
        const n = count(v);
        if (!n && v && v !== "fav" && o[key] !== v) continue;
        const el = document.createElement("button"); el.type = "button"; el.className = "ft-fbtn" + (o[key] === v ? " on" : "");
        const a = document.createElement("span"); a.textContent = label; const c = document.createElement("small"); c.textContent = String(n); el.append(a, c);
        el.onclick = () => { (o as any)[key] = v; render(); };
        b.append(el);
      }
    };
    const base = (skip: string) => list.filter(e => match(e, favs, skip));
    const s0 = base("show"), c0 = base("cat"), r0 = base("src");
    box("ft-f-show", "show", [["all", t("ft.all")], ["fav", "★ " + t("ft.favs")]], v => (v === "fav" ? s0.filter(e => favs.has(e.family)).length : s0.length));
    box("ft-f-cat", "cat", [["", t("ft.all")], ...CATS.map(c => [c, t("text.cat." + c)] as [string, string])], v => (v ? c0.filter(e => e.cat === v).length : c0.length));
    box("ft-f-src", "src", [["", t("ft.all")], ["bundled", t("text.fontBundled")], ["custom", t("text.fontCustom")], ["system", t("text.fontSystem")]], v => (v ? r0.filter(e => e.source === v).length : r0.length));
  };
  const obs = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) { obs.unobserve(e.target); (e.target as any).__show?.(); } }, { root: grid, rootMargin: "250px" });
  const render = () => {
    const me = ++run, favs = fontFavs(), list = all().filter(e => match(e, favs));
    filters();
    grid.style.gridTemplateColumns = `repeat(${o.cols}, minmax(0, 1fr))`;
    grid.textContent = "";
    obs.disconnect();
    let left = list.length;
    const count = () => { $<HTMLElement>("ft-count").textContent = t("ft.count", { n: left }); };
    const tiles: HTMLElement[] = [];
    for (const f of list) {
      const tile = document.createElement("div");
      tile.className = "ft-tile"; tile.tabIndex = 0; tile.setAttribute("role", "button"); tile.setAttribute("aria-label", f.family);
      const sample = document.createElement("span");
      sample.className = "ft-sample" + (o.filled ? "" : " ft-outline");
      sample.textContent = text.value || " ";
      sample.style.fontSize = o.size + "px";
      const foot = document.createElement("small"), name = document.createElement("b"), sub = document.createElement("span"), fit = document.createElement("span");
      name.textContent = f.family;
      sub.textContent = f.source === "bundled" ? t("text.cat." + f.cat) : t(f.source === "custom" ? "text.fontCustom" : "text.fontSystem");
      foot.append(name, sub, fit);
      const star = document.createElement("button"); star.type = "button"; star.className = "ft-star" + (favs.has(f.family) ? " on" : ""); star.textContent = favs.has(f.family) ? "★" : "☆"; star.setAttribute("aria-label", t("ft.favs"));
      star.onclick = e => { e.stopPropagation(); const on = toggleFontFav(f.family); star.textContent = on ? "★" : "☆"; star.classList.toggle("on", on); filters(); };
      tile.append(sample, foot, star);
      const uf = f.source === "custom" ? userFontList().find(x => x.name === f.family) : undefined;
      if (uf) {
        const del = document.createElement("button"); del.type = "button"; del.className = "ft-del"; del.textContent = "🗑"; del.setAttribute("aria-label", t("lathe.remove"));
        del.onclick = async e => { e.stopPropagation(); if (!window.confirm(t("ft.confirmRemove", { font: f.family }))) return; try { await removeUserFont(uf); } catch (err) { log(`${t("log.error")} ${err}`); } render(); };
        tile.append(del);
      }
      (tile as any).__show = async () => {
        if (uf) { try { await loadUserFont(uf); } catch { /* Ersatzschrift */ } }
        sample.style.fontFamily = previewFamily(f.family, f.source);
        if (!o.fit || me !== run) return;
        await new Promise(r => setTimeout(r));
        const m = await measure(f.family, text.value);
        if (me !== run) return;
        const single = f.family === SINGLE_LINE_FONT, hMin = m ? minHeight(o.d, m.tool, m.cap) : Infinity, ok = single || hMin <= o.h;
        fit.textContent = single ? t("ft.fitSingle") : m ? t("ft.fitFrom", { d: o.d, h: hMin < 10 ? hMin.toFixed(1) : Math.ceil(hMin) }) : "";
        fit.className = ok ? "ft-ok" : "ft-no";
        if (!ok) { tile.remove(); left--; count(); }
      };
      const pick = () => { setNextTextFont(f.family); log(t("ft.picked", { font: f.family })); close(); };
      tile.addEventListener("click", pick);
      tile.addEventListener("keydown", e => { if (e.target === tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(); } });
      tiles.push(tile);
    }
    grid.append(...tiles);
    if (o.fit) (async () => { for (const x of tiles) { if (me !== run || !ov.isConnected) return; await (x as any).__show(); } })();
    else tiles.forEach(x => obs.observe(x));
    count();
    keep();
  };
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (ov.isConnected) render(); }, 150); };
  text.addEventListener("input", () => { o.text = text.value; later(); });
  search.addEventListener("input", later);
  $("ft-cols").addEventListener("input", () => { o.cols = Number($("ft-cols").value); grid.style.gridTemplateColumns = `repeat(${o.cols}, minmax(0, 1fr))`; keep(); });
  $("ft-size").addEventListener("input", () => { o.size = Number($("ft-size").value); grid.querySelectorAll<HTMLElement>(".ft-sample").forEach(x => { x.style.fontSize = o.size + "px"; }); keep(); });
  $("ft-fill").addEventListener("change", () => { o.filled = $("ft-fill").checked; grid.querySelectorAll(".ft-sample").forEach(x => x.classList.toggle("ft-outline", !o.filled)); keep(); });
  $("ft-pl").addEventListener("change", () => { o.pl = $("ft-pl").checked; render(); });
  $("ft-fit").addEventListener("change", () => { o.fit = $("ft-fit").checked; render(); });
  for (const k of ["d", "h"] as const) $("ft-" + k).addEventListener("input", () => { const v = parseFloat($("ft-" + k).value); if (v > 0) { o[k] = v; if (o.fit) later(); else keep(); } });
  $<HTMLButtonElement>("ft-add").onclick = async () => {
    try {
      const sel = await open({ multiple: true, directory: false, title: t("ft.add"), filters: [{ name: t("text.fontFileFilter"), extensions: ["ttf", "otf", "woff", "woff2", "zip"] }] });
      if (!sel) return;
      const files: { name: string; data: Uint8Array }[] = [];
      for (const p of Array.isArray(sel) ? sel : [sel]) files.push({ name: String(p), data: await readFile(String(p)) });
      const r = await addFontFiles(files);
      log(t("ft.added", { n: r.names.length }) + (r.bad ? " " + t("ft.addedBad", { n: r.bad }) : ""));
      if (r.names.length) { o.src = "custom"; o.cat = ""; o.show = "all"; search.value = ""; }
      render();
    } catch (e) { log(t("text.fontLoadError", { e: String(e) })); }
  };
  function close() { run++; clearTimeout(timer); obs.disconnect(); ov.remove(); }
  $<HTMLElement>("ft-close").onclick = close;
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
  render();
  text.focus();
  text.select();
  userFontsReady.then(() => { if (ov.isConnected) render(); });
  // Systemschriften kommen später dazu (Tauri); ohne sie bleibt die Liste mit den mitgelieferten
  systemFonts().then(m => { if (!ov.isConnected) return; sys = [...m.keys()].sort((a, b) => a.localeCompare(b)); render(); }).catch(() => { /* ohne Systemschriften geht es auch */ });
}
