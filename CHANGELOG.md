# Änderungen

## Nächste Version (noch nicht veröffentlicht)

**Neu**
- **📶 WLAN einrichten** (Reiter „Maschine“, bei Boards mit WLAN): Heimnetz oder eigenes WLAN des Boards setzen –
  auch mit Sonderzeichen, die GRBL unterwegs abfängt (! ? ~, Umlaute) oder als Kommentar liest (( ) ;):
  FluidNC bekommt sie %-kodiert, grblHAL schaltet sie kurz mit $39=0 frei, Grbl_ESP32/MKS DLC32 bekommen sie über
  die Weboberfläche des Boards. Das Passwort erscheint nie in der Konsole; Neustart-Knopf danach
- **WLANs in der Nähe auswählen:** das Board sucht selbst ([ESP410]) und zeigt die Netze mit Signalstärke und 🔒 –
  Namen anklicken statt abtippen
- **Erst-Einrichtung ohne IP:** Anleitung im Dialog über das eigene WLAN des Boards (MKS DLC32: „MKS_DLC“,
  Passwort 12345678, 192.168.4.1) – Name wird vom Board gelesen, Knopf „WLAN des Boards einschalten“,
  🔎 prüft vor dem Senden, ob das Board antwortet; Fehlermeldungen zeigen die Antwort des Boards
- **WLAN-Dialog zeigt, wo das Board gerade ist:** liest per USB aus, ob das Board schon in einem WLAN hängt
  (dann wird dessen IP eingetragen) oder sein eigenes WLAN an hat; prüft die Adresse alle paar Sekunden selbst
- **🏭 Werkseinstellung** im Reiter „Einstellungen ($$)“: Maschinen-Einstellungen ($RST=$), Nullpunkte ($RST=#)
  oder alles ($RST=*) zurücksetzen – vorher automatisch in eine Datei sichern, danach werden die Werte neu gelesen;
  Warnung, wenn „Alles“ bei ESP32-Boards die WLAN-Zugangsdaten löscht
- Konsole warnt bei Einstellungen mit solchen Zeichen, statt ein verstümmeltes Passwort zu schicken

**Behoben**
- WLAN-Dialog: MKS DLC32 MAX meldete „Fehler 3 – Unbekannter $-Befehl“ (Abfrage $AP/SSID kennt die Firmware nicht)
- Einstellungen ($…) und ESP-Befehle ([ESP…]) werden unverändert gesendet – bisher wurden ( ) ; % und doppelte
  Leerzeichen entfernt (wie bei G-Code-Kommentaren)

**Verbessert**
- **WLAN-Suche zuverlässiger:** zuletzt benutzte/gefundene Adressen, Geräte aus der ARP-Tabelle und Namen wie
  fluidnc.local werden zuerst und mit langer Wartezeit geprüft (für „verschlafene“ ESP32-Boards); Geräte, die
  bei der schnellen Runde zu langsam waren, werden ein zweites Mal gefragt; nur noch EINE Verbindung pro Port
  (ESP32-Telnet nimmt oft nur einen Client an)
- **Neue IP automatisch finden:** ist die Maschine unter der gespeicherten Adresse nicht erreichbar, sucht das
  Programm sie im Netz und verbindet sich mit der neuen Adresse (gleiche Firmware/gleicher Name wird bevorzugt)

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
