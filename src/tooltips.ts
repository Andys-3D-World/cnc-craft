/**
 * HINWEIS-TEXTE (Tooltips) für alle Elemente mit data-tip="..."
 *
 * - erscheinen nach kurzer Verzögerung direkt am Element
 *   (linke Werkzeugleiste: rechts daneben, sonst darunter bzw. darüber)
 * - bleiben immer im sichtbaren Fenster
 * - funktionieren auch für Elemente, die später erst eingefügt werden (Dialoge usw.)
 * - Tastenkürzel in Klammern, z.B. "(Strg+Z)", werden hervorgehoben
 */
export function initLightBurnTooltips() {
  if (document.getElementById("app-tooltip")) return;

  const style = document.createElement("style");
  style.textContent = `
    #app-tooltip {
      position: fixed; z-index: 10000; pointer-events: none;
      max-width: 280px; padding: 6px 9px; border-radius: 6px;
      background: #0d0d11; color: #e6e6ee; border: 1px solid #3a3a46;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5);
      font: 500 12px/1.35 var(--font-ui, sans-serif);
      opacity: 0; transform: translateY(2px); transition: opacity 0.12s, transform 0.12s;
      white-space: normal;
    }
    #app-tooltip.visible { opacity: 1; transform: none; }
    #app-tooltip kbd {
      display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 4px;
      background: #26262f; border: 1px solid #3a3a46; color: #b9a8ff;
      font: 600 11px/16px var(--font-mono, monospace);
    }
  `;
  document.head.appendChild(style);

  const tip = document.createElement("div");
  tip.id = "app-tooltip";
  document.body.appendChild(tip);

  let current: HTMLElement | null = null;
  let timer = 0;

  const escape = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

  /** "Rückgängig (Strg+Z)" -> Text + hervorgehobenes Tastenkürzel */
  const format = (text: string) => {
    const m = text.match(/^(.*?)\s*\(((?:Strg|Shift|Alt|Entf|Leertaste|[A-Z])(?:[^()]*))\)(.*)$/);
    if (m && m[2].length <= 22) return `${escape(m[1])}<kbd>${escape(m[2])}</kbd>${escape(m[3])}`;
    return escape(text);
  };

  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x: number, y: number;

    if (el.closest(".tool-strip")) {
      // rechts neben dem Knopf
      x = r.right + gap;
      y = r.top + r.height / 2 - t.height / 2;
    } else {
      // unter dem Element, sonst darüber
      x = r.left + r.width / 2 - t.width / 2;
      y = r.bottom + gap;
      if (y + t.height > vh - 4) y = r.top - gap - t.height;
    }
    x = Math.max(4, Math.min(x, vw - t.width - 4));
    y = Math.max(4, Math.min(y, vh - t.height - 4));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };

  const show = (el: HTMLElement) => {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    tip.innerHTML = format(text);
    tip.style.left = "-9999px";
    tip.style.top = "0px";
    tip.classList.add("visible");
    place(el);
  };

  const hide = () => {
    clearTimeout(timer);
    current = null;
    tip.classList.remove("visible");
  };

  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => { if (current === el) show(el); }, 350);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("wheel", hide, { passive: true, capture: true });
  window.addEventListener("blur", hide);
}
