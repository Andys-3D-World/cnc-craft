/** Sperrzonen aus den Formen der Zeichnung (mm, wie im G-Code) */
import { MM_TO_PIXEL, shapeToPaths } from "./shapeTransform";
import { isKeepOut, keepValues, KeepZone } from "./keepOut";

export function zonesFromShapes(shapes: any[]): KeepZone[] {
  return shapes.filter(isKeepOut).map((s: any) => ({
    pts: (shapeToPaths(s)[0]?.pts || []).map((p: any) => ({ x: p.x / MM_TO_PIXEL, y: p.y / MM_TO_PIXEL })),
    ...keepValues(s)
  }));
}
