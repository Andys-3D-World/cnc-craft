/**
 * STL-LOADER: Meldungen zum Einlesen. Die Rechnung (Einlesen, Verschweißen, Schnitt, Höhensuche) steht in stlMesh.ts
 * und wird hier weitergereicht, damit bestehende Importe gleich bleiben.
 */
import { t } from "./i18n/i18n";
import { readStl, type StlMesh } from "./stlMesh";

export * from "./stlMesh";

export function parseStl(buffer: ArrayBuffer): StlMesh {
  const r = readStl(buffer);
  if ("error" in r) throw new Error(t(r.error === "small" ? "stl.errSmall" : "stl.errNoTriangles"));
  return r;
}
