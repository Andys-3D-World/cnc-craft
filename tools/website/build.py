# CNC Craft – Webseite erzeugen (GitHub Pages, Ordner docs/)
# Aufruf:  python3 tools/website/build.py docs
# Schreibt docs/index.html (Englisch), docs/de/index.html (Deutsch) und docs/sitemap.xml.
# Texte der Seite stehen unten in T; CSS kommt aus docs/assets/site.css und wird in die Seiten eingebettet.
# Bilder: docs/assets/img/<de|en>/<name>-<480|960|1800>.webp (aus docs/screenshots erzeugt)
import json, sys
OUT = sys.argv[1]
SITE = "https://andys-3d-world.github.io/cnc-craft/"
GH = "https://github.com/Andys-3D-World/cnc-craft"
REL = GH + "/releases/latest"

T = {
 "en": dict(
  base="", path="", ogimg="assets/og-en.png", shots="en",
  title="CNC Craft – free software for laser engravers, CNC routers & plasma cutters",
  desc="Free, open-source software for laser engravers, CNC routers and plasma cutters: design, CAM and machine control in one app. GRBL, grblHAL, FluidNC, Marlin, Ruida, K40. macOS, Windows, Linux.",
  nav=["Features", "Screenshots", "Download", "FAQ"], langlink=("de/", "Deutsch"),
  h1='Laser, CNC router &amp; plasma.<br><span>One free app.</span>',
  sub="Design, CAM and machine control in one program – no more switching between three programs. Open source, no subscription, no account.",
  chips=["100 % free", "Open source (GPL-3.0)", "macOS · Windows · Linux", "7 languages"],
  dl="Download", dlmac="Download for Mac", dlwin="Download for Windows", dllinux="Download for Linux (AppImage)",
  gh="★ Star on GitHub", note="Version", notemac="Mac with Apple chip (M1–M4). Intel Mac: see Download below.",
  notewin="Windows 10/11, 64-bit", notelinux="Other formats (.deb, .rpm): see Download below.",
  heroalt="CNC Craft with a drawing and router toolpaths",
  fh="Everything from drawing to the finished part", fl="Draw or import, create toolpaths, check the simulation and send the job – without switching between programs.",
  feats=[
   ("✏️", "Design &amp; import", "Draw shapes, text and Bézier curves or import SVG, DXF, PDF, PLT, images and 3D models (STL, 3MF, STEP)."),
   ("🖼️", "Image engraving", "Photos for the laser: 14 engraving styles (photo, lines, dot screen, newspaper, spiral …), auto enhance, remove background."),
   ("✂️", "Shape tools", "Combine, subtract and split shapes, round corners, pattern fill and dimensions that stay attached."),
   ("🗂️", "Several beds", "One project, many beds – spread parts like in a slicer and work through them bed by bed."),
   ("🛠️", "CAM for CNC routers", "Outside, inside, pocket and engrave with a tool library – as simple as in Estlcam."),
   ("🔦", "Laser layers", "Fill, line and cut with their own power and speed, lead-ins for cuts – like layers in LightBurn."),
   ("🔥", "Plasma cutting", "Kerf compensation, lead-ins, pierce points, sheet height probing and torch height control (THC)."),
   ("🎬", "3D simulation", "See every move, the time and the G-code before the machine starts."),
   ("🔌", "Machine control", "GRBL, grblHAL, FluidNC, Grbl_ESP32 via USB or Wi-Fi, Marlin, Ruida (CO₂) and K40. Several machines at once."),
   ("📷", "Camera", "USB or IP camera: watch the job and place your design on the live image of the workpiece."),
   ("📶", "Wi-Fi setup", "Find machines on the network and set up the board's Wi-Fi right from the app."),
   ("⚙️", "Board tools", "Machine settings ($$) explained in plain words, flash firmware (ESP32, Arduino, grblHAL .zip) and wiring diagrams with jumpers, DIP switches and external drivers."),
   ("♻️", "Remnant sheets", "Used areas are remembered – parts placed on them are not cut again."),
   ("🔒", "Private", "No telemetry, no account, no cloud. Your drawings stay on your computer."),
   ("🔄", "Updates in the app", "One click to update – signed updates straight from GitHub.")],
  nh="New in 0.3.0", nl="Image engraving with 14 styles and auto enhance, material preview, shape tools, Bézier curves, dimensions, several beds per project and new box types.",
  nlink="All changes", vid="whatsnew-en.mp4", vpost="en/08-image-engraving",
  ch="Built for makers", cl="CNC Craft combines what usually needs three programs:",
  cmp=["Design", "CAM", "Machine control", "CNC Craft"],
  sh="Screenshots", sl="Click a picture to enlarge it.",
  shotlist=[("01-design-router", "Design &amp; CAM", "drawing with router toolpaths"), ("02-simulation", "Simulation", "toolpaths in 3D with time and G-code"),
            ("03-laser", "Laser", "layers for engraving and cutting"), ("04-plasma", "Plasma", "cuts, pierce points and lead-ins"),
            ("05-wiring", "Wiring diagram", "jumpers for microsteps and a second Y motor"),
            ("06-mks-max", "MKS DLC32 MAX", "drawn like the real board, original connector colors"),
            ("07-external-drivers", "External drivers", "TB6600 / DM542 wiring – hover a wire to highlight it"),
            ("08-image-engraving", "Image engraving", "original and engraving side by side, auto enhance"),
            ("09-material-view", "Material preview", "how the job will look on birch plywood"),
            ("10-shape-tools", "Shape tools", "combined shape, Bézier curve and dimensions"),
            ("11-beds", "Several beds", "parts spread over three beds in one project")],
  dh="Download", dlead='Free for everyone. Latest version: <b data-version>see GitHub</b>. All files and older versions are on <a href="' + GH + '/releases">GitHub Releases</a>.',
  dcards=[("🍎 macOS", [("mac-arm", "Apple chip (M1–M4) · .dmg"), ("mac-intel", "Intel · .dmg")], "Not signed by Apple yet: on first start right-click the app → “Open”, or System Settings → Privacy &amp; Security → “Open Anyway”."),
          ("🪟 Windows", [("win", "Installer · .exe"), ("win-msi", "Installer · .msi")], "If Windows SmartScreen warns: “More info” → “Run anyway”."),
          ("🐧 Linux", [("appimage", "AppImage"), ("deb", "Debian/Ubuntu · .deb"), ("rpm", "Fedora/openSUSE · .rpm")], "AppImage: make it executable and start it.")],
  safety=("⚠️ Safety first", ["Never leave a laser running unattended – wear laser safety glasses and keep a fire extinguisher ready.",
          "Every machine needs a real hardware emergency stop. The stop buttons in the software do not replace it.",
          "Test new jobs without a workpiece or at low power first. CNC Craft is beta software and comes without warranty."]),
  fh2="Frequently asked questions",
  faq=[("Is CNC Craft really free?", "Yes. CNC Craft is open source under the GPL-3.0 license. All features are free, there is no paid version and no subscription."),
       ("Which machines and controllers are supported?", "Laser engravers, CNC routers and plasma cutters with GRBL, grblHAL, FluidNC or Grbl_ESP32 (USB and Wi-Fi), Marlin, Ruida CO₂ controllers and K40 lasers (M2 Nano). Boards like the MKS DLC32 and Arduino with CNC Shield are well tested."),
       ("Is it a replacement for LightBurn or Estlcam?", "CNC Craft is a free alternative with a similar workflow: laser layers like in LightBurn, router toolpaths like in Estlcam and machine control like in OpenBuilds. It is not affiliated with these products."),
       ("Does it run on Mac and Linux?", "Yes – macOS (Apple chip and Intel), Windows 10/11 and Linux (AppImage, .deb, .rpm)."),
       ("Is it still in development?", "Yes, CNC Craft is in beta and gets new features regularly. Bug reports and ideas are welcome on GitHub.")],
  suh="Support CNC Craft", sul="CNC Craft is free and stays free. If it helps you, you can support the development – or simply give it a star and tell others about it.",
  kofi="☕ Ko-fi", spons="💜 GitHub Sponsors", issues="🐞 Report a bug",
  foot=['Made by Andreas Piaszek – <a href="https://www.youtube.com/results?search_query=Andys+3D+World">Andys 3D World</a> on YouTube, TikTok and Instagram.',
        'Developed with the help of the AI tool <a href="https://claude.com/claude-code">Claude Code</a> by Anthropic; every change is reviewed and tested on real machines.',
        'Free software under the <a href="' + GH + '/blob/main/LICENSE">GNU GPL v3</a>. <a href="{legal}">Privacy</a>: no tracking and no cookies on this page.{imprint}',
        'Product names (LightBurn, Estlcam, OpenBuilds, MKS, Ruida …) belong to their owners and are only used to describe similar workflows and compatibility. CNC Craft is not affiliated with or endorsed by them.'],
 ),
 "de": dict(
  base="../", path="de/", ogimg="assets/og-de.png", shots="de",
  title="CNC Craft – kostenlose Software für Laser, CNC-Fräse und Plasma",
  desc="Kostenlose Open-Source-Software für Laser, CNC-Fräse und Plasma: Design, CAM und Maschinensteuerung in einem Programm. GRBL, grblHAL, FluidNC, Marlin, Ruida, K40. macOS, Windows, Linux.",
  nav=["Funktionen", "Bilder", "Download", "Fragen"], langlink=("../", "English"),
  h1='Laser, CNC-Fräse &amp; Plasma.<br><span>Ein kostenloses Programm.</span>',
  sub="Design, CAM und Maschinensteuerung in einem – kein Wechseln mehr zwischen drei Programmen. Open Source, ohne Abo, ohne Konto.",
  chips=["100 % kostenlos", "Open Source (GPL-3.0)", "macOS · Windows · Linux", "7 Sprachen"],
  dl="Herunterladen", dlmac="Für Mac herunterladen", dlwin="Für Windows herunterladen", dllinux="Für Linux herunterladen (AppImage)",
  gh="★ Stern auf GitHub", note="Version", notemac="Mac mit Apple-Chip (M1–M4). Intel-Mac: siehe Download weiter unten.",
  notewin="Windows 10/11, 64 Bit", notelinux="Andere Formate (.deb, .rpm): siehe Download weiter unten.",
  heroalt="CNC Craft mit Zeichnung und Fräsbahnen",
  fh="Alles von der Zeichnung bis zum fertigen Teil", fl="Zeichnen oder importieren, Bahnen erzeugen, Simulation prüfen und den Job senden – ohne zwischen Programmen zu wechseln.",
  feats=[
   ("✏️", "Zeichnen &amp; Importieren", "Formen, Text und Bézier-Kurven zeichnen oder SVG, DXF, PDF, PLT, Bilder und 3D-Modelle (STL, 3MF, STEP) laden."),
   ("🖼️", "Bildgravur", "Fotos für den Laser: 14 Gravurtypen (Foto, Linien, Punktraster, Zeitung, Spirale …), automatisch verbessern, Hintergrund entfernen."),
   ("✂️", "Form-Werkzeuge", "Formen verbinden, abziehen und zerschneiden, Ecken abrunden, Musterfüllung und Maße, die mitwandern."),
   ("🗂️", "Mehrere Betten", "Ein Projekt, viele Betten – Teile wie im Slicer verteilen und Bett für Bett abarbeiten."),
   ("🛠️", "CAM für CNC-Fräsen", "Außen, innen, Tasche und Gravur mit Werkzeug-Bibliothek – so einfach wie in Estlcam."),
   ("🔦", "Laser-Ebenen", "Füllen, Linie und Schneiden mit eigener Leistung und Geschwindigkeit, Freischnitt – wie Ebenen in LightBurn."),
   ("🔥", "Plasmaschneiden", "Schnittspalt, Anfahrbahnen, Einstichpunkte, Blechhöhe abtasten und Höhenregelung (THC)."),
   ("🎬", "3D-Simulation", "Jede Bewegung, die Zeit und den G-Code sehen, bevor die Maschine startet."),
   ("🔌", "Maschinensteuerung", "GRBL, grblHAL, FluidNC, Grbl_ESP32 per USB oder WLAN, Marlin, Ruida (CO₂) und K40. Mehrere Maschinen gleichzeitig."),
   ("📷", "Kamera", "USB- oder IP-Kamera: Job beobachten und die Zeichnung auf dem Livebild des Werkstücks platzieren."),
   ("📶", "WLAN einrichten", "Maschinen im Netzwerk finden und das WLAN des Boards direkt aus dem Programm einrichten."),
   ("⚙️", "Board-Werkzeuge", "Maschinen-Einstellungen ($$) verständlich erklärt, Firmware flashen (ESP32, Arduino, grblHAL-.zip) und Anschlusspläne mit Jumpern, DIP-Schaltern und externen Treibern."),
   ("♻️", "Restplatten", "Verbrauchte Flächen werden gemerkt – Teile darauf werden nicht noch einmal geschnitten."),
   ("🔒", "Privat", "Keine Telemetrie, kein Konto, keine Cloud. Deine Zeichnungen bleiben auf deinem Rechner."),
   ("🔄", "Updates im Programm", "Ein Klick zum Aktualisieren – unterschriebene Updates direkt von GitHub.")],
  nh="Neu in 0.3.0", nl="Bildgravur mit 14 Gravurtypen und „Automatisch verbessern“, Materialansicht, Form-Werkzeuge, Bézier-Kurven, Bemaßung, mehrere Betten pro Projekt und neue Kisten-Arten.",
  nlink="Alle Änderungen", vid="whatsnew-de.mp4", vpost="de/08-bildgravur",
  ch="Für Maker gebaut", cl="CNC Craft vereint, wofür man sonst drei Programme braucht:",
  cmp=["Design", "CAM", "Maschinensteuerung", "CNC Craft"],
  sh="Bilder", sl="Bild anklicken zum Vergrößern.",
  shotlist=[("01-design-fraese", "Design &amp; CAM", "Zeichnung mit Fräsbahnen"), ("02-simulation", "Simulation", "Fräsbahnen in 3D mit Zeit und G-Code"),
            ("03-laser", "Laser", "Ebenen zum Gravieren und Schneiden"), ("04-plasma", "Plasma", "Schnitte, Einstichpunkte und Anfahrbahnen"),
            ("05-anschluesse", "Anschlussplan", "Jumper für Mikroschritte und zweiten Y-Motor"),
            ("06-mks-max", "MKS DLC32 MAX", "wie das echte Board, Stecker in Original-Farben"),
            ("07-extern", "Externe Treiber", "TB6600 / DM542 anschließen – Maus aufs Kabel hebt es hervor"),
            ("08-bildgravur", "Bildgravur", "Original und Gravur nebeneinander, automatisch verbessern"),
            ("09-materialansicht", "Materialansicht", "so sieht der Job auf Birke-Sperrholz aus"),
            ("10-formen", "Form-Werkzeuge", "verbundene Form, Bézier-Kurve und Maße"),
            ("11-betten", "Mehrere Betten", "Teile auf drei Betten in einem Projekt verteilt")],
  dh="Download", dlead='Kostenlos für alle. Neueste Version: <b data-version>siehe GitHub</b>. Alle Dateien und ältere Versionen gibt es unter <a href="' + GH + '/releases">GitHub Releases</a>.',
  dcards=[("🍎 macOS", [("mac-arm", "Apple-Chip (M1–M4) · .dmg"), ("mac-intel", "Intel · .dmg")], "Noch nicht von Apple signiert: beim ersten Start Rechtsklick auf das Programm → „Öffnen“, oder Systemeinstellungen → Datenschutz &amp; Sicherheit → „Dennoch öffnen“."),
          ("🪟 Windows", [("win", "Installation · .exe"), ("win-msi", "Installation · .msi")], "Wenn Windows SmartScreen warnt: „Weitere Informationen“ → „Trotzdem ausführen“."),
          ("🐧 Linux", [("appimage", "AppImage"), ("deb", "Debian/Ubuntu · .deb"), ("rpm", "Fedora/openSUSE · .rpm")], "AppImage: ausführbar machen und starten.")],
  safety=("⚠️ Sicherheit zuerst", ["Laser nie unbeaufsichtigt laufen lassen – Laserschutzbrille tragen und Feuerlöscher bereithalten.",
          "Jede Maschine braucht einen echten Not-Aus-Schalter. Die Stopp-Knöpfe im Programm ersetzen ihn nicht.",
          "Neue Jobs zuerst ohne Werkstück oder mit wenig Leistung testen. CNC Craft ist eine Beta-Version ohne Gewährleistung."]),
  fh2="Häufige Fragen",
  faq=[("Ist CNC Craft wirklich kostenlos?", "Ja. CNC Craft ist Open Source unter der Lizenz GPL-3.0. Alle Funktionen sind frei, es gibt keine Bezahl-Version und kein Abo."),
       ("Welche Maschinen und Steuerungen werden unterstützt?", "Laser, CNC-Fräsen und Plasmaschneider mit GRBL, grblHAL, FluidNC oder Grbl_ESP32 (USB und WLAN), Marlin, Ruida-CO₂-Steuerungen und K40-Laser (M2 Nano). Boards wie MKS DLC32 und Arduino mit CNC Shield sind gut getestet."),
       ("Ersetzt es LightBurn oder Estlcam?", "CNC Craft ist eine kostenlose Alternative mit ähnlicher Arbeitsweise: Laser-Ebenen wie in LightBurn, Fräsbahnen wie in Estlcam und Maschinensteuerung wie in OpenBuilds. Es ist mit diesen Produkten nicht verbunden."),
       ("Läuft es auf Mac und Linux?", "Ja – macOS (Apple-Chip und Intel), Windows 10/11 und Linux (AppImage, .deb, .rpm)."),
       ("Wird es noch weiterentwickelt?", "Ja, CNC Craft ist in der Beta-Phase und bekommt regelmäßig neue Funktionen. Fehlermeldungen und Ideen sind auf GitHub willkommen.")],
  suh="CNC Craft unterstützen", sul="CNC Craft ist kostenlos und bleibt es. Wenn es dir hilft, kannst du die Entwicklung unterstützen – oder einfach einen Stern geben und es weitererzählen.",
  kofi="☕ Ko-fi", spons="💜 GitHub Sponsors", issues="🐞 Fehler melden",
  foot=['Gemacht von Andreas Piaszek – <a href="https://www.youtube.com/results?search_query=Andys+3D+World">Andys 3D World</a> auf YouTube, TikTok und Instagram.',
        'Entwickelt mit Hilfe des KI-Werkzeugs <a href="https://claude.com/claude-code">Claude Code</a> von Anthropic; jede Änderung wird geprüft und an echten Maschinen getestet.',
        'Freie Software unter der <a href="' + GH + '/blob/main/LICENSE">GNU GPL v3</a>. <a href="{legal}">Datenschutz</a>: kein Tracking und keine Cookies auf dieser Seite.{imprint}',
        'Produktnamen (LightBurn, Estlcam, OpenBuilds, MKS, Ruida …) gehören ihren Inhabern und beschreiben nur ähnliche Arbeitsweisen und Kompatibilität. CNC Craft ist mit ihnen nicht verbunden und wird von ihnen nicht unterstützt.'],
 ),
}

import re as _re
CSS = _re.sub(r"/\*.*?\*/", "", open(OUT + "/assets/site.css").read(), flags=_re.S)
CSS = _re.sub(r"\s*\n\s*", "", CSS)

def page(lang):
    t = T[lang]; b = t["base"]
    url = SITE + t["path"]
    ld = {"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "CNC Craft",
          "applicationCategory": "DesignApplication", "operatingSystem": "macOS, Windows, Linux",
          "description": t["desc"], "url": url, "downloadUrl": GH + "/releases", "license": "https://www.gnu.org/licenses/gpl-3.0.html",
          "image": SITE + t["ogimg"], "author": {"@type": "Person", "name": "Andreas Piaszek"},
          "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"}}
    faqld = {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in t["faq"]]}
    nav = t["nav"]
    feats = "\n".join(f'      <div class="card"><div class="ico">{i}</div><h3>{h}</h3><p>{p}</p></div>' for i, h, p in t["feats"])
    cmp = t["cmp"]
    compare = f'<span class="box">{cmp[0]}</span><span class="op">+</span><span class="box">{cmp[1]}</span><span class="op">+</span><span class="box">{cmp[2]}</span><span class="op">=</span><span class="box res">{cmp[3]}</span>'
    def pic(f, alt, sizes, extra=""):
        d = f'{b}assets/img/{t["shots"]}'
        return (f'<img src="{d}/{f}-960.webp" srcset="{d}/{f}-480.webp 480w, {d}/{f}-960.webp 960w, {d}/{f}-1800.webp 1800w" sizes="{sizes}" '
                f'data-full="{d}/{f}-1800.webp" alt="{alt}" width="1800" height="1125"{extra}>')
    lazy = ' loading="lazy" decoding="async"'
    shots = "\n".join("      <figure>" + pic(f, f"CNC Craft – {h}: {c}", "(max-width: 700px) calc(100vw - 32px), 540px", lazy) + f"<figcaption><b>{h}</b> – {c}</figcaption></figure>"
                      for f, h, c in t["shotlist"][1:])
    dcards = "\n".join(
        f'      <div class="card"><h3>{h}</h3>' + "".join(f'<a data-asset="{k}" href="{REL}">⬇ {lab}</a>' for k, lab in links) + f'<div class="hint">{hint}</div></div>'
        for h, links, hint in t["dcards"])
    faq = "\n".join(f'      <details class="card"><summary><b>{q}</b></summary><p style="margin-top:8px">{a}</p></details>' for q, a in t["faq"])
    safety = "".join(f"<li>{x}</li>" for x in t["safety"][1])
    legal = LEGAL[lang]["privacy"][0]
    imp = f' · <a href="{LEGAL[lang]["imprint"][0]}">{LEGAL[lang]["imprint"][1]}</a>' if CONTACT["address"] else ""
    foot = "\n".join(f"    <p>{x}</p>".replace("{legal}", legal).replace("{imprint}", imp) for x in t["foot"])
    chips = "".join(f'<span class="chip">{c}</span>' for c in t["chips"])
    first = t["shotlist"][0]
    return f'''<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="google-site-verification" content="izVhnJmeq4e1aORJ0nFrQnx2Yg6ycCgWRUR2bTXYxkI">
<title>{t["title"]}</title>
<meta name="description" content="{t["desc"]}">
<link rel="canonical" href="{url}">
<link rel="alternate" hreflang="en" href="{SITE}">
<link rel="alternate" hreflang="de" href="{SITE}de/">
<link rel="alternate" hreflang="x-default" href="{SITE}">
<link rel="icon" type="image/png" href="{b}assets/favicon.png">
<meta name="theme-color" content="#111019">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CNC Craft">
<meta property="og:title" content="{t["title"]}">
<meta property="og:description" content="{t["desc"]}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}{t["ogimg"]}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<style>{CSS}</style>
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
<script type="application/ld+json">{json.dumps(faqld, ensure_ascii=False)}</script>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="./"><img src="{b}assets/icon-68.webp" alt="" width="34" height="34">CNC <b>Craft</b></a>
    <nav class="nav">
      <a class="hide-sm" href="#features">{nav[0]}</a>
      <a class="hide-sm" href="#screenshots">{nav[1]}</a>
      <a href="#download">{nav[2]}</a>
      <a class="hide-sm" href="#faq">{nav[3]}</a>
      <a class="hide-sm" href="{GH}">GitHub</a>
      <a class="lang" href="{t["langlink"][0]}" hreflang="{"de" if lang == "en" else "en"}">{t["langlink"][1]}</a>
    </nav>
  </div>
</header>

<main>
<div class="hero">
  <div class="wrap">
    <h1>{t["h1"]}</h1>
    <p class="sub">{t["sub"]}</p>
    <div class="chips">{chips}</div>
    <div class="cta">
      <a id="dl-main" class="btn primary" href="#download" data-mac="{t["dlmac"]}" data-win="{t["dlwin"]}" data-linux="{t["dllinux"]}">⬇ <span>{t["dl"]}</span></a>
      <a class="btn" href="{GH}">{t["gh"]}</a>
    </div>
    <div class="dl-note">{t["note"]} <span data-version>0.2.8</span> <span id="dl-os-note" data-mac="{t["notemac"]}" data-win="{t["notewin"]}" data-linux="{t["notelinux"]}"></span></div>
    {pic(first[0], t["heroalt"], "(max-width: 1072px) calc(100vw - 32px), 1040px", ' class="hero-shot" fetchpriority="high"')}
  </div>
</div>

<section id="features">
  <div class="wrap">
    <h2>{t["fh"]}</h2>
    <p class="lead">{t["fl"]}</p>
    <div class="grid">
{feats}
    </div>
  </div>
</section>

<section id="new" class="alt">
  <div class="wrap">
    <h2>{t["nh"]}</h2>
    <p class="lead">{t["nl"]} <a href="{GH}/blob/main/CHANGELOG.md">{t["nlink"]} →</a></p>
    <video class="hero-shot" style="margin-top:0" src="{b}assets/video/{t["vid"]}" poster="{b}assets/img/{t["vpost"]}-960.webp" data-autoplay muted loop playsinline controls preload="none" width="1280" height="720"><track kind="captions" srclang="{lang}" label="{t["nh"]}" src="{b}assets/video/{t["vid"].replace(".mp4", ".vtt")}"></video>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>{t["ch"]}</h2>
    <p class="lead">{t["cl"]}</p>
    <div class="compare">{compare}</div>
  </div>
</section>

<section id="screenshots">
  <div class="wrap">
    <h2>{t["sh"]}</h2>
    <p class="lead">{t["sl"]}</p>
    <div class="shots">
{shots}
    </div>
  </div>
</section>

<section id="download" class="alt">
  <div class="wrap">
    <h2>{t["dh"]}</h2>
    <p class="lead">{t["dlead"]}</p>
    <div class="dl-grid">
{dcards}
    </div>
    <div class="warn" style="margin-top:28px">
      <h3>{t["safety"][0]}</h3>
      <ul>{safety}</ul>
    </div>
  </div>
</section>

<section id="faq">
  <div class="wrap">
    <h2>{t["fh2"]}</h2>
    <div class="grid" style="grid-template-columns:1fr">
{faq}
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <h2>{t["suh"]}</h2>
    <p class="lead">{t["sul"]}</p>
    <div class="cta" style="justify-content:flex-start">
      <a class="btn" href="https://ko-fi.com/andys3dworld">{t["kofi"]}</a>
      <a class="btn" href="https://github.com/sponsors/Andys-3D-World">{t["spons"]}</a>
      <a class="btn" href="{GH}">{t["gh"]}</a>
      <a class="btn" href="{GH}/issues">{t["issues"]}</a>
    </div>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
{foot}
  </div>
</footer>
<script src="{b}assets/site.js"></script>
</body>
</html>
'''

# Privacy policy and imprint of this website (the app has its own PRIVACY.md).
# The imprint page is only written once CONTACT["address"] is filled in (German law: § 5 DDG).
CONTACT = dict(
    name="Andreas Piaszek",
    address="",   # street, postcode, town – one line per entry separated by "<br>"
    email="",     # e-mail address for the imprint and privacy policy
)
LEGAL = {
 "en": dict(privacy=("privacy.html", "Privacy policy"), imprint=("imprint.html", "Imprint"), back="← Back to CNC Craft",
  body=lambda c: f'''
<h2>Who is responsible</h2>
<p>{c}</p>
<h2>Hosting</h2>
<p>This website is hosted by GitHub Pages (GitHub Inc., 88 Colin P. Kelly Jr. St, San Francisco, CA 94107, USA).
When you open a page, GitHub processes the usual connection data (IP address, time, requested page, browser) to deliver
the page and to keep the service secure. GitHub may process this data in the USA. Legal basis: Art. 6 (1) (f) GDPR
(legitimate interest in a reliable website). Details:
<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub Privacy Statement</a>.</p>
<h2>Latest version</h2>
<p>To show the current version and the right download links, the page asks the public GitHub API
(<code>api.github.com</code>) for the latest release. Your browser connects to GitHub for this; no other data is sent.</p>
<h2>No cookies, no tracking</h2>
<p>This website sets no cookies and uses no analytics, no tracking and no embedded third-party content.
Fonts, images and videos are served from this website itself.</p>
<h2>Links</h2>
<p>Links to GitHub, Ko-fi, GitHub Sponsors and YouTube only take effect when you click them. From then on, the privacy
policy of that website applies.</p>
<h2>The app</h2>
<p>What the CNC Craft program itself does (and does not) send is described in
<a href="{GH}/blob/main/PRIVACY.md">PRIVACY.md</a>.</p>
<h2>Your rights</h2>
<p>You have the right to information, correction, deletion and restriction of processing, to object and to data
portability, and to complain to a data protection supervisory authority. This website itself stores no personal
data; for data processed by GitHub, please contact GitHub.</p>'''),
 "de": dict(privacy=("datenschutz.html", "Datenschutzerklärung"), imprint=("impressum.html", "Impressum"), back="← Zurück zu CNC Craft",
  body=lambda c: f'''
<h2>Verantwortlich</h2>
<p>{c}</p>
<h2>Hosting</h2>
<p>Diese Webseite liegt bei GitHub Pages (GitHub Inc., 88 Colin P. Kelly Jr. St, San Francisco, CA 94107, USA).
Beim Aufruf einer Seite verarbeitet GitHub die üblichen Verbindungsdaten (IP-Adresse, Uhrzeit, aufgerufene Seite,
Browser), um die Seite auszuliefern und den Dienst abzusichern. GitHub kann diese Daten in den USA verarbeiten.
Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einer zuverlässigen Webseite). Mehr dazu:
<a href="https://docs.github.com/de/site-policy/privacy-policies/github-general-privacy-statement">Datenschutzerklärung von GitHub</a>.</p>
<h2>Aktuelle Version</h2>
<p>Damit die aktuelle Version und die passenden Download-Links angezeigt werden, fragt die Seite die öffentliche
GitHub-Schnittstelle (<code>api.github.com</code>) nach dem neuesten Release. Dein Browser verbindet sich dafür mit
GitHub; weitere Daten werden nicht gesendet.</p>
<h2>Keine Cookies, kein Tracking</h2>
<p>Diese Webseite setzt keine Cookies und nutzt keine Statistik, kein Tracking und keine eingebetteten Inhalte
anderer Anbieter. Schriften, Bilder und Videos kommen von dieser Webseite selbst.</p>
<h2>Links</h2>
<p>Links zu GitHub, Ko-fi, GitHub Sponsors und YouTube wirken erst, wenn du sie anklickst. Ab dann gilt die
Datenschutzerklärung der jeweiligen Seite.</p>
<h2>Das Programm</h2>
<p>Was das Programm CNC Craft selbst sendet (und was nicht), steht in
<a href="{GH}/blob/main/PRIVACY.md">PRIVACY.md</a>.</p>
<h2>Deine Rechte</h2>
<p>Du hast das Recht auf Auskunft, Berichtigung, Löschung und Einschränkung der Verarbeitung, auf Widerspruch und
Datenübertragbarkeit sowie auf Beschwerde bei einer Datenschutz-Aufsichtsbehörde. Diese Webseite selbst speichert
keine personenbezogenen Daten; für die bei GitHub verarbeiteten Daten wende dich bitte an GitHub.</p>'''),
}


def contact_html(with_address):
    parts = [CONTACT["name"]]
    if with_address and CONTACT["address"]:
        parts.append(CONTACT["address"])
    if CONTACT["email"]:
        parts.append(f'<a href="mailto:{CONTACT["email"]}">{CONTACT["email"]}</a>')
    else:
        parts.append(f'<a href="{GH}/issues">{GH}/issues</a>')
    return "<br>".join(parts)


def legal_page(lang, kind):
    t, L = T[lang], LEGAL[lang]
    b = t["base"]
    title = L[kind][1]
    if kind == "privacy":
        body = L["body"](contact_html(True))
    else:
        body = f'<h2>{"Angaben gemäß § 5 DDG" if lang == "de" else "Information according to § 5 DDG (German law)"}</h2><p>{contact_html(True)}</p>'
    return f'''<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} – CNC Craft</title>
<meta name="robots" content="noindex">
<link rel="icon" type="image/png" href="{b}assets/favicon.png">
<style>{CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <a class="brand" href="./"><img src="{b}assets/icon-68.webp" alt="" width="34" height="34">CNC <b>Craft</b></a>
  </div>
</header>
<main>
<section>
  <div class="wrap" style="max-width:760px">
    <h1 style="font-size:2rem">{title}</h1>
{body}
    <p style="margin-top:28px"><a href="./">{L["back"]}</a></p>
  </div>
</section>
</main>
</body>
</html>
'''


import os
os.makedirs(OUT + "/de", exist_ok=True)
for lang, folder in (("en", OUT), ("de", OUT + "/de")):
    open(folder + "/" + LEGAL[lang]["privacy"][0], "w").write(legal_page(lang, "privacy"))
    if CONTACT["address"]:
        open(folder + "/" + LEGAL[lang]["imprint"][0], "w").write(legal_page(lang, "imprint"))
    else:
        print(f"imprint ({lang}) not written – fill in CONTACT['address'] in tools/website/build.py")
open(OUT + "/index.html", "w").write(page("en"))
open(OUT + "/de/index.html", "w").write(page("de"))
import datetime
TODAY = datetime.date.today().isoformat()
open(OUT + "/sitemap.xml", "w").write(f'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>{SITE}</loc><lastmod>{TODAY}</lastmod><xhtml:link rel="alternate" hreflang="de" href="{SITE}de/"/><xhtml:link rel="alternate" hreflang="en" href="{SITE}"/></url>
  <url><loc>{SITE}de/</loc><lastmod>{TODAY}</lastmod><xhtml:link rel="alternate" hreflang="de" href="{SITE}de/"/><xhtml:link rel="alternate" hreflang="en" href="{SITE}"/></url>
</urlset>
''')
print("ok")
