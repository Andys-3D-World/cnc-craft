import { liveMachinePos } from "./render";
import { t } from "./i18n/i18n";

export function handleJogClick(
  btn: HTMLElement,
  getDistance: () => number,
  getFeedrate: () => number,
  isHomed: boolean,
  appendToConsole: (t: string) => void,
  triggerRedraw: () => void
) {
  if (!isHomed) {
    appendToConsole(t("jog.homeFirst"));
    return;
  }

  const cmdText = btn.getAttribute("data-cmd") || "";
  if (!cmdText) return;

  const distance = getDistance();
  const feed = getFeedrate();
  const parts = cmdText.split(" ");
  
  // Aktuelle Bett-Größen live aus den Eingabefeldern oben auslesen
  const bedWInput = document.getElementById("bed-w") as HTMLInputElement;
  const bedHInput = document.getElementById("bed-h") as HTMLInputElement;
  const maxW = bedWInput ? parseFloat(bedWInput.value) : 300;
  const maxH = bedHInput ? parseFloat(bedHInput.value) : 300; // FIX: War unnötig negiert und wurde nie benutzt

  let testX = liveMachinePos.x;
  let testY = liveMachinePos.y;
  let testZ = liveMachinePos.z;

  // Vorab berechnen, wo die Achsen landen würden
  parts.forEach(part => {
    const axis = part.charAt(0);
    const dir = parseInt(part.substring(1));
    if (axis === "X") testX += (dir * distance);
    if (axis === "Y") testY += (dir * distance);
    if (axis === "Z") testZ += (dir * distance);
  });

  // CRASH-SCHUTZ: Wenn die Zielkoordinaten außerhalb des Betts liegen, blockieren wir sofort!
  if (testX < 0 || testX > maxW) {
    appendToConsole(t("jog.blockedAxis", { axis: "X", v: testX.toFixed(1) }));
    return;
  }
  if (testY < 0 || testY > maxH) {
    appendToConsole(t("jog.blockedAxis", { axis: "Y", v: testY.toFixed(1) }));
    return;
  }
  // Z-Achsen Schutz: Verhindert das Aufknallen auf den Frästisch oder Überfahren nach oben
  if (testZ < -50 || testZ > 100) {
    appendToConsole(t("jog.blockedZ"));
    return;
  }

  // WENN ALLES SICHER IST: Koordinaten endgültig anwenden und absenden!
  liveMachinePos.x = testX;
  liveMachinePos.y = testY;
  liveMachinePos.z = testZ;

  let axisCommands: string[] = parts.map(part => {
    const axis = part.charAt(0);
    const dir = parseInt(part.substring(1));
    return `${axis}${(dir * distance).toFixed(2)}`;
  });

  const jogCommand = `$J=G91 F${feed} ${axisCommands.join(" ")}`;
  appendToConsole(`> ${jogCommand}`);
  
  // Digitale Zahlenleiste oben rechts aktualisieren
  const posXEl = document.getElementById("pos-x");
  const posYEl = document.getElementById("pos-y");
  const posZEl = document.getElementById("pos-z");
  if (posXEl) posXEl.textContent = liveMachinePos.x.toFixed(2);
  if (posYEl) posYEl.textContent = liveMachinePos.y.toFixed(2);
  if (posZEl) posZEl.textContent = liveMachinePos.z.toFixed(2);

  triggerRedraw();

  appendToConsole(t("m.demoJog"));
}