/**
 * Obere Reiter der App. „Einrichten“ fasst die seltenen Seiten zusammen: Klick öffnet die zuletzt benutzte,
 * daneben stehen dann die Unterreiter.
 */
const LAST_SETUP = "cnc_craft_setup_tab";

export function initTabsEngine(redraw: () => void) {
  // nur echte Reiter (mit data-tab) – nicht die Knöpfe oben rechts (📷, ⓘ, Update …)
  const tabButtons = document.querySelectorAll<HTMLElement>(".tab-navigation [data-tab]");
  const tabContents = document.querySelectorAll(".tab-content");
  const setupBtn = document.getElementById("nav-setup");
  const setupNav = document.getElementById("setup-nav");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const inSetup = !!setupNav?.contains(btn);
      setupBtn?.classList.toggle("active", inSetup);
      if (setupNav) setupNav.style.display = inSetup ? "" : "none";
      if (inSetup) try { localStorage.setItem(LAST_SETUP, btn.dataset.tab!); } catch { /* egal */ }

      tabContents.forEach(c => c.classList.remove("active"));
      const targetId = btn.getAttribute("data-tab");
      if (targetId) document.getElementById(targetId)?.classList.add("active");

      redraw();
    });
  });

  setupBtn?.addEventListener("click", () => {
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_SETUP); } catch { /* egal */ }
    const target = setupNav?.querySelector<HTMLElement>(`[data-tab="${last}"]`) || setupNav?.querySelector<HTMLElement>("[data-tab]");
    target?.click();
  });
}
