/**
 * IMPORT IN RUST, MIT DEM TYPESCRIPT GEPRÜFT
 *
 * Zu einem Leser in src/importers gibt es einen Zwilling in Rust (HPGL/G-Code: plotParse.ts ↔ src-tauri/src/importplt.rs).
 * Eingefügt wird weiter, was das TypeScript gelesen hat. In der App rechnet Rust danach im Hintergrund dasselbe, und das
 * Ergebnis wird verglichen: Anzahlen genau, Punkte auf 1e-9 mm (Bögen gehen über Sinus/Kosinus, deren letzte Stelle
 * abweichen darf). Eine Abweichung steht nur in der Konsole des Fensters und beim Entwickeln im Terminal.
 * Vorschau im Browser und Tests: ohne Rust, nichts wird geprüft.
 */
const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const TOL = 1e-9;
/** Gibt es Rust (die App)? Wer für den Vergleich erst etwas sammeln muss, fragt vorher */
export const importInApp = () => IN_TAURI;

/** Erste Stelle, an der a und b verschieden sind ("" = gleich); Zahlen dürfen um TOL abweichen */
export function importDiff(a: unknown, b: unknown, at = ""): string {
  // keine Zahl (NaN) kommt aus Rust als null an
  if (typeof a === "number" && Number.isNaN(a) && b === null) return "";
  if (typeof a === "number" && typeof b === "number") return a === b || Math.abs(a - b) <= TOL ? "" : `${at}: ${a} vs ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: ${a.length} vs ${b.length} entries`;
    for (let i = 0; i < a.length; i++) { const d = importDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return "";
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = importDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
      if (d) return d;
    }
    return "";
  }
  return a === b ? "" : `${at}: ${String(a)} vs ${String(b)}`;
}

/** Rust denselben Text lesen lassen und mit dem vergleichen, was das TypeScript gelesen hat (wartet nicht) */
export function checkImport(cmd: string, args: Record<string, unknown> | Uint8Array, ts: unknown) {
  if (!IN_TAURI) return;
  void (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const dev = !!(import.meta as any).env?.DEV;
    const t0 = performance.now();
    let rust: unknown;
    try { rust = await invoke(cmd, args); } catch (e) { console.warn(`import ${cmd} failed in Rust:`, e); return; }
    const d = importDiff(ts, rust);
    if (d) console.warn(`import ${cmd}: Rust reads it differently – ${d}`);
    if (dev) void invoke("dev_log", { text: `import ${cmd}: ${d ? `DIFFERENT from the TypeScript – ${d}` : "same as the TypeScript"} (${Math.round(performance.now() - t0)} ms with the comparison)` }).catch(() => {});
  })();
}
