# Änderungen

## 0.2.4 Beta

**Sicherheit (bitte updaten)**
- **Trennen oder Programm schließen während eines Jobs:** die Maschine wird jetzt vorher sicher angehalten
  (GRBL: Vorschub-Halt, dann Reset – Laser/Spindel aus). Bisher fuhr sie den gepufferten G-Code noch zu Ende,
  und Laser/Spindel konnten danach eingeschaltet bleiben
- Texte von außen werden nicht mehr als HTML ausgeführt: USB-Gerätenamen, Firmware-Antworten von Boards,
  importierte Bibliotheken (Werkzeuge, Laser-Ebenen, Plasma-Schnitte) und eigene Sprachpakete können keinen
  Code mehr in die Oberfläche einschleusen
- `withGlobalTauri` ausgeschaltet (wurde nicht gebraucht)

**Neu**
- **Name der Maschine** im WLAN-Dialog (z. B. „laser-garage“): wird als Netzwerk-Name aufs Board geschrieben
  (Grbl_ESP32/MKS: [ESP112], FluidNC: $Hostname, grblHAL: $300) – auch ohne WLAN-Daten, nur zum Umbenennen.
  Die Maschine ist dann auch als laser-garage.local erreichbar
- **📡-Suche zeigt den Namen** jeder Maschine; Hinweis, wenn mehrere gleiche Boards nicht zu unterscheiden sind
- Verbindungs-Info zeigt den Namen im Netz
- **❤️ Unterstützen:** ❤️-Knopf oben rechts (Ko-fi und GitHub Sponsors), Abschnitt im ⓘ-Fenster und im README,
  „Sponsor“-Knopf auf GitHub; kleiner Hinweis nur nach dem 5., 25. und 100. fertigen Job, mit „Nicht mehr
  anzeigen“ – freiwillig, alle Funktionen bleiben für alle frei

**Verbessert**
- Neue IP automatisch finden: hat die Maschine einen eigenen Namen, wird nur die Maschine mit genau diesem Namen
  genommen – bei mehreren gleichen Boards verbindet sich die App nicht mehr versehentlich mit der falschen

**Projekt**
- CNC Craft steht offiziell unter **GPLv3** (LICENSE); THIRD_PARTY_NOTICES.md mit allen fremden Bestandteilen
  und ihren Quellen; PRIVACY.md (Datenschutz: keine Telemetrie, nur die abschaltbare Update-Prüfung)
- ⓘ-Fenster zeigt Lizenz und Datenschutz-Hinweis
- README: Abschnitte „Sicherheit und Haftung“, „Datenschutz“, „Code Signing Policy“ (Windows-Signierung über die
  SignPath Foundation ist beantragt)

## 0.2.3 Beta

**Neu**
- **📶 WLAN einrichten** (Reiter „Maschine“, bei Boards mit WLAN): Heimnetz oder eigenes WLAN des Boards setzen –
  auch mit Sonderzeichen, die GRBL unterwegs abfängt (! ? ~, Umlaute) oder als Kommentar liest (( ) ;):
  FluidNC bekommt sie %-kodiert, grblHAL schaltet sie kurz mit $39=0 frei, Grbl_ESP32/MKS DLC32 bekommen sie über
  die Weboberfläche des Boards. Das Passwort erscheint nie in der Konsole
- **Board-Auswahl im WLAN-Dialog:** Automatisch (erkannt), MKS DLC32 MAX / neuere MKS-Firmware ($50–$54),
  älteres MKS DLC32 / Grbl_ESP32 ([ESP100]), FluidNC, grblHAL – falls die Erkennung danebenliegt; wird gemerkt
- **MKS DLC32 MAX:** WLAN über die eigenen MKS-Einstellungen $50–$54 (per USB) bzw. [ESP401] über die
  Weboberfläche; die MAX wechselt sofort ins neue WLAN – danach prüft die App per USB, ob das Board angekommen
  ist, und zeigt seine neue IP (kein Neustart nötig)
- **WLANs in der Nähe auswählen:** das Board sucht selbst ([ESP410]) und zeigt die Netze mit Signalstärke und 🔒 –
  Namen anklicken statt abtippen
- **Erst-Einrichtung ohne IP:** Anleitung im Dialog über das eigene WLAN des Boards (MKS: „MKS_DLC…“,
  Passwort 12345678, 192.168.4.1), Knopf „WLAN des Boards einschalten“, 🔎 prüft vor dem Senden, ob das Board
  antwortet. Der Dialog liest per USB aus, ob das Board schon in einem WLAN hängt (dann wird dessen IP
  eingetragen) oder sein eigenes WLAN an hat, und prüft die Adresse alle paar Sekunden selbst
- **🏭 Werkseinstellung** im Reiter „Einstellungen ($$)“: Maschinen-Einstellungen ($RST=$), Nullpunkte ($RST=#)
  oder alles ($RST=*) zurücksetzen – vorher automatisch in eine Datei sichern, danach werden die Werte neu gelesen;
  Warnung, wenn „Alles“ bei ESP32-Boards die WLAN-Zugangsdaten löscht

**Verbessert**
- **WLAN-Suche 📡 zuverlässiger:** zuletzt benutzte/gefundene Adressen, Geräte aus der ARP-Tabelle und Namen wie
  fluidnc.local werden zuerst und mit langer Wartezeit geprüft (für „verschlafene“ ESP32-Boards); zu langsame
  Geräte werden ein zweites Mal gefragt; nur noch EINE Verbindung pro Port (ESP32-Telnet nimmt oft nur einen Client an)
- **Neue IP automatisch finden:** ist die Maschine unter der gespeicherten Adresse nicht erreichbar, sucht das
  Programm sie im Netz und verbindet sich mit der neuen Adresse (gleiche Firmware/gleicher Name wird bevorzugt)
- WLAN-Passwörter werden verdeckt: in der Konsole (z. B. bei $S) und im Einstellungs-Reiter ($52/$54)
- Fehlermeldungen beim WLAN-Senden zeigen die Antwort des Boards
- Konsole warnt bei Einstellungen mit Zeichen, die GRBL abfängt, statt ein verstümmeltes Passwort zu schicken

**Behoben**
- MKS DLC32 MAX: „Invalid $ statement“ beim WLAN-Senden ([ESP100]/[ESP101] gibt es dort nicht) und
  „Fehler 3 – Unbekannter $-Befehl“ beim Öffnen des WLAN-Dialogs ($AP/SSID)
- „Keine Antwort“ beim Umschalten des WLANs wurde als Fehler gemeldet, obwohl es geklappt hatte
- Einstellungen ($…) und ESP-Befehle ([ESP…]) werden unverändert gesendet – bisher wurden ( ) ; % und doppelte
  Leerzeichen entfernt (wie bei G-Code-Kommentaren)

## 0.2.2 Beta

**Neu**
- **Kamera 📷** (wie in LightBurn): frei verschiebbares Kamera-Fenster mit USB-Webcam oder IP-Kamera
  (ESP32-CAM, mjpg-streamer, Handy-App) – zuschauen, Foto speichern, Video aufnehmen, 180° drehen, spiegeln
- **Kamerabild auf der Arbeitsfläche:** entzerrt (Linse + Perspektive) unter der Zeichnung, live oder als
  Standbild – Teile genau aufs Material oder Reststück legen
- **Kamera ausrichten:** Assistent – Linse entzerren, dann 4 Punkte anklicken; der Laser kann dafür 4 Kreuze
  brennen (oder eigene Punkte wie die Bettecken), Lupe zum genauen Treffen, Prüfansicht mit 50-mm-Raster
- **Netzwerk-Suche 📡** (wie der IP-Finder in OpenBuilds): findet FluidNC, grblHAL, Grbl_ESP32 und
  MKS DLC32 im eigenen WLAN/LAN (Ports 23 und 8080, dazu 192.168.4.1 und xTool F1) – mit Firmware und
  Namen aus der Weboberfläche; Klick übernimmt die Adresse
- Ohne Port-Angabe wird beim Verbinden erst Port 23, dann 8080 (MKS-Original-Firmware) probiert
- macOS: Hinweistexte für die Erlaubnisse „Kamera“ und „Lokales Netzwerk“ (Info.plist, Entitlements)

**Behoben**
- Klick auf ⓘ (Info) oben rechts hat den aktuellen Reiter ausgeblendet

## 0.2.1 Beta

**Neu**
- **Bibliotheken sichern:** Fräswerkzeuge, Laser-Ebenen und Plasma-Schnitte als Datei exportieren
  und wieder importieren (Hinzufügen oder Ersetzen) – plus **Komplett-Sicherung** aller drei in einer
  Datei, z. B. vor einer Neuinstallation oder für einen zweiten Rechner
- **Laser-Bibliothek** und **Plasma-Bibliothek** als eigene Seite im Reiter „Werkzeuge“ (wechselt mit dem
  Modus), aufgebaut wie die Werkzeug-Bibliothek der Fräse: Liste, Kopieren, Reihenfolge, Standard (★),
  großer Editor mit Vorschau (Laser: Linie/Füllen mit Abstand und Winkel, DPI-Anzeige;
  Plasma: Seitenansicht mit Einstech- und Schneidhöhe, Anfahrt und Schnittspalt)
- Im Reiter oben **Fräse / Laser / Plasma umschalten** – zeigt jede Bibliothek, ohne den Maschinen-Modus zu ändern
- **Einstellungen überstehen Updates sicher:** alles wird zusätzlich als Datei im App-Datenordner
  gespeichert (eine Sicherung pro Tag, 14 Tage) und beim Start automatisch zurückgeholt, falls es fehlt.
  Der Ordner steht im Info-Fenster (ⓘ)
- Laser-Ebenen bekommen Material, Dicke und Notiz; Plasma-Schnitte Material, Blechdicke, Stromstärke und Notiz

## 0.2.0 Beta

**Neu**
- **3D-Modelle: STEP und 3MF** zusätzlich zu STL laden und als 2D-Kontur übernehmen
  (STEP über OpenCascade/occt-import-js, läuft im Hintergrund, ohne das Programm zu blockieren)
- **Anschlusspläne: Board-Auswahl** wie beim Board-Flasher (Liste nach Hersteller sortiert),
  neue Boards lassen sich einfach ergänzen
- **Update-Prüfung** über GitHub Releases (Info-Fenster ⓘ oben rechts): zeigt neue Versionen
  mit Änderungen und lädt die passende Datei für das eigene System herunter
- **Rechtes Panel in der Breite verstellbar** (Griff am linken Rand ziehen, Doppelklick = Standard),
  im CAM-Bereich und in der Simulation; die Breite wird gemerkt
- **Konsole in der Höhe verstellbar** (Oberkante ziehen, Doppelklick = Standard)

**Verbessert**
- Rechtes Panel ist standardmäßig breiter, die Konsole etwas kleiner – mehr Platz für die Einstellungen
- Anschlussplan-Seite lässt sich im Fenstermodus scrollen

**Bauen**
- Release-Workflow für macOS (Apple Silicon + Intel), Windows und Linux (GitHub Actions)

## 0.1.0 Beta

Erste öffentliche Beta: Design und CAM für Laser, Fräse und Plasma, Simulation, Maschinensteuerung
(GRBL/grblHAL/FluidNC, Marlin, Ruida, K40), Spindel/Laser/Plasma mit Overrides 10–200 % und THC,
Werkzeug-Bibliothek wie in Estlcam, Eingangs-Lämpchen für Endschalter und Taster,
Anschlusspläne, Board flashen, 7 Sprachen.
