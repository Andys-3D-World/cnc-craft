/**
 * GAMEPAD (Reiter "Maschine"): ein/aus, erkanntes Gamepad, Live-Anzeige, Belegung, Geschwindigkeit, Totzone
 * Die Steuerung selbst steht in gamepad.ts, die Regeln in gamepadLogic.ts.
 * Der Gamepad-Name kommt vom Gerät: nur über textContent ausgeben.
 */
import { t, T, tip } from "../i18n/i18n";
import { GamepadView, gamepadConfig, setGamepadConfig, setGamepadListener, initGamepad } from "../gamepad";
import { ACTIONS, GamepadAction, BUTTON_COUNT, SPEED_LEVELS, assignButton, buttonLabel } from "../gamepadLogic";

function options(withNone: boolean): string {
  let s = withNone ? `<option value="-1">—</option>` : "";
  for (let i = 0; i < BUTTON_COUNT; i++) s += `<option value="${i}">${buttonLabel(i)}</option>`;
  return s;
}

export function gamepadPanelHtml(): string {
  const row = (a: GamepadAction) =>
    `<label class="prop-row">${T("gp.act." + a)}<select class="gp-select" data-gp-action="${a}">${options(true)}</select></label>`;
  return `
    <div class="menu-section-unified" id="gp-section">
      <h3 class="menu-trigger">${T("gp.title")}</h3>
      <div class="menu-body rp-box">
        <div class="tool-scope">${T("gp.intro")}</div>
        <label class="prop-row" style="cursor:pointer;">${T("gp.enable")}<input type="checkbox" id="gp-enabled" style="width:auto;"></label>
        <div id="gp-status" class="gp-status"></div>
        <div id="gp-name" class="tool-scope"></div>
        <div id="gp-live" style="display:none;">
          <div id="gp-buttons" class="gp-buttons"></div>
          <div id="gp-axes" class="gp-axes" style="margin-top:4px;"></div>
        </div>
        <div id="gp-nonstd" class="tool-scope" style="display:none;">${T("gp.nonStandard")}</div>

        <div class="gp-head">${T("gp.moveHead")}</div>
        <label class="prop-row" ${tip("gp.deadmanTip")}>${T("gp.deadman")}<select class="gp-select" id="gp-deadman">${options(false)}</select></label>
        <label class="prop-row" ${tip("gp.maxFeedTip")}>${T("gp.maxFeed")}<input type="number" id="gp-maxfeed" class="prop-input" min="10" step="100"></label>
        <label class="prop-row" ${tip("gp.maxFeedZTip")}>${T("gp.maxFeedZ")}<input type="number" id="gp-maxfeedz" class="prop-input" min="10" step="50"></label>
        <label class="prop-row" ${tip("gp.deadzoneTip")}>${T("gp.deadzone")}<input type="number" id="gp-deadzone" class="prop-input" min="5" max="50" step="1"></label>
        <div id="gp-speed" class="tool-scope"></div>

        <div class="gp-head">${T("gp.buttonsHead")}</div>
        ${ACTIONS.map(row).join("")}
        <div class="tool-scope">${T("gp.safety")}</div>
      </div>
    </div>`;
}

export function initGamepadPanel(logFn: (s: string) => void) {
  initGamepad(logFn);
  const $ = <E extends HTMLElement>(id: string) => document.getElementById(id) as E | null;
  const section = $("gp-section");
  if (!section) return;
  const enabled = $<HTMLInputElement>("gp-enabled")!, deadman = $<HTMLSelectElement>("gp-deadman")!;
  const maxFeed = $<HTMLInputElement>("gp-maxfeed")!, maxFeedZ = $<HTMLInputElement>("gp-maxfeedz")!, zone = $<HTMLInputElement>("gp-deadzone")!;
  const actionSelects = Array.from(section.querySelectorAll<HTMLSelectElement>("select[data-gp-action]"));

  const fill = () => {
    const c = gamepadConfig();
    enabled.checked = c.enabled;
    deadman.value = String(c.deadman);
    maxFeed.value = String(c.maxFeed);
    maxFeedZ.value = String(c.maxFeedZ);
    zone.value = String(Math.round(c.deadzone * 100));
    for (const s of actionSelects) s.value = String(c.buttons[s.dataset.gpAction as GamepadAction]);
  };
  fill();

  enabled.addEventListener("change", () => setGamepadConfig({ ...gamepadConfig(), enabled: enabled.checked }));
  deadman.addEventListener("change", () => { setGamepadConfig(assignButton(gamepadConfig(), "deadman", parseInt(deadman.value, 10))); fill(); });
  for (const s of actionSelects) {
    s.addEventListener("change", () => { setGamepadConfig(assignButton(gamepadConfig(), s.dataset.gpAction as GamepadAction, parseInt(s.value, 10))); fill(); });
  }
  const numbers = () => {
    setGamepadConfig({ ...gamepadConfig(), maxFeed: parseFloat(maxFeed.value), maxFeedZ: parseFloat(maxFeedZ.value), deadzone: parseFloat(zone.value) / 100 });
    fill();
  };
  for (const el of [maxFeed, maxFeedZ, zone]) el.addEventListener("change", numbers);

  // ---- Live-Anzeige (nur ändern, was sich geändert hat) ----
  const status = $("gp-status")!, nameEl = $("gp-name")!, live = $("gp-live")!, nonStd = $("gp-nonstd")!;
  const btnBox = $("gp-buttons")!, axesBox = $("gp-axes")!, speed = $("gp-speed")!;
  let leds: HTMLElement[] = [], fills: HTMLElement[] = [];

  const build = (nButtons: number, nAxes: number) => {
    btnBox.textContent = ""; axesBox.textContent = "";
    leds = []; fills = [];
    for (let i = 0; i < nButtons; i++) {
      const el = document.createElement("span");
      el.className = "gp-led";
      el.textContent = String(i);
      el.title = buttonLabel(i);
      btnBox.appendChild(el); leds.push(el);
    }
    for (let i = 0; i < nAxes; i++) {
      const row = document.createElement("div");
      row.className = "gp-axis";
      row.textContent = String(i);
      const bar = document.createElement("div");
      bar.className = "gp-axis-bar";
      const f = document.createElement("div");
      f.className = "gp-axis-fill";
      bar.appendChild(f); row.appendChild(bar);
      axesBox.appendChild(row); fills.push(f);
    }
  };
  const setText = (el: HTMLElement, s: string) => { if (el.textContent !== s) el.textContent = s; };

  const render = (v: GamepadView | null) => {
    const c = gamepadConfig();
    const pad = v?.pad ?? null;
    let key: string, cls = "gp-status";
    if (v && !v.api) key = "gp.st.noApi";
    else if (!pad) key = "gp.st.noPad";
    else if (!c.enabled) key = "gp.st.off";
    else if (v?.reason) key = "gp.why." + v.reason;
    else if (v?.driving) { key = "gp.st.driving"; cls += " gp-driving"; }
    else { key = "gp.st.ready"; cls += " gp-ready"; }
    setText(status, t(key, { b: buttonLabel(c.deadman) }));
    if (status.className !== cls) status.className = cls;

    setText(nameEl, pad ? pad.id : "");
    live.style.display = pad ? "" : "none";
    nonStd.style.display = pad && !pad.standard ? "" : "none";
    const lv = v?.level ?? 1;
    setText(speed, t("gp.speed", { p: SPEED_LEVELS[lv] * 100, f: Math.round(SPEED_LEVELS[lv] * c.maxFeed), z: Math.round(SPEED_LEVELS[lv] * c.maxFeedZ) }));
    if (!pad) return;
    if (leds.length !== pad.buttons.length || fills.length !== pad.axes.length) build(pad.buttons.length, pad.axes.length);
    pad.buttons.forEach((b, i) => leds[i].classList.toggle("gp-on", b));
    pad.axes.forEach((a, i) => {
      const x = Math.max(-1, Math.min(1, Number.isFinite(a) ? a : 0)) * 50;
      fills[i].style.left = (x < 0 ? 50 + x : 50) + "%";
      fills[i].style.width = Math.abs(x) + "%";
    });
  };
  setGamepadListener(render, () => !section.classList.contains("collapsed") && section.getClientRects().length > 0);
  render(null);
  window.addEventListener("cnc-language-changed", () => render(null));
}
