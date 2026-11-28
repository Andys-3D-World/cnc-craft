/**
 * VERKNÜPFTE KOPIEN IN RUST, MIT DEM TYPESCRIPT GEPRÜFT (linkedcopies.rs)
 *
 * Dieselben Aufrufe wie linkedCopies.ts; in der App rechnet Rust danach mit einem Abzug der Daten von vorher dasselbe
 * und vergleicht (Formen Feld für Feld, Zählungen). Verwendet wird weiter das Ergebnis aus dem TypeScript.
 * Nicht bei sehr großen Zeichnungen (über 4 MB JSON).
 */
import { checkImport, importInApp } from "../importers/importRust";
import { cleanLinks, refreshLinks, relinkRun, shapeIndex, syncLinks, type SyncResult } from "../linkedCopies";

const LIMIT = 4_000_000;
const copy = (v: unknown) => JSON.parse(JSON.stringify(v));

/** syncLinks (before = die Zeichnung vorher als JSON-Text, wie history.ts sie hat) */
export function syncChecked(shapes: any[], before: string, others: any[][]): SyncResult {
  const snap = importInApp() && before.length <= LIMIT ? JSON.stringify({ shapes, others }) : "";
  const r = syncLinks(shapes, JSON.parse(before), others);
  if (snap && snap.length + before.length <= LIMIT) {
    const { shapes: s0, others: o0 } = JSON.parse(snap);
    checkImport("link_check", { job: { kind: "sync", shapes: s0, before: JSON.parse(before), others: o0 } }, { shapes: copy(shapes), res: r });
  }
  return r;
}

/** refreshLinks(list, shapeIndex(lists)) – list darf eine der lists sein */
export function refreshChecked(list: any[], lists: any[][]): boolean {
  const same = lists.indexOf(list);
  const snap = importInApp() ? JSON.stringify({ lists, ...(same < 0 ? { list } : {}) }) : "";
  const changed = refreshLinks(list, shapeIndex(lists));
  if (snap && snap.length <= LIMIT) checkImport("link_check", { job: { kind: "refresh", same, ...JSON.parse(snap) } }, { list: copy(list), changed });
  return changed;
}

/** relinkRun – die neuen Ids des Fensters gehen mit, damit Rust dieselben vergibt */
export function relinkChecked(lists: any[][], oldParts: any[], made: any[], newId: () => string): void {
  const snap = importInApp() ? JSON.stringify({ lists, oldParts, made }) : "";
  const ids: string[] = [];
  relinkRun(lists, oldParts, made, () => { const id = newId(); ids.push(id); return id; });
  if (snap && snap.length <= LIMIT) checkImport("link_check", { job: { kind: "relink", ...JSON.parse(snap), ids } }, copy(lists));
}

/** cleanLinks (Projektdatei) */
export function cleanChecked(list: any[]): void {
  const snap = importInApp() ? JSON.stringify(list) : "";
  cleanLinks(list);
  if (snap && snap.length <= LIMIT) checkImport("link_check", { job: { kind: "clean", list: JSON.parse(snap) } }, copy(list));
}
