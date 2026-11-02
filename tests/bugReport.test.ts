// Tests für den Fehlerbericht (persönliche Daten entfernen, GitHub-Adresse) – laufen mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, consoleTail, issueUrl, reportMarkdown, osOption, AREAS, SEVERITIES, MAX_URL, type BugReport } from "../src/bugReport.ts";

const report = (o: Partial<BugReport> = {}): BugReport => ({
  title: "Box generator crashes", what: "It crashes", steps: "1. Open box", expected: "No crash",
  area: AREAS[3], severity: SEVERITIES[2],
  info: { version: "0.3.5", os: "macos", arch: "aarch64", mode: "laser", board: "MKS DLC32 MAX", firmware: "Grbl_ESP32 1.0.10", connection: "net" },
  machine: true, consoleLines: ["ok", "> $I"], ...o
});

test("IP, MAC and e-mail addresses are hidden", () => {
  assert.equal(cleanText("Connected to 192.168.4.1:8080"), "Connected to <ip>:8080");
  assert.equal(cleanText("IP=10.0.0.25]"), "IP=<ip>]");
  assert.equal(cleanText("MAC 24:6F:28:AB:CD:EF"), "MAC <mac>");
  assert.equal(cleanText("fe80::1ff:fe23:4567:890a"), "<ip>");
  assert.equal(cleanText("mail me: max.muster@example.com"), "mail me: <email>");
  // Uhrzeiten und Koordinaten bleiben
  assert.equal(cleanText("12:30:45 <Idle|MPos:1.000,2.500,0.000|FS:0,0>"), "12:30:45 <Idle|MPos:1.000,2.500,0.000|FS:0,0>");
  assert.equal(cleanText("G1 X10.5 Y20 F1500"), "G1 X10.5 Y20 F1500");
});

test("Wi-Fi names, passwords and host names are hidden", () => {
  const i = cleanText("[MSG:Mode=STA:SSID=Fritz Box 7590:Status=Connected:IP=192.168.178.40:MAC=24-6F-28-AB-CD-EF]");
  assert.ok(!i.includes("Fritz"), i);
  assert.ok(!i.includes("192.168"), i);
  assert.ok(i.includes("Status=Connected"), i);
  assert.ok(!cleanText("$Sta/Password=geheim123").includes("geheim"));
  assert.ok(!cleanText("$Wifi STA PWD=geheim123").includes("geheim"));
  assert.ok(!cleanText("$Sta/SSID=Mein WLAN").includes("Mein"));
  assert.ok(!cleanText("$53=HomeNet").includes("HomeNet"));
  assert.ok(!cleanText("$54=supersecret").includes("supersecret"));
  assert.ok(!cleanText("$320=laser-garage").includes("garage"));
  assert.ok(!cleanText("[ESP101]geheim").includes("geheim"));
  assert.ok(!cleanText("[ESP401]P=53 T=S V=HomeNet").includes("HomeNet"));
  assert.ok(!cleanText("Hostname: laser-garage").includes("garage"));
  assert.ok(!cleanText("tcp://laser-garage:23").includes("garage"));
  assert.ok(!cleanText("http://mks_grbl.local/").includes("mks_grbl"));
  // normale GRBL-Einstellungen bleiben
  assert.equal(cleanText("$30=1000"), "$30=1000");
  assert.equal(cleanText("$110=5000.000"), "$110=5000.000");
});

test("user names in file paths are hidden", () => {
  assert.equal(cleanText("/Users/andreas/Desktop/box.svg"), "/Users/<user>/Desktop/box.svg");
  assert.equal(cleanText("/home/max/cnc/a.dxf"), "/home/<user>/cnc/a.dxf");
  assert.equal(cleanText("C:\\Users\\Max Muster\\x.svg"), "C:\\Users\\<user>\\x.svg");
  assert.equal(cleanText("C:\\Users\\max\\Documents\\x.svg"), "C:\\Users\\<user>\\Documents\\x.svg");
});

test("console tail keeps the last lines, cleaned", () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i} 192.168.0.${i}`);
  const tail = consoleTail(lines, 50);
  assert.equal(tail.length, 50);
  assert.equal(tail[0], "line 30 <ip>");
});

test("issue URL prefills the bug form fields", () => {
  const { url, full } = issueUrl(report());
  assert.ok(full);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://github.com/Andys-3D-World/cnc-craft/issues/new");
  const q = u.searchParams;
  assert.equal(q.get("template"), "bug_report.yml");
  assert.equal(q.get("title"), "[Bug] Box generator crashes");
  assert.equal(q.get("version"), "0.3.5 Beta");
  assert.equal(q.get("os"), "macOS (Apple chip)");
  assert.equal(q.get("machine"), "Laser · MKS DLC32 MAX · Grbl_ESP32 1.0.10");
  assert.equal(q.get("connection"), "Wi-Fi / network");
  assert.equal(q.get("area"), AREAS[3]);
  assert.equal(q.get("severity"), SEVERITIES[2]);
  assert.equal(q.get("console"), "ok\n> $I");
});

test("unticked info is not sent", () => {
  const q = new URL(issueUrl(report({ info: null, consoleLines: [] })).url).searchParams;
  for (const k of ["version", "os", "machine", "connection", "console"]) assert.equal(q.get(k), null, k);
  const q2 = new URL(issueUrl(report({ machine: false })).url).searchParams;
  assert.equal(q2.get("machine"), null);
  assert.equal(q2.get("version"), "0.3.5 Beta");
});

test("field ids match the GitHub bug form", async () => {
  const { readFileSync } = await import("node:fs");
  const yml = readFileSync(new URL("../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url), "utf8");
  for (const id of ["version", "os", "area", "severity", "what", "steps", "expected", "machine", "connection", "console"])
    assert.ok(yml.includes(`id: ${id}\n`), id);
  for (const v of [...AREAS, ...SEVERITIES, osOption("macos", "aarch64"), osOption("macos", "x86_64")])
    assert.ok(yml.includes(`- ${v}\n`), v);
});

test("long reports are shortened to fit the URL limit", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `ok äöü line ${i}`);
  const r = issueUrl(report({ consoleLines: lines }));
  assert.ok(r.url.length <= MAX_URL);
  assert.equal(r.full, false);
  // die neuesten Zeilen bleiben
  assert.ok(new URL(r.url).searchParams.get("console")!.endsWith("line 1999"));
  const huge = issueUrl(report({ what: "ä".repeat(20000), consoleLines: [] }));
  assert.ok(huge.url.length <= MAX_URL);
  assert.equal(huge.full, false);
});

test("markdown for the clipboard is cleaned", () => {
  const md = reportMarkdown(report({ what: "See /Users/andreas/x.svg at 192.168.1.2" }));
  assert.ok(md.includes("/Users/<user>/x.svg at <ip>"));
  assert.ok(md.includes("```text\nok\n> $I\n```"));
});
