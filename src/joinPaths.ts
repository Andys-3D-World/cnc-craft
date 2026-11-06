/**
 * OFFENE PFADE ZU GESCHLOSSENEN VERBINDEN
 *
 * Ketten aus Pfaden, deren Enden höchstens `tol` auseinander liegen. Nur Ketten, die sich schließen, werden geliefert –
 * was offen bleibt, kommt unverändert zurück (mit der Lücke, die übrig ist). Keine Abhängigkeiten (Tests: `npm test`).
 *
 * keepGaps: jeder Punkt bleibt, wo er ist, die Lücke wird nur mit einem geraden Stück überbrückt (Befehl „Vektoren
 * schließen“). Ohne: Endpunkte werden aufeinander gezogen (Abstand höchstens tol, beim Wählen von Außen/Innen/Tasche).
 */
export interface P { x: number; y: number }
export interface JoinItem<T> { ref: T; pts: P[] }
export interface JoinResult<T> {
  closed: { pts: P[]; from: T[] }[];
  /** offen geblieben: Formen der Kette und Abstand ihrer Enden */
  left: { from: T[]; gap: number }[];
}

const d = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const SAME = 1e-6;

function area(p: P[]): number {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(s / 2);
}

export function joinChains<T>(input: JoinItem<T>[], tol: number, keepGaps = false): JoinResult<T> {
  const items = input.filter(i => i.pts.length >= 2);
  const used = items.map(() => false);
  const out: JoinResult<T> = { closed: [], left: [] };
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = items[i].pts.map(p => ({ x: p.x, y: p.y }));
    const from = [items[i].ref];
    let grew = true;
    while (grew && d(chain[0], chain[chain.length - 1]) > tol) {
      grew = false;
      const start = chain[0], end = chain[chain.length - 1];
      // das nächstgelegene Ende nehmen, nicht das erstbeste
      let best = -1, bestD = Infinity, how = 0;
      for (let j = 0; j < items.length; j++) {
        if (used[j]) continue;
        const q = items[j].pts, a = q[0], b = q[q.length - 1];
        const c = [d(end, a), d(end, b), d(start, b), d(start, a)];
        for (let k = 0; k < 4; k++) if (c[k] <= tol && c[k] < bestD) { bestD = c[k]; best = j; how = k; }
      }
      if (best < 0) break;
      const q = items[best].pts.map(p => ({ x: p.x, y: p.y }));
      if (how === 1 || how === 3) q.reverse();
      const front = how >= 2;
      // Beim Anhängen fällt der doppelte Punkt weg; mit keepGaps nur, wenn er wirklich derselbe ist
      const drop = !keepGaps || bestD < SAME;
      if (front) chain = (drop ? q.slice(0, -1) : q).concat(chain);
      else chain = chain.concat(drop ? q.slice(1) : q);
      used[best] = true;
      from.push(items[best].ref);
      grew = true;
    }
    const gap = d(chain[0], chain[chain.length - 1]);
    if (chain.length > 2 && gap <= tol) {
      if (!keepGaps || gap < SAME) chain.pop();
      // zwei gleiche Linien hin und zurück schließen nichts ein
      if (chain.length > 2 && area(chain) > Math.max(tol * tol, 1e-9)) { out.closed.push({ pts: chain, from }); continue; }
    }
    out.left.push({ from, gap });
  }
  return out;
}
