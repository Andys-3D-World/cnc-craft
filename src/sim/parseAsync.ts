/**
 * G-CODE IM HINTERGRUND EINLESEN (Simulation): Große Programme liest parseWorker.ts in einem eigenen Thread,
 * so bleibt das Fenster bedienbar. Kleine Programme liest der Aufrufer weiter sofort (das Hin und Her
 * würde dort länger dauern als das Lesen). Geht der Thread nicht, wird im Hauptfenster gelesen – gleiches Ergebnis.
 */
import { parseGcodeProgram, type ParseOptions, type SimProgram } from "./gcodeParser";

/** Ab so vielen Zeilen lohnt der Hintergrund (Mac: etwa 0,05 s Lesezeit, auf alten Rechnern deutlich mehr) */
export const WORKER_MIN_LINES = 100_000;

interface Job { lines: string[]; opts: ParseOptions; done: (p: SimProgram) => void }

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const jobs = new Map<number, Job>();

/** Ohne Thread lesen (wie bisher) */
function readHere(j: Job) { j.done(parseGcodeProgram(j.lines, j.opts)); }

function startWorker(): Worker {
  const w = new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent) => {
    const job = jobs.get(ev.data?.id);
    if (!job) return;
    jobs.delete(ev.data.id);
    if (!ev.data.ok) { readHere(job); return; }
    job.done({ ...ev.data.prog, lines: job.lines });
  };
  w.onerror = (ev) => {
    ev.preventDefault();
    broken = true;
    w.terminate();
    worker = null;
    const open = [...jobs.values()];
    jobs.clear();
    open.forEach(readHere);
  };
  return w;
}

/** Liest `lines` im Hintergrund. Das Ergebnis enthält dieselben Zeilen (`lines`) wie übergeben. */
export function parseGcodeAsync(lines: string[], opts: ParseOptions = {}): Promise<SimProgram> {
  return new Promise(done => {
    const job: Job = { lines, opts, done };
    if (broken || typeof Worker === "undefined") { readHere(job); return; }
    try {
      worker ??= startWorker();
      const id = nextId++;
      jobs.set(id, job);
      // ein langer Text geht viel schneller zum Thread als Millionen einzelner Zeilen
      worker.postMessage({ id, text: lines.join("\n"), opts });
    } catch {
      broken = true;
      readHere(job);
    }
  });
}
