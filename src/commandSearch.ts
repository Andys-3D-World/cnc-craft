/**
 * BEFEHLSSUCHE: findet Befehle nach Namen, auch ohne Umlaute und Akzente. Kennt nur Texte, keine Oberfläche.
 */
export interface SearchItem { name: string; more?: string }

/** Kleinschreibung, ohne Akzente: „Fräsen“ = „frasen“, „Łuk“ = „luk“ */
export function foldText(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss").replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Punkte für einen Treffer, 0 = kein Treffer. Alle Suchwörter müssen vorkommen */
export function scoreItem(item: SearchItem, query: string): number {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const name = foldText(item.name), more = foldText(item.more || "");
  let total = 0;
  for (const w of words) {
    if (name.startsWith(w)) total += 100;
    else if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) total += 60;
    else if (name.includes(w)) total += 30;
    else if (more.includes(w)) total += 10;
    else return 0;
  }
  return total;
}

/** Treffer, die besten zuerst; bei gleichen Punkten nach Namen. Leere Suche: alles nach Namen */
export function searchItems<T extends SearchItem>(items: T[], query: string): T[] {
  return items
    .map(item => ({ item, score: scoreItem(item, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .map(x => x.item);
}
