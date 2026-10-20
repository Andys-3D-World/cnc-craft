# Änderungen

## Nächste Version (noch nicht veröffentlicht)

**Neu**
- **Webseite** (GitHub Pages, Ordner `docs/`): Englisch und Deutsch, Download-Knopf mit der passenden Datei für
  Mac, Windows oder Linux, Funktionen, Bilder und häufige Fragen; ohne Tracking und ohne Cookies
- **grblHAL flashen:** im Reiter „Board flashen“ kann jetzt direkt die **.zip vom grblHAL Web Builder** gewählt werden.
  CNC Craft erkennt Bootloader, Partitionstabelle und Firmware mit ihren Adressen (ESP32: 0x1000, ESP32-S3: 0x0 /
  0x8000 / 0x10000) und flasht alles in einem Durchgang mit MD5-Prüfung. Gesperrt wird, wenn die Firmware für ein
  anderes Board gebaut ist (z. B. MAX-Firmware auf normalem DLC32), der Chip nicht passt oder der Flash zu klein ist.
  Neue Hilfe „grblHAL zusammenstellen“ mit dem genauen Board-Namen für den Web Builder (z. B. „MKS DLC32 MAX v1,
  8MB+ flash“)
- **grblHAL-Anleitung für die MKS DLC32 MAX im Reiter „Board flashen“** (jedes Board bekommt seine eigene, sie erscheint
  nur beim passenden Board): was im Web Builder auf welchem Reiter anzuhaken ist (General,
  Network/WebUI mit dem Hinweis, dass „Telnet server“ selbst angehakt werden muss, Plugins), was nach dem Flashen zu
  tun ist (USB, WLAN, Verbinden über Port 23) und wie die Weboberfläche aufs Board kommt (index.html.gz hochladen –
  nach jedem Flashen neu) – inkl. Login admin/admin bzw. user/user und Passwort ändern mit $330/$331
- **Zurück zur Original-Firmware der MKS DLC32 MAX:** eigener Abschnitt im Reiter „Board flashen“ – wo die Firmware
  bei Makerbase liegt (.rar erst auspacken), was danach zu tun ist (WLAN mit $50–$54 oder eigenes WLAN der MAX,
  Verbinden über Port 8080). Beide Anleitungen sind eingeklappt und werden nur bei Bedarf aufgeklappt
- **$$-Einstellungen für grblHAL:** die Seite fragt grblHAL nach seinen Einstellungen ($EG/$ES/$ESG) und zeigt sie
  nach den Gruppen des Boards (Spindel, Referenzfahrt, WLAN …) – mit passenden Feldern: Ja/Nein, Achsen-Masken,
  Optionen einzeln abhakbar, Auswahllisten, Passwörter verdeckt, Wertebereich und Hinweis „wirkt erst nach Neustart“.
  Wichtige Werte ($8 Doppelmotoren, Pull-ups, Spindel-PWM, $37, Referenzfahrt $43–$49, WLAN, $300, Werkzeugwechsel,
  Auto-Squaring …) sind in allen 7 Sprachen erklärt, die übrigen mit dem englischen Text von grblHAL. Wichtig:
  Werte wie $4, $21, $22 sind bei grblHAL Masken – die Seite schreibt sie jetzt richtig. Noch nicht an echten
  grblHAL-Boards getestet – Rückmeldungen willkommen
- **Anschlussplan – Motor A als X, Y oder Z:** beim CNC Shield V3 Schritt für Schritt, wie die zwei Jumper neben dem
  A-Steckplatz gesetzt werden (inkl. Warnung: „D12/D13“ nicht mit GRBL 1.1, kein Auto-Squaring). Bei der MKS DLC32 MAX:
  mit der MKS-Firmware ist A eine eigene Achse – für einen eigenen zweiten Motor (z. B. doppeltes X, Y mit
  Auto-Squaring) grblHAL über den grblHAL Web Builder (Board „MKS DLC32 MAX v1“, noch experimentell), Richtung mit $8

**Verbessert**
- README jetzt auf Englisch (Startseite bei GitHub, besser über Google zu finden), deutsche Fassung in `README.de.md`;
  englische README mit englischen Screenshots (`docs/screenshots/en/`);
  GitHub-Projekt mit Beschreibung, Themen (Topics) und Discussions
- README: neuer Abschnitt „Mitwirken“ – wie man helfen kann und offener Hinweis, dass beim Programmieren das
  KI-Werkzeug Claude Code hilft
- **Laser „Füllen + Linie“ mit getrennter Leistung:** die Fläche hat jetzt eigene Werte „Leistung (Füllen)“ und
  „Geschwindigkeit (Füllen)“ – z. B. leicht gravieren mit 30 % und schnell, danach kräftig schneiden mit 100 % und
  langsam. Leistung/Geschwindigkeit oben gelten dann für die Linie. Bestehende Ebenen behalten ihre bisherigen Werte

**Behoben**
- WLAN einrichten mit grblHAL: 📡 WLANs in der Nähe werden jetzt über die Weboberfläche des Boards geholt
  (über USB/Telnet kennt grblHAL das nicht, es kam „Fehler 1“). Geht es nicht, steht der genaue Grund da
- WLAN einrichten mit grblHAL: der Name der Maschine wird jetzt in $320 geschrieben (Name im Heimnetz bei ESP32-Boards) –
  vorher in $300, das nur für Kabel-Netzwerk gilt
- **$$-Seite:** Ja/Nein-Felder zeigten „Spindel an/aus“ statt „Ein/Aus“. Neben Haken-Feldern (Achsen-Masken,
  grblHAL-Optionen) steht jetzt zusätzlich der Gesamtwert als Zahl – zum Ansehen und direkt Eintippen
- **$$-Seite:** WLAN-Passwörter von grblHAL ($75/$77) wurden in der einfachen Ansicht offen angezeigt – jetzt in jeder
  Ansicht verdeckt. Außerdem bleiben die grblHAL-Beschreibungen beim Umschalten zwischen Maschinen erhalten (fehlen sie,
  werden sie einmal automatisch nachgeladen)
- **WLAN einrichten mit grblHAL:** schaltet jetzt auch Telnet ein ($70), falls es aus ist – ohne Telnet konnte CNC Craft
  die Maschine per WLAN nicht finden (grblHAL nutzt Port 23 statt 8080 wie die MKS-Firmware). Danach startet das Board
  mit $REBOOT neu
- grblHAL auf MKS-Boards: CNC Craft schickt kein `[ESP800]` mehr (gab „Fehler 1“ in der Konsole)
- Einstellungen nach dem Flashen zurückspielen: nach einem Firmware-Wechsel (z. B. MKS → grblHAL) werden nur noch die
  Werte geschrieben, die bei beiden dasselbe bedeuten – vorher konnten z. B. $40–$54 falsch belegt werden
- Flashen trennt nur noch die Verbindung, die genau diesen Port benutzt – andere Maschinen bleiben verbunden
- **📡-Suche trennte eine verbundene WLAN-Maschine:** ESP32-Boards (z. B. MKS DLC32) erlauben nur eine Verbindung –
  die Suche nach einer weiteren Maschine hat die bestehende rausgeworfen. Jetzt lässt die Suche verbundene Maschinen
  in Ruhe und zeigt sie als „verbunden als Maschine 1“ an
- Dieselbe Netzwerk-Maschine kann nicht mehr doppelt verbunden werden, auch nicht einmal per Name und einmal per IP
- Mehrere Maschinen: beim Umschalten zeigt das Port-Feld jetzt den Anschluss der ausgewählten Maschine
  (WLAN: „Netzwerk“ mit ihrer IP) – vorher stand dort noch der Port der zuletzt verbundenen

## 0.2.7 Beta

**Neu**
- **Mehrere Maschinen gleichzeitig:** im Reiter „Maschine“ mit „➕ Weitere Maschine“ eine zweite (dritte …)
  Maschine verbinden – z. B. Laser per USB und Fräse per WLAN. Die Liste zeigt alle Maschinen mit Status und
  Job-Fortschritt; anklicken = auswählen. Befehle, Joggen, Konsole, $$ und Jobs gehen immer an die ausgewählte
  Maschine, die anderen arbeiten im Hintergrund weiter. Beim Umschalten wechseln Maschinenart (Fräse/Laser/Plasma),
  Zeichenfläche und Profil automatisch mit. Meldungen aus dem Hintergrund stehen mit „[Maschine 2]“ in der Konsole,
  die Restplatte wird auch nach Hintergrund-Jobs eingetragen – bei der richtigen Maschinenart
- **⛔ Alle stoppen:** hält laufende Jobs auf allen verbundenen Maschinen sofort an (Laser/Spindel aus).
  Beim Schließen des Programms werden alle Maschinen sicher angehalten
- Ein Anschluss kann nicht zweimal verbunden werden (Meldung statt Durcheinander)

## 0.2.6 Beta

**Neu**
- **Update direkt aus der App:** im ⓘ-Fenster gibt es bei einer neuen Version „Jetzt aktualisieren“. CNC Craft lädt
  das Update selbst, prüft die Unterschrift, installiert es und startet neu – kein Deinstallieren, kein Herunterladen
  im Browser mehr. Auf dem Mac entfällt dabei das „Trotzdem öffnen“. Während ein Job läuft, ist es gesperrt.
  Wirkt ab dieser Version: auf diese Version bitte noch ein letztes Mal von Hand aktualisieren
- **G-Code-Icons in der linken Werkzeugleiste:** unten in der Leiste gibt es jetzt drei Icons für
  „G-Code erzeugen“, „G-Code speichern“ und „Simulation“ – gleiche Funktion wie die Knöpfe im rechten Panel
- **Verbrauchte Fläche wird nicht mehr geschnitten:** Formen, die auf schon verbrauchter Fläche der Platte liegen
  (rot markiert), kommen nicht mehr in den G-Code – auch nicht in Simulation, Rahmen-Fahrt und Job. Die Konsole sagt,
  wie viele weggelassen wurden. Bei Gruppen fällt die ganze Gruppe weg. Abschaltbar in „Material-Platte“ mit
  „Formen auf verbrauchter Fläche nicht schneiden“
- **Freischnitt beim Laser:** neue Einstellung „Freischnitt (Anfahrlänge)“ je Laser-Ebene (Linie). Bei geschlossenen
  Konturen startet der Laser so viele mm daneben im Abfall – außen vor dem Teil, bei Löchern im Loch – und fährt
  dann an einer Ecke auf die Kontur. So gibt es keinen Einbrandpunkt an der Kante. Standard 0 = aus.
  (Beim Plasma gibt es das schon: „Anfahrlänge (Lead-in)“ je Schnitt)

**Behoben**
- **Plasma mit „Blechhöhe abtasten“:** am Jobende wird die Z-Verschiebung vom Abtasten (G92) mit G92.1 wieder
  aufgehoben. Vorher blieb sie nach dem Job aktiv, und Z stimmte beim nächsten Job oder beim Fahren von Hand nicht

**Sicherheit**
- **Content-Security-Policy eingeschaltet:** die Oberfläche führt nur noch Programmcode aus, der zur App gehört.
  Selbst wenn einmal fremder Text (z. B. von einem Board oder aus einer Datei) als HTML landen sollte, kann er
  keinen Code mehr starten. Verbindungen ins Internet nur noch zur Update-Prüfung (GitHub); Kamerabilder aus dem
  Netz und der STEP-Import funktionieren weiter

**Projekt**
- README mit Bildern der App (Design, Simulation, Laser, Plasma, Anschlussplan)

## 0.2.5 Beta

**Sicherheit**
- **Dateirechte enger:** die App darf nur noch Dateien lesen und schreiben, die du selbst im Öffnen- oder
  Speichern-Dialog ausgewählt hast (vorher: jede Datei auf dem Rechner). Ziehen aufs Fenster geht weiter wie bisher
- Projekt speichern hängt „.cncc“ nicht mehr selbst an – die Endung kommt vom Speichern-Dialog

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
