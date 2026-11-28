/**
 * DREHACHSE: der Auftrag für den Rust-Zwilling von wrapGcode (src-tauri/src/rotarywrap.rs).
 * Was hier mit Winkelfunktionen gerechnet wird (Flächen eines Vielecks, Eckenradius), geht fertig mit – die letzte
 * Stelle von Sinus/Kosinus kann zwischen dem Fenster und Rust abweichen. Die Texte an den Flächen ebenfalls.
 */
import { faces, isPrism, cornerRadius } from "./rotaryStock.ts";
import type { WrapOptions } from "./rotaryWrap.ts";

export function wrapJob(o: WrapOptions): Record<string, unknown> {
  const st = o.stock, prism = !!st && isPrism(st), fs = prism ? faces(st!) : [];
  return {
    axis: o.axis, driveDia: o.driveDia, partDia: o.partDia, mmPerRot: o.mmPerRot, depthFeed: !!o.depthFeed,
    along: o.along ?? null, reverse: !!o.reverse, input: o.input ?? null,
    stock: st ? { shape: st.shape, d0: st.d0, d1: st.d1, coneLen: st.coneLen } : null,
    overrun: o.overrun ?? null, laser: !!o.laser,
    faces: fs.map(f => ({ k: f.k, width: f.width, apothem: f.apothem, angle: f.angle, end: f.end, center: f.center })),
    cornerRadius: prism ? cornerRadius(st!) : 0,
    faceLabels: o.faceLabel ? fs.map(f => o.faceLabel!(f.k)) : null,
  };
}
