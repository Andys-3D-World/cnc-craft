# OpenCascade für STEP-Import

`occt-import-js.js` / `occt-import-js.wasm` stammen unverändert aus
[occt-import-js](https://github.com/kovacsv/occt-import-js) (Version 0.0.24) und enthalten
[Open CASCADE Technology](https://www.opencascade.com). Beide stehen unter der
GNU LGPL 2.1 (siehe `license.occt-import-js.txt` und `license.occt.txt`).

Sie werden als eigene Dateien zur Laufzeit geladen (nicht in das Programm einkompiliert) und
können durch eine andere Version derselben Bibliothek ersetzt werden.
`cnc-step-worker.js` ist von CNC Craft und ruft nur `ReadStepFile` auf.
