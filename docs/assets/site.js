// CNC Craft – Webseite: passende Download-Datei der neuesten Version suchen, Bilder groß zeigen.
// Texte stehen in der Seite (data-Attribute), damit dieselbe Datei für jede Sprache passt.
(function () {
  var REPO = "Andys-3D-World/cnc-craft";
  var PATTERNS = {
    "mac-arm": /_aarch64\.dmg$/,
    "mac-intel": /_x64\.dmg$/,
    "win": /-setup\.exe$/,
    "win-msi": /\.msi$/,
    "appimage": /\.AppImage$/,
    "deb": /\.deb$/,
    "rpm": /\.rpm$/
  };

  function os() {
    var ua = navigator.userAgent || "";
    if (/Windows/i.test(ua)) return "win";
    if (/Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua)) return "mac";
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return "linux";
    return "";
  }

  function fill(rel) {
    var urls = {};
    (rel.assets || []).forEach(function (a) {
      for (var k in PATTERNS) if (!urls[k] && PATTERNS[k].test(a.name)) urls[k] = a.browser_download_url;
    });
    document.querySelectorAll("[data-asset]").forEach(function (el) {
      var u = urls[el.getAttribute("data-asset")];
      if (u) el.href = u;
    });
    var v = String(rel.tag_name || "").replace(/^v/, "");
    document.querySelectorAll("[data-version]").forEach(function (el) { el.textContent = v; });
    var main = document.getElementById("dl-main");
    var sys = os();
    var key = sys === "mac" ? "mac-arm" : sys === "linux" ? "appimage" : sys;
    if (main && key && urls[key]) {
      main.href = urls[key];
      var label = main.getAttribute("data-" + sys);
      if (label) main.querySelector("span").textContent = label.replace("{v}", v);
      var note = document.getElementById("dl-os-note");
      var txt = note && note.getAttribute("data-" + sys);
      if (txt) note.textContent = "· " + txt;
    }
  }

  // Neueste veröffentlichte Version (ohne Entwürfe). Klappt das nicht, bleiben die Links zur Release-Seite.
  fetch("https://api.github.com/repos/" + REPO + "/releases?per_page=5")
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (list) {
      var rel = (list || []).filter(function (r) { return !r.draft; })[0];
      if (rel) fill(rel);
    })
    .catch(function () { /* offline oder Limit erreicht */ });

  // Bilder anklicken = groß
  var zoom = document.createElement("div");
  zoom.className = "zoom";
  zoom.innerHTML = "<img alt=''>";
  document.body.appendChild(zoom);
  zoom.addEventListener("click", function () { zoom.classList.remove("on"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") zoom.classList.remove("on"); });
  document.querySelectorAll(".shots img").forEach(function (img) {
    img.addEventListener("click", function () {
      zoom.firstChild.src = img.getAttribute("data-full") || img.currentSrc || img.src;
      zoom.firstChild.alt = img.alt;
      zoom.classList.add("on");
    });
  });

  // Video erst laden und abspielen, wenn es zu sehen ist (spart beim Öffnen der Seite ~5 MB)
  var vids = document.querySelectorAll("video[data-autoplay]");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () { /* Autoplay gesperrt */ }); }
        else v.pause();
      });
    }, { threshold: 0.35 });
    vids.forEach(function (v) { io.observe(v); });
  }
})();
