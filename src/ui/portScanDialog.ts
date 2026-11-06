/**
 * USB-SUCHE: Fenster für die Suche nach GRBL-Steuerungen an den USB-Ports.
 *
 * Startet erst nach dem Klick im Fenster (mit Hinweis): Das Öffnen eines Ports setzt viele Boards zurück.
 * Portnamen kommen vom Gerät → nur als Text einsetzen.
 */
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n/i18n";
import { portScan, portScanCancel, PortHit } from "../machine";

export function openPortScanDialog(bauds: number[], log: (s: string) => void, use: (hit: PortHit) => void) {
  document.getElementById("usb-find-overlay")?.remove();
  const ov = document.createElement("div");
  ov.id = "usb-find-overlay";
  ov.className = "dlg-overlay";
  ov.innerHTML = `
    <div class="dlg-box" role="dialog" style="width:460px;">
      <h3>${t("usb.title")}</h3>
      <div class="dlg-hint" style="color:var(--lt-amber, #ffb454);">${t("usb.warn")}</div>
      <div class="dlg-hint" id="usb-status"></div>
      <div id="usb-list" style="display:flex;flex-direction:column;gap:4px;"></div>
      <div class="dlg-buttons">
        <button type="button" class="btn-secondary" id="usb-close">${t("usb.close")}</button>
        <button type="button" class="btn-primary" id="usb-start">${t("usb.start")}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const status = ov.querySelector<HTMLElement>("#usb-status")!;
  const list = ov.querySelector<HTMLElement>("#usb-list")!;
  const start = ov.querySelector<HTMLButtonElement>("#usb-start")!;
  const closeBtn = ov.querySelector<HTMLButtonElement>("#usb-close")!;
  let running = false;
  const unlisten: (() => void)[] = [];
  const stopListening = () => { unlisten.splice(0).forEach(u => u()); };

  const close = () => {
    if (running) void portScanCancel().catch(() => {});
    stopListening();
    ov.remove();
  };
  ov.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") close(); });
  closeBtn.onclick = () => { if (running) void portScanCancel().catch(() => {}); else close(); };

  const addHit = (h: PortHit) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;";
    const label = document.createElement("span");
    label.style.flex = "1";
    label.textContent = `${h.port} · ${h.baud} Baud${h.firmware ? " · " + h.firmware : ""}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-primary btn-compact";
    b.textContent = t("usb.use");
    b.onclick = () => {
      if (running) return;
      close();
      use(h);
    };
    row.append(label, b);
    list.appendChild(row);
  };

  start.onclick = async () => {
    running = true;
    start.disabled = true;
    list.textContent = "";
    closeBtn.textContent = t("usb.cancel");
    status.textContent = t("usb.searching");
    try {
      unlisten.push(await listen<{ port: string; index: number; total: number; skipped: boolean }>("port-scan", e => {
        const p = e.payload;
        status.textContent = t(p.skipped ? "usb.skip" : "usb.trying", { port: p.port, i: p.index + 1, n: p.total });
      }));
      unlisten.push(await listen<PortHit>("port-scan-found", e => addHit(e.payload)));
      const hits = await portScan(bauds);
      status.textContent = hits.length ? t("usb.foundN", { n: hits.length }) : t("usb.none");
      log(status.textContent);
    } catch (e) {
      const k = "usb.err." + String(e);
      status.textContent = t(k) !== k ? t(k) : t("usb.failed", { e: String(e) });
      log(status.textContent);
    } finally {
      running = false;
      stopListening();
      start.disabled = false;
      closeBtn.textContent = t("usb.close");
    }
  };
}
