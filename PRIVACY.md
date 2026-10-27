# Privacy Policy / Datenschutz – CNC Craft

**English**

CNC Craft does not collect, store or transmit any personal data. There is no telemetry, no analytics and no account.

This program will not transfer any information to other networked systems unless specifically requested by the
user or the person installing or operating it. The only exceptions are:

- **Update check:** once a day CNC Craft asks the public GitHub API (`api.github.com`) for the latest release
  version. No data about the user, their drawings or machines is sent; GitHub only sees the usual connection data
  (IP address). It can be turned off in the app: ⓘ (top right) → “Check automatically on start”.
- **The user's own devices:** connections to CNC machines (USB, Telnet/Wi-Fi), cameras and the 📡 network search
  only go to devices in the user's own local network and only when the user starts them.
- **Installing an update:** only when the user clicks “Update now”, the new version is downloaded from
  `github.com` (the project's release page).
- **Smart workshop devices:** if the user adds devices (e.g. Shelly, Tasmota, Home Assistant) under *Workshop (dust extractor, compressor …)*,
  CNC Craft sends the configured HTTP or MQTT messages to them when a job starts and ends. These connections are not
  encrypted (plain HTTP/MQTT), so only use them in your own local network. Passwords and keys for these devices are
  stored unencrypted in the local settings file.
- **Workshop sync:** if the user chooses a sync folder, the tool, laser and plasma libraries are written there. If
  that folder is inside a cloud service (Dropbox, OneDrive, iCloud …), the libraries are uploaded by that service.
- **Links** (firmware downloads, help pages) are only opened in the browser when the user clicks them.

All settings and libraries are stored locally on the user's computer (app data folder, shown in ⓘ).

**Deutsch**

CNC Craft sammelt, speichert und sendet keine persönlichen Daten – keine Telemetrie, keine Statistik, kein Konto.
Einzige automatische Verbindung ist die tägliche Update-Prüfung bei GitHub (abschaltbar unter ⓘ). Verbindungen zu
Maschinen, Kameras und die 📡-Suche gehen nur zu Geräten im eigenen Heimnetz und nur, wenn du sie startest.
Einstellungen und Bibliotheken bleiben auf deinem Rechner. „Jetzt aktualisieren“ lädt die neue Version von github.com.
Geräte der smarten Werkstatt (Shelly, Tasmota, Home Assistant …) bekommen unverschlüsselte HTTP-/MQTT-Nachrichten –
nur im eigenen Netz nutzen; ihre Passwörter/Schlüssel liegen unverschlüsselt in der Einstellungsdatei. Liegt der
Sync-Ordner der Werkstatt in einer Cloud (Dropbox, OneDrive …), lädt dieser Dienst die Bibliotheken hoch.

The privacy policy of the website is at https://andys-3d-world.github.io/cnc-craft/privacy.html
(Datenschutzerklärung der Webseite: https://andys-3d-world.github.io/cnc-craft/de/datenschutz.html).

Contact / Kontakt: https://github.com/Andys-3D-World/cnc-craft/issues
