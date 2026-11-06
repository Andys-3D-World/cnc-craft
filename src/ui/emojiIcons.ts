/**
 * Beim Anzeigen: Emojis in allen Texten durch eigene Symbole ersetzen (Zuordnung: emojiMap.ts).
 * Beobachtet die ganze Seite – auch neue Fenster und Texte, die sich später ändern (z. B. Pause/Weiter). Der Text bleibt echter Text,
 * nur das Emoji-Zeichen wird zu einer Grafik aus unseren eigenen Symbolen; fremder Text (Dateinamen …) wird nie als HTML gelesen.
 * Auswahllisten können keine Grafik zeigen: Dort fällt das Emoji weg.
 * Eingabefelder, Konsole und Editoren bleiben unberührt.
 */
import { icon } from "./icons";
import { ICON_COLORS, splitEmoji, stripEmoji } from "./emojiMap";

const SKIP = "textarea, input, script, style, svg, pre, code, #console-log, [contenteditable]";
const cache = new Map<string, SVGElement>();

function iconNode(name: string): SVGElement {
  let n = cache.get(name);
  if (!n) {
    const t = document.createElement("template");
    t.innerHTML = icon(name, 16);
    n = t.content.firstElementChild as SVGElement;
    n.setAttribute("class", "ico emo");
    n.setAttribute("width", "1.2em"); n.setAttribute("height", "1.2em");
    if (ICON_COLORS[name]) n.style.color = ICON_COLORS[name];
    cache.set(name, n);
  }
  return n.cloneNode(true) as SVGElement;
}

function fixText(node: Text) {
  const parent = node.parentElement;
  if (!parent) return;
  const v = node.nodeValue || "";
  if (parent.closest("option, optgroup")) {
    const s = stripEmoji(v);
    if (s !== v) node.nodeValue = s;
    return;
  }
  const parts = splitEmoji(v);
  if (!parts || parent.closest(SKIP)) return;
  const frag = document.createDocumentFragment();
  for (const p of parts) frag.appendChild("text" in p ? document.createTextNode(p.text) : iconNode(p.icon));
  node.replaceWith(frag);
}

function fixTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return fixText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  for (const q of [el, ...el.querySelectorAll("[placeholder], optgroup[label], [title]")]) for (const a of ["placeholder", "label", "title"]) {
    const v = q.getAttribute(a);
    if (v) { const s = stripEmoji(v); if (s !== v) q.setAttribute(a, s); }
  }
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), found: Text[] = [];
  while (walk.nextNode()) found.push(walk.currentNode as Text);
  found.forEach(fixText);
}

/** Einmal beim Start aufrufen */
export function initEmojiIcons() {
  fixTree(document.body);
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === "characterData") fixText(m.target as Text);
      else m.addedNodes.forEach(fixTree);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}
