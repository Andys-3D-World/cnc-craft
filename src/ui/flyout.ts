/**
 * AUFKLAPPENDE GRUPPEN in den Werkzeugleisten (wie in LightBurn / Photoshop)
 *
 * Ein Knopf steht für mehrere zusammengehörige Werkzeuge oder Befehle. Maus drüber (oder Klick) → die Liste
 * klappt auf, mit Symbol und Namen. Der Name kommt aus dem Hinweis-Text (bis „ – “, „:“ bzw. Klammer), das
 * Tastenkürzel daneben – so gibt es keine zweite Übersetzung.
 *
 *  - Werkzeug-Gruppe: der Knopf zeigt das zuletzt benutzte Werkzeug; Klick schaltet es direkt ein,
 *    auch Tastenkürzel (R, E …) wechseln das Symbol mit
 *  - Befehls-Gruppe: der Knopf hat ein festes Symbol, Klick klappt nur auf
 * Die Knöpfe in der Liste haben wie bisher data-tool / data-cmd und werden von toolsHandler.ts bzw.
 * editor/commands.ts verbunden.
 */
import { icon } from "./icons";
import { tip } from "../i18n/i18n";

const KEY = "cnc_craft_fly";
let last: Record<string, string> = {};
try { last = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { last = {}; }
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify(last)); } catch { /* egal */ } };

type Item = [id: string, ico: string, tipKey: string];

/** Gruppe mit Zeichen-Werkzeugen (data-tool) */
export function flyTools(group: string, items: Item[], size = 20): string {
  const cur = items.find(i => i[0] === last[group]) || items[0];
  return `<div class="fly fly-left" data-fly="${group}">
    <button class="btn-tool-icon fly-btn" data-tool="${cur[0]}" data-fly-btn ${tip("fly." + group)}>${icon(cur[1], size)}<i class="fly-tri"></i></button>
    <div class="fly-menu">${items.map(([id, ico, k]) =>
      `<button class="btn-tool-icon fly-item" data-tool="${id}" data-ico="${ico}" ${tip(k)}>${icon(ico, 18)}<span class="fly-lbl"></span><kbd class="fly-kbd"></kbd></button>`).join("")}</div>
  </div>`;
}

/** Gruppe mit Befehlen (data-cmd); side = wohin die Liste aufklappt */
export function flyCmds(group: string, ico: string, items: Item[], side: "down" | "left" = "down", size = 18): string {
  const btnCls = side === "left" ? "btn-tool-icon" : "btn-cmd";
  return `<div class="fly fly-${side}" data-fly="${group}">
    <button class="${btnCls} fly-btn" data-fly-btn ${tip("fly." + group)}>${icon(ico, size)}<i class="fly-tri"></i></button>
    <div class="fly-menu">${items.map(([id, i, k]) =>
      `<button class="btn-cmd fly-item" data-cmd="${id}" ${tip(k)}>${icon(i, 18)}<span class="fly-lbl"></span><kbd class="fly-kbd"></kbd></button>`).join("")}</div>
  </div>`;
}

/** Name + Tastenkürzel aus dem Hinweis: "Rechteck (R) – Shift = Quadrat" → "Rechteck", "R" */
function labelOf(tipText: string): { name: string; key: string } {
  // nur echte Tastenkürzel: einzelner Buchstabe, F-Taste oder Strg/Shift/Alt+… (nicht „(Fase)“)
  const key = (tipText.match(/\(((?:Strg|Ctrl|Cmd|Shift|Alt)\+[^()]{1,16}|[A-Z]|F\d{1,2}|Entf|Del)\)/) || [])[1] || "";
  const name = tipText.split(/\s+[–—-]\s+|:\s|\s\(/)[0].trim();
  return { name: name || tipText, key };
}

function labelAll(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".fly-item").forEach(b => {
    const l = labelOf(b.getAttribute("data-tip") || "");
    b.querySelector(".fly-lbl")!.textContent = l.name;
    const k = b.querySelector<HTMLElement>(".fly-kbd")!;
    k.textContent = l.key;
    k.style.display = l.key ? "" : "none";
  });
}

let openFly: HTMLElement | null = null;
let closeTimer = 0;

function place(fly: HTMLElement) {
  const btn = fly.querySelector<HTMLElement>("[data-fly-btn]")!, menu = fly.querySelector<HTMLElement>(".fly-menu")!;
  const r = btn.getBoundingClientRect();
  menu.style.left = "-9999px"; menu.style.top = "0px";
  const m = menu.getBoundingClientRect();
  let x: number, y: number;
  if (fly.classList.contains("fly-down")) { x = r.left; y = r.bottom + 4; }
  else { x = r.right + 6; y = r.top - 6; }
  x = Math.max(4, Math.min(x, window.innerWidth - m.width - 4));
  y = Math.max(4, Math.min(y, window.innerHeight - m.height - 4));
  menu.style.left = Math.round(x) + "px"; menu.style.top = Math.round(y) + "px";
}

function show(fly: HTMLElement) {
  clearTimeout(closeTimer);
  if (openFly && openFly !== fly) openFly.classList.remove("open");
  openFly = fly;
  fly.classList.add("open");
  document.getElementById("app-tooltip")?.classList.remove("visible"); // Hinweis des Knopfs nicht über der Liste
  place(fly);
}

function hide(delay = 0) {
  clearTimeout(closeTimer);
  const f = openFly;
  if (!f) return;
  const go = () => { f.classList.remove("open"); if (openFly === f) openFly = null; };
  if (delay) closeTimer = window.setTimeout(go, delay); else go();
}

/** Nach dem Einfügen der Leisten aufrufen (vor toolsHandler/commands ist egal – die binden data-tool/data-cmd selbst) */
export function initFlyouts(root: ParentNode = document) {
  labelAll(root);
  root.querySelectorAll<HTMLElement>(".fly").forEach(fly => {
    const btn = fly.querySelector<HTMLElement>("[data-fly-btn]")!;
    const isTool = btn.hasAttribute("data-tool");
    fly.addEventListener("mouseenter", () => show(fly));
    fly.addEventListener("mouseleave", () => hide(220));
    // Befehls-Gruppe: Klick klappt auf/zu (Trackpad, Touch); Werkzeug-Gruppe: Klick wählt das Werkzeug (toolsHandler)
    if (!isTool) btn.addEventListener("click", () => (fly.classList.contains("open") ? hide() : show(fly)));
    fly.querySelectorAll<HTMLElement>(".fly-item").forEach(item => item.addEventListener("click", () => {
      if (!isTool) return hide();
      last[fly.dataset.fly!] = item.dataset.tool!;
      remember();
      hide();
    }));
  });
  document.addEventListener("mousedown", e => { if (openFly && !openFly.contains(e.target as Node)) hide(); }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  // Werkzeug gewechselt (auch per Taste): Gruppen-Knopf zeigt es und ist aktiv
  window.addEventListener("cnc-tool-changed", e => {
    const name = (e as CustomEvent).detail as string;
    document.querySelectorAll<HTMLElement>(".fly").forEach(fly => {
      const btn = fly.querySelector<HTMLElement>("[data-fly-btn][data-tool]");
      const item = fly.querySelector<HTMLElement>(`.fly-item[data-tool="${name}"]`);
      if (!btn || !item) return;
      btn.dataset.tool = name;
      btn.querySelector("svg, .ico")?.remove();
      btn.insertAdjacentHTML("afterbegin", icon(item.dataset.ico!, 20));
      btn.classList.add("active");
      last[fly.dataset.fly!] = name;
      remember();
    });
  });
  window.addEventListener("cnc-language-changed", () => labelAll(document));
}
