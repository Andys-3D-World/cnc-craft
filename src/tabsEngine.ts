/**
 * Initialisiert die obere Open-Source Tab-Navigation der App
 */
export function initTabsEngine(redraw: () => void) {
  const tabButtons = document.querySelectorAll(".tab-navigation .tab-btn, .tab-navigation button");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      // 1. Alle Reiter deaktivieren
      tabButtons.forEach(b => b.classList.remove("active")); 
      // 2. Gewählten Reiter aktivieren
      btn.classList.add("active");

      // 3. Alle Inhalte ausblenden
      tabContents.forEach(c => c.classList.remove("active"));
      
      // 4. Passenden Inhalt einblenden
      const targetId = btn.getAttribute("data-tab");
      if (targetId) {
        document.getElementById(targetId)?.classList.add("active");
      }
      
      // 5. Gitter aktualisieren
      redraw();
    });
  });
}
