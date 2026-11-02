# Contributing to CNC Craft

Thanks for wanting to help! There are many ways, and most need no programming:

- **Report bugs** and **suggest features** – use the [issue forms](https://github.com/Andys-3D-World/cnc-craft/issues/new/choose).
  English or German is fine.
- **Test with your machine** – especially boards and controllers that are not well tested yet.
- **Improve translations** – texts are in [`src/i18n/lang/`](src/i18n/lang), one JSON file per language.
- **Ask and answer questions**, show your projects in [Discussions](https://github.com/Andys-3D-World/cnc-craft/discussions).

## Code

CNC Craft is built with Tauri v2 (Rust) + Vite + TypeScript. See [Building from source](README.md#building-from-source).

Before you open a pull request:

```bash
npx tsc --noEmit          # types
npm test                  # JavaScript tests
cd src-tauri && cargo test  # Rust tests (if you changed Rust code)
```

Rules that keep the project in shape:

- **English** in code, comments, commit messages and the CHANGELOG.
- Every new or changed text goes into **all 7 language files** with the same key, and the UI uses `t("key")` –
  never hard-coded text.
- Add a line to `CHANGELOG.md` under "Next version (unreleased)" (groups: New / Improved / Fixed / Security).
- Never put text from outside (board answers, file names, imported files, Wi-Fi names) into `innerHTML` without
  `esc(...)`.
- Do not remove the safe stop when disconnecting during a job (`close_current()` in `src-tauri/src/lib.rs`).
- Keep pull requests small and focused – one feature or fix per pull request.

By contributing you agree that your contribution is licensed under the [GPL-3.0-or-later](LICENSE).
