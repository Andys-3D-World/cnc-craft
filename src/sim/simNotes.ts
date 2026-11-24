/**
 * HINWEISE ZUR SIMULATION (ohne Oberfläche): Was steht im G-Code, das die Simulation nicht nachbildet?
 *
 * Eigener G-Code besteht nur aus Bekanntem. Dateien aus anderen Programmen können mehr enthalten: dann würde die Bahn
 * normal aussehen, obwohl die Maschine etwas anderes fährt. Darum gilt: jeder G-Befehl, der hier nicht als bekannt
 * steht, wird mit Zeile gemeldet – nicht nur eine Liste bekannter Problemfälle.
 *
 * Arten:  code = wird nicht nachgebildet, Bahn kann ab dort falsch sein   move = diese Fahrt fehlt im Bild
 *         wcs = anderer Nullpunkt (Lage unbekannt)                       expr = Variablen, Formeln, Schleifen
 *         sub = Unterprogramm/Makro wird nicht ausgeführt                 time = nur die Zeit stimmt nicht
 *         axis = Achse wird nicht gezeichnet
 * Antasten (G38.x) wird nicht gemeldet: das Ergebnis kennt man vorher nie, und danach setzt der Job die Höhe selbst.
 */
export type SimNoteKind = "code" | "move" | "wcs" | "expr" | "sub" | "time" | "axis";
/** line = erste Zeile (0-basiert), count = wie oft */
export interface SimNote { kind: SimNoteKind; code: string; line: number; count: number }

/** G-Befehle (mal 10), die nachgebildet werden oder die Bahn nicht ändern */
const KNOWN = new Set([
  0, 10, 20, 30, 40, 150, 170, 180, 190, 200, 210, 281, 301,
  400, 430, 431, 432, 490, 500, 501, 610, 611, 640, 690,
  730, 740, 800, 810, 820, 830, 840, 850, 890,
  900, 901, 910, 911, 920, 921, 922, 923, 940, 970, 980, 990
]);
const TURNED = ["B", "C", "U", "V", "W"];
const MAX_NOTES = 50;

const name = (letter: string, v: number) => letter + String(+v.toFixed(1));

export class SimNotes {
  private found = new Map<string, SimNote>();
  private wcs = 0;          // zuletzt gewähltes System (mal 10), 0 = noch keins
  private moved = false;    // gab es schon eine Fahrt?

  private add(kind: SimNoteKind, code: string, line: number) {
    const key = kind + code, n = this.found.get(key);
    if (n) n.count++;
    else if (this.found.size < MAX_NOTES) this.found.set(key, { kind, code, line, count: 1 });
  }

  /** Eine Zeile (ohne Kommentare, Großbuchstaben) mit den schon gelesenen Wörtern */
  line(code: string, gs: number[], ms: number[], words: Record<string, number>, li: number, absolute: boolean, plane: number) {
    const c0 = code[0];
    if (c0 === "$" || c0 === "%") return;
    if (code.includes("#") || code.includes("[") || code.includes("=")) this.add("expr", "", li);
    if (c0 === "O" && /^O\s*(<|\d+\s*(SUB|CALL|IF|WHILE|DO|REPEAT))/.test(code)) this.add("sub", "O", li);
    for (const g of gs) {
      const k = Math.round(g * 10);
      if (k === 280 || k === 300 || k === 530) this.add("move", name("G", g), li);
      else if (k >= 540 && k <= 599) {
        // Nur der Wechsel zählt: mit einem einzigen System ist das Bild richtig, egal welches es ist
        if (k === 541 || (this.wcs ? k !== this.wcs : this.moved && k !== 540)) this.add("wcs", name("G", g), li);
        this.wcs = k;
      }
      else if (k === 650 || k === 660) this.add("sub", name("G", g), li);
      else if (k === 930 || k === 950) this.add("time", name("G", g), li);
      else if (k >= 380 && k < 390) continue;
      else if (!KNOWN.has(k)) this.add("code", name("G", g), li);
      else if (((k >= 810 && k <= 890) || k === 730 || k === 740) && (!absolute || plane !== 17)) {
        this.add("code", `${name("G", g)} (${absolute ? "G" + plane : "G91"})`, li);
      }
    }
    for (const m of ms) if (m === 97 || m === 98) this.add("sub", name("M", m), li);
    for (const a of TURNED) if (words[a] !== undefined) this.add("axis", a, li);
    if (words.X !== undefined || words.Y !== undefined || words.Z !== undefined) this.moved = true;
  }

  list(): SimNote[] { return [...this.found.values()].sort((a, b) => a.line - b.line); }
}
