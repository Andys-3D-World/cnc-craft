/**
 * MEHRERE BEARBEITUNGEN JE FORM (wie in Fusion: Tasche, dann Fase, dann Ausschneiden)
 *
 * Die erste Bearbeitung ist wie bisher die Form selbst (millingMode, toolId, millingDepth, finishAllow …).
 * Weitere Bearbeitungen stehen in shape.ops – jede mit eigener Art, eigenem Werkzeug und eigener Tiefe.
 * Für den G-Code wird jede weitere Bearbeitung zu einer „Kopie“ der Form (opOf = Original), die genau wie eine
 * eigene Form gefräst wird; Werkzeug-Gruppen und Reihenfolge ergeben sich daraus von selbst (cam.ts).
 *
 * Neue Art „chamfer“ (Fase): Fasen- oder V-Fräser fährt die Kante in der Tiefe ab, die die Fasenbreite ergibt –
 * außen bei Außenkonturen, innen bei Löchern/Taschen, auf der Linie sonst (siehe cam.ts → millChamfer).
 * Art „thread“ (Gewinde fräsen): nur an Kreisen mit dem Gewindefräser – innen bei Löchern, außen bei Bolzen
 * (gleiche Seite wie die Fase); Tiefe = Gewindelänge (siehe threadMill.ts).
 */

export type OpKind = "outside" | "inside" | "pocket" | "on-line" | "vcarve" | "drill" | "chamfer" | "thread";
export const OP_KINDS: OpKind[] = ["outside", "inside", "pocket", "on-line", "vcarve", "drill", "chamfer", "thread"];

export interface ShapeOp {
  kind: OpKind;
  toolId?: string;      // fehlt = Standard-Werkzeug
  depth: number;        // Frästiefe (negativ, wie millingDepth); bei der Fase unbenutzt
  chamferW?: number;    // Fase: Breite in mm
  finishAllow?: number; // Schlicht-Aufmaß in mm
  threadD?: number;     // Gewinde: Nenn-Ø in mm (0 = aus dem Kreis)
  threadLeft?: boolean; // Gewinde: Linksgewinde
  threadPitch?: number; // Gewinde: Steigung (0 = Werkzeug bzw. ISO-Regelgewinde)
  threadPasses?: number; // Gewinde: radiale Durchgänge
  threadSpring?: boolean; // Gewinde: Leerdurchgang
}

const num = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Weitere Bearbeitungen der Form (bereinigt – Daten können aus Projektdateien kommen) */
export function extraOps(s: any): ShapeOp[] {
  if (!Array.isArray(s?.ops)) return [];
  return s.ops.filter((o: any) => o && OP_KINDS.includes(o.kind)).slice(0, 20).map((o: any) => ({
    kind: o.kind as OpKind,
    toolId: typeof o.toolId === "string" ? o.toolId : undefined,
    depth: Math.min(0, num(o.depth, -1)),
    chamferW: Math.max(0.05, num(o.chamferW, 1)),
    finishAllow: Math.max(0, num(o.finishAllow, 0)),
    ...(o.kind === "thread" ? {
      threadD: Math.max(0, Math.min(500, num(o.threadD, 0))), threadLeft: o.threadLeft === true,
      threadPitch: Math.max(0, Math.min(10, num(o.threadPitch, 0))),
      threadPasses: Math.max(1, Math.min(10, Math.round(num(o.threadPasses, 1)))), threadSpring: o.threadSpring === true
    } : {})
  }));
}

/** Auf welcher Seite der Linie die Fase liegt: +1 außen, −1 innen, 0 auf der Linie – aus der ersten Bearbeitung */
export function chamferSide(s: any): number {
  const m = s.millingMode || "outside";
  return m === "outside" ? 1 : m === "inside" || m === "pocket" || m === "drill" ? -1 : 0;
}

/** Die Form plus je weiterer Bearbeitung eine Kopie für den G-Code */
export function expandOps(shapes: any[]): any[] {
  const out: any[] = [];
  for (const s of shapes) {
    out.push(s);
    if (s.opOf || s.restOf) continue;
    extraOps(s).forEach((o, i) => {
      out.push({
        ...s,
        id: `${s.id}#op${i + 1}`,
        opOf: s,
        millingMode: o.kind,
        toolId: o.toolId,
        millingDepth: o.depth,
        finishAllow: o.finishAllow || undefined,
        chamferW: o.chamferW,
        chamferSide: chamferSide(s),
        threadD: o.threadD,
        threadLeft: o.threadLeft,
        threadPitch: o.threadPitch,
        threadPasses: o.threadPasses,
        threadSpring: o.threadSpring,
        restToolId: undefined,
        parentChainId: undefined,
        ops: undefined
      });
    });
  }
  return out;
}
