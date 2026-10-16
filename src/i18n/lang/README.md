# Sprachpakete / Language packs

Jede Sprache ist eine JSON-Datei: `de.json`, `en.json`, `fr.json` …

```json
{
  "_code": "pt",
  "_name": "Português",
  "_author": "Dein Name",
  "rp.tabObject": "Objeto",
  "stl.loaded": "[STL] {n} triângulos …"
}
```

- `_code` = Sprachcode (2–3 Buchstaben), `_name` = Name in der eigenen Sprache.
- Platzhalter in `{geschweiften Klammern}` unverändert übernehmen.
- Fehlende Texte werden automatisch auf Englisch angezeigt.

**Neue Sprache ohne Programmieren:** In der App oben rechts im Sprachmenü
„Übersetzungs-Vorlage speichern…“ wählen, Datei übersetzen, `_code`/`_name`
anpassen und über „Sprachpaket laden…“ einlesen.

**Fest einbauen:** Datei hier ablegen und in `src/i18n/i18n.ts` importieren
und in `BUILTIN` eintragen.

---

Every language is one JSON file. Keep the `{placeholders}` unchanged.
Missing keys fall back to English. Use "Save translation template…" in the
language menu to get a file with all texts, translate it and load it with
"Load language pack…" – or add it here and register it in `src/i18n/i18n.ts`.
