/**
 * EINGABEFELDER AN DER MAUS (getippte Maße beim Zeichnen) – die Rechnung steht in typedValues.ts
 *
 * Öffnet sich, sobald man beim Zeichnen eine Zahl tippt (tools.ts → onToolKey). Tab = nächstes Feld,
 * Enter = Punkt/Form setzen, Esc = Felder schließen (die Zeichnung läuft weiter). Ein Klick auf die
 * Zeichenfläche setzt ebenfalls – mit den getippten Werten.
 */
import { t } from "../i18n/i18n";
import { isInch, unitName } from "../units";
import { MM_TO_PIXEL } from "../shapeTransform";
import { fieldsFor, FieldSpec, Lock, typedAngle, typedLen } from "./typedValues";

export interface TypedHooks {
  change: () => void;   // Werte geändert: Vorschau neu
  commit: () => void;   // Enter
  empty: () => void;    // Enter ohne Werte (z. B. Linie fertig)
}

let box: HTMLDivElement | null = null;
let inputs: HTMLInputElement[] = [];
let specs: FieldSpec[] = [];
let mouse = { x: 0, y: 0 };

// Maus-Position auf dem Bildschirm merken (gilt auch in der 3D-Ansicht, die die Maus umrechnet)
if (typeof window !== "undefined") {
  window.addEventListener("mousemove", e => {
    mouse = { x: e.clientX, y: e.clientY };
    placeBox();
  }, true);
}

function placeBox() {
  if (!box) return;
  const w = box.offsetWidth || 180, h = box.offsetHeight || 60;
  const x = Math.min(mouse.x + 18, window.innerWidth - w - 6);
  const y = Math.min(mouse.y + 18, window.innerHeight - h - 6);
  box.style.left = `${Math.max(4, x)}px`;
  box.style.top = `${Math.max(4, y)}px`;
}

export function typedOpen(): boolean { return !!box; }

/** Die getippten Werte: Längen in Zeichen-Einheiten (Welt-Pixel), Winkel in Grad */
export function typedLock(): Lock {
  const lock: Lock = {};
  if (!box) return lock;
  specs.forEach((sp, i) => {
    const txt = inputs[i]?.value ?? "";
    if (!txt.trim()) { inputs[i]?.classList.remove("bad"); return; }
    const v = sp.kind === "len" ? typedLen(txt, isInch()) * MM_TO_PIXEL : typedAngle(txt);
    inputs[i]?.classList.toggle("bad", !Number.isFinite(v));
    if (!Number.isFinite(v)) return;
    if (i === 0) lock.a = v; else lock.b = v;
  });
  return lock;
}

/** Felder öffnen; first = erstes getipptes Zeichen (kommt ins Feld focus). false = Werkzeug kennt keine Felder */
export function openTypedBox(tool: string, first: string, hooks: TypedHooks, focus = 0): boolean {
  const f = fieldsFor(tool);
  if (!f) return false;
  closeTypedBox();
  specs = f;
  box = document.createElement("div");
  box.className = "typed-box";
  box.title = t("typed.tip");
  inputs = f.map((sp, i) => {
    const row = document.createElement("label");
    const cap = document.createElement("span");
    cap.textContent = t(sp.key);
    const inp = document.createElement("input");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.dataset.idx = String(i);
    const unit = document.createElement("i");
    unit.textContent = sp.kind === "len" ? unitName() : "°";
    row.append(cap, inp, unit);
    box!.appendChild(row);
    return inp;
  });
  document.body.appendChild(box);
  placeBox();

  inputs.forEach((inp, i) => {
    inp.addEventListener("input", () => hooks.change());
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Tab") {
        e.preventDefault();
        const n = inputs.length;
        const next = inputs[(i + (e.shiftKey ? n - 1 : 1)) % n];
        next.focus(); next.select();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const any = inputs.some(q => q.value.trim());
        if (any) hooks.commit(); else { closeTypedBox(); hooks.empty(); }
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeTypedBox();
        hooks.change();
      }
    });
  });
  const start = inputs[Math.min(focus, inputs.length - 1)];
  start.value = first;
  start.focus();
  start.setSelectionRange(first.length, first.length);
  hooks.change();
  return true;
}

export function closeTypedBox() {
  box?.remove();
  box = null;
  inputs = [];
  specs = [];
}
