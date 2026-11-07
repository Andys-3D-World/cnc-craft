/**
 * SCHWEBENDES WERKZEUG-FENSTER
 *
 * Für Werkzeuge mit Live-Vorschau auf der Zeichenfläche: kein abgedunkelter Hintergrund, die Zeichnung bleibt sichtbar.
 * Beim Schließen verschwindet die Vorschau. `body` wird als HTML eingesetzt: fremde Texte vorher mit esc() behandeln.
 */
import { icon } from "./icons";
import { t } from "../i18n/i18n";
import { clearLivePreview } from "../editor/livePreview";

export interface ToolPanel {
  el: HTMLElement;
  $: <T extends HTMLElement = HTMLInputElement>(q: string) => T;
  num: (q: string, fallback?: number) => number;
  check: (q: string) => boolean;
  info: (text: string, warn?: boolean) => void;
  close: () => void;
}

export interface ToolPanelOptions {
  id: string;
  ico: string;
  title: string;
  body: string;
  ok: string;
  onChange: (p: ToolPanel) => void;
  onOk: (p: ToolPanel) => boolean | void | Promise<boolean | void>; // false = Fenster bleibt offen
  onClose?: () => void;
  redraw: () => void;
}

export const rowCss = "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:0.85rem;";
export const checkCss = "display:flex;gap:6px;align-items:center;font-size:0.85rem;";

export function openToolPanel(o: ToolPanelOptions): ToolPanel {
  document.querySelector(".tool-panel")?.dispatchEvent(new Event("tool-panel-close"));
  const el = document.createElement("div");
  el.id = o.id;
  el.className = "tool-panel";
  el.style.cssText = "position:fixed;right:300px;top:96px;z-index:4000;width:320px;max-width:calc(100vw - 16px);max-height:calc(100vh - 110px);overflow:auto;box-sizing:border-box;"
    + "background:var(--bg-panel);border:1px solid var(--border-color);border-radius:12px;padding:16px;color:var(--text-main);display:flex;flex-direction:column;gap:10px;"
    + "font-family:var(--font-ui);box-shadow:0 12px 40px rgba(0,0,0,0.55);";
  el.innerHTML = `
    <h3 style="margin:0;font-size:1rem;display:flex;gap:8px;align-items:center;">${icon(o.ico, 18)}<span>${o.title}</span></h3>
    ${o.body}
    <div class="tp-info" style="font-size:0.78rem;color:var(--text-muted);min-height:1em;"></div>
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary tp-cancel" style="flex:1;">${t("dlg.cancel")}</button>
      <button class="btn-primary tp-ok" style="flex:2;">${o.ok}</button>
    </div>`;
  document.body.appendChild(el);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    clearLivePreview();
    o.onClose?.();
    o.redraw();
  };
  const panel: ToolPanel = {
    el,
    $: <T extends HTMLElement = HTMLInputElement>(q: string) => el.querySelector(q) as T,
    num: (q, fallback = 0) => { const v = parseFloat((el.querySelector(q) as HTMLInputElement).value); return Number.isFinite(v) ? v : fallback; },
    check: q => (el.querySelector(q) as HTMLInputElement).checked,
    info: (text, warn = false) => {
      const i = el.querySelector(".tp-info") as HTMLElement;
      i.textContent = text;
      i.style.color = warn ? "var(--lt-amber, #ffb454)" : "var(--text-muted)";
    },
    close
  };
  const change = () => { if (!closed) { o.onChange(panel); o.redraw(); } };
  const ok = async () => { if ((await o.onOk(panel)) !== false) close(); };
  el.addEventListener("tool-panel-close", close);
  el.addEventListener("input", change);
  el.addEventListener("change", change);
  el.addEventListener("keydown", e => {
    e.stopPropagation(); // Tastenkürzel des Editors nicht auslösen
    if (e.key === "Escape") close();
    if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "TEXTAREA" && !(e.target as HTMLElement).closest(".fp-search")) ok();
  });
  el.querySelector(".tp-cancel")!.addEventListener("click", close);
  el.querySelector(".tp-ok")!.addEventListener("click", ok);
  change();
  return panel;
}
