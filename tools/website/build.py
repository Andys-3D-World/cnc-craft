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
  desc="Free, open-source alternative to LightBurn, Estlcam and OpenBuilds: design, CAM and machine control for laser, CNC router and plasma in one app. GRBL, grblHAL, FluidNC, Marlin, Ruida, K40. macOS, Windows, Linux.",
  nav=["Features", "Screenshots", "Download", "FAQ"], langlink=("de/", "Deutsch"),
  h1='Laser, CNC router &amp; plasma.<br><span>One free app.</span>',
  sub="Design, CAM and machine control in one program – like LightBurn, Estlcam and OpenBuilds together. Open source, no subscription, no account.",
  chips=["100 % free", "Open source (GPL-3.0)", "macOS · Windows · Linux", "7 languages"],
  dl="Download", dlmac="Download for Mac", dlwin="Download for Windows", dllinux="Download for Linux (AppImage)",
  gh="★ Star on GitHub", note="Version", notemac="Mac with Apple chip (M1–M4). Intel Mac: see Download below.",
  notewin="Windows 10/11, 64-bit", notelinux="Other formats (.deb, .rpm): see Download below.",
  heroalt="CNC Craft with a drawing and router toolpaths",
  fh="Everything from drawing to the finished part", fl="Draw or import, create toolpaths, check the simulation and send the job – without switching between programs.",
  feats=[
   ("✏️", "Design &amp; import", "Draw shapes and text or import SVG, DXF, PDF, PLT, images and 3D models (STL, 3MF, STEP)."),
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
  nh="New in 0.2.8", nl="Wiring diagrams that look like your real board, jumpers and DIP switches for microsteps, external drivers (TB6600), grblHAL flasher and more.",
  nlink="All changes", vid="whatsnew-en.mp4", vpost="en/05-wiring",
  ch="Built for makers", cl="CNC Craft combines what usually needs three programs:",
  cmp=["LightBurn", "Estlcam", "OpenBuilds", "CNC Craft"],
  sh="Screenshots", sl="Click a picture to enlarge it.",
  shotlist=[("01-design-router", "Design &amp; CAM", "drawing with router toolpaths"), ("02-simulation", "Simulation", "toolpaths in 3D with time and G-code"),
            ("03-laser", "Laser", "layers for engraving and cutting"), ("04-plasma", "Plasma", "cuts, pierce points and lead-ins"),
            ("05-wiring", "Wiring diagram", "jumpers for microsteps and a second Y motor"),
            ("06-mks-max", "MKS DLC32 MAX", "drawn like the real board, original connector colors"),
            ("07-external-drivers", "External drivers", "TB6600 / DM542 wiring – hover a wire to highlight it")],
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
        'Free software under the <a href="' + GH + '/blob/main/LICENSE">GNU GPL v3</a>. <a href="' + GH + '/blob/main/PRIVACY.md">Privacy</a>: no tracking and no cookies on this page.',
        'Product names (LightBurn, Estlcam, OpenBuilds, MKS, Ruida …) belong to their owners and are only used for comparison. CNC Craft is not affiliated with them.'],
 ),
 "de": dict(
  base="../", path="de/", ogimg="assets/og-de.png", shots="de",
  title="CNC Craft – kostenlose Software für Laser, CNC-Fräse und Plasma",
  desc="Kostenlose Open-Source-Alternative zu LightBurn, Estlcam und OpenBuilds: Design, CAM und Maschinensteuerung für Laser, CNC-Fräse und Plasma in einem Programm. GRBL, grblHAL, FluidNC, Marlin, Ruida, K40. macOS, Windows, Linux.",
  nav=["Funktionen", "Bilder", "Download", "Fragen"], langlink=("../", "English"),
  h1='Laser, CNC-Fräse &amp; Plasma.<br><span>Ein kostenloses Programm.</span>',
  sub="Design, CAM und Maschinensteuerung in einem – wie LightBurn, Estlcam und OpenBuilds zusammen. Open Source, ohne Abo, ohne Konto.",
  chips=["100 % kostenlos", "Open Source (GPL-3.0)", "macOS · Windows · Linux", "7 Sprachen"],
  dl="Herunterladen", dlmac="Für Mac herunterladen", dlwin="Für Windows herunterladen", dllinux="Für Linux herunterladen (AppImage)",
  gh="★ Stern auf GitHub", note="Version", notemac="Mac mit Apple-Chip (M1–M4). Intel-Mac: siehe Download weiter unten.",
  notewin="Windows 10/11, 64 Bit", notelinux="Andere Formate (.deb, .rpm): siehe Download weiter unten.",
  heroalt="CNC Craft mit Zeichnung und Fräsbahnen",
  fh="Alles von der Zeichnung bis zum fertigen Teil", fl="Zeichnen oder importieren, Bahnen erzeugen, Simulation prüfen und den Job senden – ohne zwischen Programmen zu wechseln.",
  feats=[
   ("✏️", "Zeichnen &amp; Importieren", "Formen und Text zeichnen oder SVG, DXF, PDF, PLT, Bilder und 3D-Modelle (STL, 3MF, STEP) laden."),
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
  nh="Neu in 0.2.8", nl="Anschlusspläne, die wie dein echtes Board aussehen, Jumper und DIP-Schalter für Mikroschritte, externe Treiber (TB6600), grblHAL-Flasher und mehr.",
  nlink="Alle Änderungen", vid="whatsnew-de.mp4", vpost="de/05-anschluesse",
  ch="Für Maker gebaut", cl="CNC Craft vereint, wofür man sonst drei Programme braucht:",
  cmp=["LightBurn", "Estlcam", "OpenBuilds", "CNC Craft"],
  sh="Bilder", sl="Bild anklicken zum Vergrößern.",
  shotlist=[("01-design-fraese", "Design &amp; CAM", "Zeichnung mit Fräsbahnen"), ("02-simulation", "Simulation", "Fräsbahnen in 3D mit Zeit und G-Code"),
            ("03-laser", "Laser", "Ebenen zum Gravieren und Schneiden"), ("04-plasma", "Plasma", "Schnitte, Einstichpunkte und Anfahrbahnen"),
            ("05-anschluesse", "Anschlussplan", "Jumper für Mikroschritte und zweiten Y-Motor"),
            ("06-mks-max", "MKS DLC32 MAX", "wie das echte Board, Stecker in Original-Farben"),
            ("07-extern", "Externe Treiber", "TB6600 / DM542 anschließen – Maus aufs Kabel hebt es hervor")],
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
        'Freie Software unter der <a href="' + GH + '/blob/main/LICENSE">GNU GPL v3</a>. <a href="' + GH + '/blob/main/PRIVACY.md">Datenschutz</a>: kein Tracking und keine Cookies auf dieser Seite.',
        'Produktnamen (LightBurn, Estlcam, OpenBuilds, MKS, Ruida …) gehören ihren Inhabern und dienen nur zum Vergleich. CNC Craft ist mit ihnen nicht verbunden.'],
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
    foot = "\n".join(f"    <p>{x}</p>" for x in t["foot"])
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

import os
os.makedirs(OUT + "/de", exist_ok=True)
open(OUT + "/index.html", "w").write(page("en"))
open(OUT + "/de/index.html", "w").write(page("de"))
open(OUT + "/sitemap.xml", "w").write(f'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>{SITE}</loc><xhtml:link rel="alternate" hreflang="de" href="{SITE}de/"/><xhtml:link rel="alternate" hreflang="en" href="{SITE}"/></url>
  <url><loc>{SITE}de/</loc><xhtml:link rel="alternate" hreflang="de" href="{SITE}de/"/><xhtml:link rel="alternate" hreflang="en" href="{SITE}"/></url>
</urlset>
''')
print("ok")
