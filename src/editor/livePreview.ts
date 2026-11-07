/**
 * LIVE-VORSCHAU AUF DER ZEICHENFLÄCHE
 *
 * Werkzeug-Fenster (Array, Text auf Pfad, Scheren …) zeigen hier, was beim Klick auf OK entstehen würde. Die Linien
 * gehören nicht zu app().shapes: so entsteht beim Probieren kein Rückgängig-Schritt. overlay.ts zeichnet sie.
 */
import type { Path, Pt } from "../shapeTransform.ts";

export const livePreview = {
  paths: [] as Path[],
  dots: [] as Pt[],       // einzelne Punkte (z. B. Mittelpunkt, verbleibende Knoten)
  ghost: [] as Path[],    // blasse Linien (der Stand vorher)
  marks: [] as { at: Pt; dir: Pt; fixedStart: boolean }[], // Start/Richtung-Pfeile im Werkzeug-Fenster
  hideMarksOf: new Set<string>()                            // diese Formen zeigen ihre gespeicherten Pfeile gerade nicht
};

export function clearLivePreview() {
  livePreview.paths = [];
  livePreview.dots = [];
  livePreview.ghost = [];
  livePreview.marks = [];
  livePreview.hideMarksOf = new Set();
}
