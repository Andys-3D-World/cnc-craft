/**
 * FORMEN IN RUST, MIT DEM TYPESCRIPT GEPRÜFT (shapes.rs)
 *
 * Kurzbeschreibung von Formen an einer Stelle – dieselbe Rechnung wie `info` in shapes.rs: Box der Auswahl, je Form
 * Box, geschlossen und Abstand zur Stelle, je Punktezug Anzahl Punkte, Fläche und ob die Stelle innen liegt.
 * Nur Rechnen, läuft auch in den Tests.
 */
import { distanceToShape, groupBounds, isClosedShape, pathArea, pointInPath, shapeBounds, shapeToPaths } from "../shapeTransform.ts";

export function shapeInfo(shapes: any[], x: number, y: number) {
  return {
    bounds: groupBounds(shapes),
    each: shapes.map(s => ({
      bounds: shapeBounds(s), closed: isClosedShape(s), dist: distanceToShape(x, y, s),
      paths: shapeToPaths(s).map(p => ({ n: p.pts.length, closed: p.closed, area: pathArea(p.pts), inside: pointInPath(x, y, p.pts) }))
    }))
  };
}
