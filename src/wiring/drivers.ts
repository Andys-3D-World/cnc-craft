/**
 * STECKBARE SCHRITTMOTOR-TREIBER – Mikroschritt-Einstellung
 *
 * M0/M1/M2 = Jumper unter dem Treiber (CNC Shield) bzw. DIP-Schalter 1/2/3 (MKS DLC32, ON = gesteckt).
 * Quellen: Datenblätter Allegro A4988, TI DRV8825, Trinamic TMC2208/TMC2209 (Standalone, MS1 = M0, MS2 = M1).
 * TMC2208/2209: M2 nie stecken (dort liegt PDN/UART) – die Treiber rechnen intern auf 1/256 hoch.
 */

export type DriverId = "a4988" | "drv8825" | "tmc2208" | "tmc2209";
export type Ms = [0 | 1, 0 | 1, 0 | 1];

export interface DriverInfo { id: DriverId; name: string; steps: { div: number; m: Ms }[]; std: number; tmc: boolean }

export const DRIVERS: DriverInfo[] = [
  { id: "a4988", name: "A4988", std: 16, tmc: false, steps: [
    { div: 1, m: [0, 0, 0] }, { div: 2, m: [1, 0, 0] }, { div: 4, m: [0, 1, 0] }, { div: 8, m: [1, 1, 0] }, { div: 16, m: [1, 1, 1] }] },
  { id: "drv8825", name: "DRV8825", std: 32, tmc: false, steps: [
    { div: 1, m: [0, 0, 0] }, { div: 2, m: [1, 0, 0] }, { div: 4, m: [0, 1, 0] }, { div: 8, m: [1, 1, 0] }, { div: 16, m: [0, 0, 1] }, { div: 32, m: [1, 0, 1] }] },
  { id: "tmc2208", name: "TMC2208", std: 16, tmc: true, steps: [
    { div: 2, m: [1, 0, 0] }, { div: 4, m: [0, 1, 0] }, { div: 8, m: [0, 0, 0] }, { div: 16, m: [1, 1, 0] }] },
  { id: "tmc2209", name: "TMC2209", std: 16, tmc: true, steps: [
    { div: 8, m: [0, 0, 0] }, { div: 16, m: [1, 1, 0] }, { div: 32, m: [1, 0, 0] }, { div: 64, m: [0, 1, 0] }] }
];

export function getDriver(id: string): DriverInfo {
  return DRIVERS.find(d => d.id === id) || DRIVERS[0];
}

/** Stellung für einen Teiler (gibt es den beim Treiber nicht: dessen Standard) */
export function msFor(d: DriverInfo, div: number): { div: number; m: Ms } {
  return d.steps.find(s => s.div === div) || d.steps.find(s => s.div === d.std) || d.steps[0];
}
