// Scenes for tools/website/screens.swift: put the app in the state shown on one screenshot.
const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const { state: st } = await import("/src/main.ts");
const redraw = () => window.dispatchEvent(new Event("cnc-redraw"));
const mode = i => { document.querySelectorAll(".ms-btn")[i].click(); };
const MILL = 0, LASER = 1, PLASMA = 2;
const rp = id => $(`.rp-tab[data-rp="${id}"]`).click();
const setDim = (id, v) => { const e = $("#" + id); e.value = String(v); e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };

/** Run a generator with its defaults and place the result; size w in mm, centre x/y in mm */
async function gen(cmd, x, y, w, setup) {
  const before = new Set(st.shapes.map(s => s.id));
  $(`[data-cmd="${cmd}"]`).click();
  await wait(350);
  if (setup) { setup(); await wait(250); }
  const btns = [...document.querySelectorAll(".dlg-overlay .dlg-box > .dlg-buttons button.btn-primary")];
  btns[btns.length - 1].click();
  await wait(350);
  st.selectedShapeIds = st.shapes.filter(s => !before.has(s.id)).map(s => s.id);
  redraw();
  await wait(150);
  rp("rp-object");
  $("#dim-lock-ratio").checked = true;
  if (w) setDim("dim-w", w);
  await wait(80);
  setDim("dim-x", x); await wait(50); setDim("dim-y", y);
  await wait(120);
}
const fit = async () => { $('[data-cmd="zoomFit"]').click(); await wait(250); };
const none = () => { st.selectedShapeIds = []; redraw(); };

async function landscape() {
  const c = document.createElement("canvas"); c.width = 1200; c.height = 800;
  const g = c.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, 520); sky.addColorStop(0, "#37495c"); sky.addColorStop(1, "#e6d9c2");
  g.fillStyle = sky; g.fillRect(0, 0, 1200, 800);
  const ridge = (col, base, peaks) => { g.fillStyle = col; g.beginPath(); g.moveTo(0, 800); g.lineTo(0, base); peaks.forEach(([x, y]) => g.lineTo(x, y)); g.lineTo(1200, base); g.lineTo(1200, 800); g.fill(); };
  ridge("#8c8f96", 470, [[180, 400], [330, 450], [560, 240], [700, 380], [860, 300], [1040, 430]]);
  ridge("#555b63", 540, [[150, 500], [340, 540], [520, 440], [700, 520], [900, 450], [1090, 530]]);
  const water = g.createLinearGradient(0, 560, 0, 800); water.addColorStop(0, "#b9b2a4"); water.addColorStop(1, "#2d333a");
  g.fillStyle = water; g.fillRect(0, 560, 1200, 240);
  const tree = (x, b, h) => { g.fillStyle = "#14181c"; for (let i = 0; i < 5; i++) { const y = b - h + i * h / 6, w = h * (0.1 + i * 0.07); g.beginPath(); g.moveTo(x, y); g.lineTo(x - w, y + h / 3); g.lineTo(x + w, y + h / 3); g.fill(); } g.fillRect(x - 4, b - 20, 8, 30); };
  [[110, 590, 190], [200, 600, 140], [40, 610, 150], [980, 600, 160], [1070, 590, 200], [1150, 610, 130]].forEach(a => tree(...a));
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const { importBytes } = await import("/src/importers/importManager.ts");
  importBytes("landscape.png", new Uint8Array(await blob.arrayBuffer())); // waits for the choice below
  await wait(700);
}

async function wiring(board, partKey) {
  $('.tab-navigation [data-tab="tab-wiring"]').click();
  await wait(300);
  const sel = $("#wiring-page select");
  if (board && sel) { sel.value = board; sel.dispatchEvent(new Event("change", { bubbles: true })); await wait(300); }
  if (partKey) { const b = $(`#wiring-page .wr-chip[data-comp="${partKey}"]`); if (!b) return "no chip " + partKey; b.click(); await wait(300); }
  return sel ? sel.value : "no select";
}

async function __scene(name) {
  document.head.insertAdjacentHTML("beforeend", "<style>#update-pill{display:none!important}</style>");
  if (name === "design") {
    mode(MILL); await wait(100);
    await gen("gear", 80, 150, 110);
    await gen("slotOrnament", 215, 150, 110);
    await fit();
    return st.shapes.length;
  }
  if (name === "simulation") {
    mode(MILL); await wait(100);
    await gen("gear", 80, 150, 110);
    await gen("vent", 215, 150, 110);
    $("#btn-to-machine").click();
    await wait(2500);
    return document.getElementById("job-progress-label").textContent;
  }
  if (name === "laser") {
    mode(LASER); await wait(100);
    await gen("nameGen", 150, 225, 240);
    await gen("mandala", 150, 90, 150);
    await fit();
    return st.shapes.length;
  }
  if (name === "plasma") {
    mode(PLASMA); await wait(100);
    await gen("gear", 85, 150, 130);
    await gen("vent", 220, 150, 120);
    await fit();
    rp("rp-object");
    return st.shapes.length;
  }
  if (name === "wiring") return wiring("mks-dlc32-v21");
  if (name === "max") return wiring("mks-dlc32-max");
  if (name === "external") return wiring("mks-dlc32-max", "extdrv");
  if (name === "engrave") { mode(LASER); await wait(100); await landscape(); $('.imguse-btn[data-how="engrave"]')?.click(); await wait(1500); return !!$(".dlg-overlay"); }
  if (name === "material") {
    mode(LASER); await wait(100);
    await gen("nameGen", 150, 225, 240);
    await gen("mandala", 150, 90, 150);
    none(); await fit();
    const m = $("#opt-material"); m.value = [...m.options].find(o => o.value !== "off")?.value; m.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(1200);
    return m.value;
  }
  if (name === "tools") {
    mode(MILL); await wait(100);
    await gen("gear", 80, 150, 110);
    await gen("slotOrnament", 215, 150, 110);
    await fit();
    $('.fly[data-fly="edit"]').dispatchEvent(new MouseEvent("mouseenter"));
    await wait(200);
    return !!$('.fly[data-fly="edit"].open');
  }
  if (name === "beds") {
    mode(LASER); await wait(100);
    await gen("mandala", 90, 150, 130);
    await gen("gear", 220, 150, 110);
    for (const [cmd, w] of [["boxgen", 240], ["puzzle", 220]]) {
      $('#bed-tabs [data-act="add"]').click(); await wait(300);
      await gen(cmd, 150, 150, w);
    }
    $('#bed-tabs .bed-tab[data-bed="0"]')?.click(); await wait(300);
    none(); await fit();
    return document.querySelectorAll("#bed-tabs .bed-tab").length;
  }
  return "unknown";
}
