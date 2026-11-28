/**
 * DREHEN: der Auftrag für den Rust-Zwilling von planLathe + latheGcode (src-tauri/src/lathe.rs).
 * Was hier mit Winkelfunktionen gerechnet wird (Sinus, Kosinus, Tangens der beiden Schneidkanten je Werkzeug), geht
 * fertig mit – die letzte Stelle kann zwischen dem Fenster und Rust abweichen. Texte und Werkzeugnamen gehen schon ohne
 * Umlaute und Klammern mit (asc = ascii aus i18n.ts, in den Tests eine einfache Fassung).
 */
import { shapeOf, type LatheJob, type LatheOut, type LatheTool, type Pt } from "./turn.ts";

/** gleiche Zahl wie JOB_VERSION in lathe.rs */
export const LATHE_JOB_VERSION = 1;

export const LATHE_TEXT_KEYS = ["title", "mm", "abs", "feedMin", "g7", "g8", "off", "on", "spinUp", "tool", "hand", "handOff", "end",
  "op.face", "op.rough", "op.finish", "op.drill", "op.groove", "op.part"];

const trig = (deg: number) => { const a = deg * Math.PI / 180; return [Math.sin(a), Math.cos(a), Math.tan(a)]; };

/** text(key) = Vorlage des Kommentars lathe.gc.<key> mit Platzhaltern, asc = Text ohne Umlaute und Klammern */
export function latheRustJob(job: LatheJob, tools: LatheTool[], profile: Pt[][], out: LatheOut, text: (key: string) => string, asc: (s: string) => string) {
  return {
    version: LATHE_JOB_VERSION, job, profile, out,
    tools: tools.map(t => {
      const s = shapeOf(t);
      return { id: t.id, num: t.num, name: asc(t.name), type: t.type, hand: t.hand, nose: t.nose, width: t.width, dia: t.dia, ap: t.ap, feed: t.feed, vcPct: t.vcPct,
        aL: s.aL, aR: s.aR, trigL: trig(s.aL), trigR: trig(s.aR) };
    }),
    texts: Object.fromEntries(LATHE_TEXT_KEYS.map(k => [k, asc(text(k))])),
  };
}
