# Writes tests/fixtures/keepout-cases.json: shared cases for src/keepOut.ts and src-tauri/src/keepout.rs.
# Run:  python3 tests/fixtures/keepout-make.py   then   UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test keepout
import json, gzip, random, math
import os
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
def rect(x0, y0, x1, y1, h=10, m=5): return {"pts": [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}], "height": h, "margin": m}
def ring(cx, cy, r, n=24, h=10, m=5): return {"pts": [{"x": round(cx + r * math.cos(2 * math.pi * i / n), 4), "y": round(cy + r * math.sin(2 * math.pi * i / n), 4)} for i in range(n)], "height": h, "margin": m}
Z = [rect(40, -10, 60, 10)]
cases = []
def add(name, gcode, zones=Z, radius=1.5, note="(keep-out zone)"): cases.append({"name": name, "gcode": gcode, "zones": zones, "radius": radius, "note": note})
add("rapid through the zone", ["G21", "G90", "G0 Z5", "G0 X0 Y0", "G0 X100 Y0", "G1 Z-1 F100"])
add("rapid beside the zone", ["G0 Z20", "G0 X0 Y50", "G0 X100 Y50", "G0 Z5", "G0 X120 Y50"])
add("already high enough", ["G0 Z20", "G0 X0 Y0", "G0 X100 Y0"])
add("exactly at the safe height, a hair below", ["G0 Z15", "G0 X0 Y0", "G0 X100 Y0", "G0 Z14.999", "G0 X0 Y0"])
add("the cutter has a width: 1 mm beside, radius 1.5", ["G0 Z20", "G0 X0 Y11", "G0 Z5", "G0 X100 Y11"])
add("the cutter has a width: 1 mm beside, radius 0.5", ["G0 Z20", "G0 X0 Y11", "G0 Z5", "G0 X100 Y11"], radius=0.5)
add("touching exactly: distance equals the radius", ["G0 Z20", "G0 X0 Y11.5", "G0 Z5", "G0 X100 Y11.5", "G0 X0 Y11.501"])
add("negative radius counts as zero", ["G0 Z20", "G0 X0 Y10.2", "G0 Z5", "G0 X100 Y10.2", "G0 X0 Y9.9"], radius=-3)
add("position unknown at the start: every zone counts", ["G0 X200 Y200", "G0 Z5", "G0 X210 Y200"])
add("position unknown after M0, M1, M6", ["G0 Z20", "G0 X0 Y50", "G0 Z5", "M0 (tool change)", "G0 X10 Y50", "G0 Z5", "M1", "G0 X20 Y50", "M6 T2", "G0 X30 Y50", "M5", "G0 X35 Y50", "M30"])
add("G53, G28, G30, G38: position unknown afterwards", ["G0 Z20", "G0 X0 Y50", "G0 Z5", "G53 G0 Z0", "G0 X10 Y50", "G0 Z5", "G28", "G0 X20 Y50", "G0 Z5", "G30 X1", "G0 X0 Y50", "G0 Z5", "G38.2 Z-10 F50", "G0 X5 Y50"])
add("G10 and G92: unsure", ["G0 Z20", "G0 X0 Y50", "G10 L20 P1 X0 Y0", "G0 X10 Y50"])
add("G92 and G92.1", ["G0 Z20", "G92 X0 Y0", "G0 X10 Y50", "G92.1", "G0 X0 Y0"])
add("relative moves: unsure, nothing is changed while G91", ["G0 Z5", "G0 X0 Y0", "G91", "G0 X100", "G1 X-50 Z-1", "G90", "G0 X0 Y0", "G0 Z5", "G0 X100 Y0"])
add("inches", ["G20", "G0 Z0.2", "G0 X0 Y0", "G0 X4 Y0", "G1 Z-0.04 F10", "G1 X2 Y0", "G21", "G0 Z5", "G0 X0 Y0"])
add("rapid with X, Y and Z in one line is split", ["G0 X0 Y0 Z5", "G0 X100 Y0 Z2", "G0 X0 Z-1", "G0 Y40 Z20", "G0 Z3 X100"])
add("rapid with Z only: coming down inside a zone", ["G0 Z20", "G0 X50 Y0", "G0 Z5", "G0 Z12", "G0 Z9", "G0 Z9.5", "G0 Z3"])
add("rapid that ends low inside a zone is reported", ["G0 Z5", "G0 X50 Y0", "(--- shape 1: CIRCLE inside ---)", "G0 X51 Y0", "G0 X100 Y0", "G0 X50 Y1 Z2"])
add("modal moves without a G word", ["G0 Z5", "X0 Y0", "X100", "G1 Z-1 F100", "X50", "Y30", "G0 Z5", "X0 Y0"])
add("cut into a zone is reported once per shape", ["G0 Z20", "G0 X0 Y0", "(--- shape 2: POLYLINE outside ---)", "G1 Z-1 F100", "G1 X50 Y0", "G1 X55 Y0", "G0 Z20", "(--- shape 3: LINE on-line ---)", "G0 X0 Y5", "G1 Z-1", "G1 X100 Y5", "G1 X0 Y5", "(--- shape 2: POLYLINE outside ---)", "G1 X50"])
add("cut above the zone is fine, at its height too", ["G0 Z20", "G0 X0 Y0", "G1 Z12 F100", "G1 X100", "G1 Z10", "G1 X0", "G1 Z9.999", "G1 X100"])
add("cut without a known height is not judged", ["G0 X0 Y0", "G1 X100 Y0 F300", "G1 Z-1", "G1 X0"])
add("plunge inside the zone", ["G0 Z20", "G0 X50 Y0", "G1 Z5 F100", "G1 Z20", "G0 X0 Y0"])
add("arc clockwise through the zone (I J)", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G2 X100 Y0 I50 J0", "G0 Z20"])
add("arc counter-clockwise around the zone (I J)", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G3 X100 Y0 I50 J0", "G0 Z20"], zones=[rect(40, 30, 60, 60)])
add("arc clockwise misses the zone on the other side", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G2 X100 Y0 I50 J0", "G0 Z20"], zones=[rect(40, -60, 60, -30)])
add("full circle", ["G0 Z20", "G0 X20 Y0", "G1 Z-1 F100", "G2 X20 Y0 I30 J0", "G3 X20 Y0 I30 J0", "G0 Z20"], zones=[rect(75, -5, 85, 5)])
add("arc with R: short and long way, both directions", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G2 X40 Y0 R25", "G2 X0 Y0 R-25", "G3 X40 Y0 R25", "G3 X0 Y0 R-25", "G2 X0 Y0 R10", "G0 Z20"], zones=[rect(15, 30, 25, 44), rect(15, -44, 25, -30)])
add("arc with R too small for the distance", ["G0 Z20", "G0 X0 Y0", "G1 Z-1", "G2 X100 Y0 R10", "G0 Z20"])
add("arc with R and I: I and J win", ["G0 Z20", "G0 X0 Y0", "G1 Z-1", "G2 X100 Y0 R500 I50", "G0 Z20"], zones=[rect(40, 40, 60, 60)])
add("arc in another plane is a straight line here", ["G0 Z20", "G0 X0 Y0", "G18", "G1 Z-1", "G2 X100 Y0 I50 K0", "G17", "G3 X0 Y0 I-50 J0", "G19", "G2 X100 I50", "G0 Z20"], zones=[rect(40, 30, 60, 60)])
add("arc without a known start", ["G1 Z-1 F100", "G2 X100 Y0 I50 J0", "G2 X0 Y0 I-50 J0"])
add("helix: arc with Z", ["G0 Z20", "G0 X0 Y0", "G1 Z11", "G2 X100 Y0 Z9 I50 J0", "G0 Z20", "G0 X0 Y0", "G1 Z12", "G2 X100 Y0 Z10 I50 J0"])
add("several zones of different heights", ["G0 Z8", "G0 X0 Y0", "G0 X200 Y0", "G0 X0 Y0", "G0 Z30", "G0 X200 Y0", "G0 Z12", "G0 X0 Y0", "G0 X70 Y0", "G0 X200 Y0"],
    zones=[rect(40, -10, 60, 10, 5, 2), rect(100, -10, 120, 10, 20, 5), rect(160, -10, 180, 10, 10, 0)])
add("zones with fewer than three points are left out (numbering follows)", ["G0 Z20", "G0 X0 Y0", "(--- A ---)", "G1 Z-1", "G1 X200 Y0"],
    zones=[{"pts": [], "height": 10, "margin": 5}, rect(40, -10, 60, 10), {"pts": [{"x": 0, "y": 0}, {"x": 1, "y": 1}], "height": 10, "margin": 5}, rect(100, -10, 120, 10)])
add("no usable zone: the program stays untouched", ["G0 X0 Y0", "g0 x100", "  (x)  ", ""], zones=[{"pts": [{"x": 0, "y": 0}, {"x": 1, "y": 1}], "height": 10, "margin": 5}])
add("round zone", ["G0 Z5", "G0 X0 Y0", "G0 X100 Y0", "G0 X100 Y21.6", "G0 X0 Y21.6", "G0 X0 Y21.4", "G0 X100 Y21.4", "(--- hole ---)", "G1 Z-2 F100", "G1 X50 Y19"], zones=[ring(50, 0, 20)])
add("concave zone: straight through the notch", ["G0 Z5", "G0 X-10 Y25", "G0 X50 Y25", "G0 X50 Y45", "G0 X25 Y45", "G0 X25 Y12", "G0 X25 Y8"],
    zones=[{"pts": [{"x": 0, "y": 0}, {"x": 60, "y": 0}, {"x": 60, "y": 10}, {"x": 10, "y": 10}, {"x": 10, "y": 40}, {"x": 60, "y": 40}, {"x": 60, "y": 50}, {"x": 0, "y": 50}], "height": 10, "margin": 5}])
add("move that starts or ends inside the zone, zero-length move", ["G0 Z5", "G0 X50 Y0", "G0 X50 Y0", "G0 X0 Y0", "G0 X50 Y0", "G0 X51 Y1"])
add("comments, lower case, line numbers, words without spaces", ["n10 g0 z5 (start)", "N20G0X0Y0", "g0x100y0 ; cross", "(g0 x0 y0)", "G0 (in between) X0", "; G0 X100", "G1Z-1F100", "g1 x 50 y 0", "G0 Z 5", "N30 M0", "N40 G0 X5"])
add("numbers: leading dot, plus, trailing dot, minus zero, many decimals", ["G0 Z5.", "G0 X.5 Y+.25", "G0 X+100 Y-0", "G0 X-0.0 Y0", "G0 X100.12345678 Y-.5", "G0 Z-0 X0", "G0 X1.2.3 Y4", "G0 X1e3", "G0 X- Y", "G0 X0"])
add("heights in the inserted lines: three decimals, rounding", ["G0 Z3.14159", "G0 X0 Y0", "G0 X100 Y0", "G0 Z0.0005 X0", "G0 Z-0.0004 X100", "G0 Z14.9996 X0", "G0 X100 Z2.0005"], zones=[rect(40, -10, 60, 10, 10.1234, 4.87655)])
add("heights in inches in the inserted lines", ["G20", "G0 Z0.1", "G0 X0 Y0", "G0 X4 Y0", "G0 X0 Z0.05"])
add("unclosed bracket, bracket pairs, semicolon inside brackets, dollar lines", ["G0 Z5", "G0 X0 Y0 (unclosed", "G0 X100 (a) Y0 (b)", "G0 X0 (a;b) Y0", "$H", " $X", "G0 X100 ; (", "G0 (a(b) X0", "G0 X100 ) Y0"])
add("headings: dashes, spaces, empty, not a heading", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "(--- first ---)", "G1 X50", "(--second--)", "G1 X51", "(-- third)", "G1 X52", "  (----- fourth -   -----)  ", "G1 X53", "(- no heading -)", "G1 X54", "(-----)", "G1 X55", "(--- a ---) G1 X56", "(---  spaced - out  ---)", "G1 X57", "(--)", "G1 X58"])
add("odd whitespace: tabs, non-breaking space, carriage return", ["G0\tZ5", "G0 X0 Y0", "G0 X100 Y0\r", " (--- nbsp heading ---) \r", "G1 Z-1\r", "G1 X50\r", "﻿G0 Z5", "G0 X\t0"])
add("other letters and codes pass through", ["G0 Z5", "G0 X0 Y0", "T1 M6", "S12000 M3", "G4 P2", "F800", "G0 X100 Y0", "G54", "G0 X0", "G1 X50 Z-1 F300", "M8", "G1 X60", "M9", "G80", "G0 Z5", "M5", "G0 X0 Y0", "M30"])
add("G0.0, G00, G01, G1.0, G02, G03 and unknown G codes", ["G00 Z5", "G00 X0 Y0", "G00 X100 Y0", "G01 Z-1 F100", "G1.0 X50", "G02 X60 Y0 I5 J0", "G03 X50 Y0 I-5 J0", "G0.0 Z5", "G64 P0.01", "G0 X0", "G5 X100", "G0 X100"])
add("two G words in one line: the last motion wins", ["G0 Z5", "G0 X0 Y0", "G90 G0 X100 Y0", "G1 G0 X0", "G0 G1 X100 F100", "G17 G21 G90", "G0 X0"])
add("zone at negative coordinates and a zone that covers everything", ["G0 Z5", "G0 X-100 Y-100", "G0 X-50 Y-50", "G1 Z-1 F100", "G1 X-60 Y-60"], zones=[rect(-70, -70, -40, -40), rect(-1000, -1000, 1000, 1000, 2, 1)])
add("margin zero and height zero", ["G0 Z0", "G0 X0 Y0", "G0 X100 Y0", "G0 Z-0.001", "G0 X0 Y0", "G1 X100 F100"], zones=[rect(40, -10, 60, 10, 0, 0)])
add("empty note", ["G0 Z5", "G0 X0 Y0", "G0 X100 Y0"], note="")
add("empty program and blank lines", ["", "   ", "", "G0 X0", ""])
# found by the fault check: each case catches one deliberate fault in keepout.rs
add("negative radius: a rapid just inside the edge of the zone still counts", ["G0 Z20", "G0 X0 Y9", "G0 Z5", "G0 X100 Y9"], radius=-3)
add("unclosed bracket: the words behind it are still read", ["G0 Z5", "G0 X0 Y0", "G0 X0 (open Y50", "G0 X100 (open Y50", "G0 X0 (open Y0"])
add("dollar lines are not read: a jog line does not make the program relative", ["G0 Z5", "G0 X0 Y0", "$J=G91 X100 F500", "G0 X100 Y0", "$J=G53 Z0", "G0 X0 Y0"])
add("a dot alone is no number", ["G0 Z5", "G0 X0 Y0", "G0 X. Y40", "G0 X100. Y40", "G0 X.Y0", "G0 X0"])
add("plain G38: position unknown afterwards", ["G0 Z20", "G0 X0 Y50", "G0 Z5", "G38 Z-10 F50", "G0 X5 Y50"])
add("cut that climbs out of the zone: the lower end counts", ["G0 Z20", "G0 X50 Y0", "(--- climb ---)", "G1 Z5 F100", "(--- climb out ---)", "G1 X80 Y0 Z12", "(--- above ---)", "G1 X50 Y0 Z12"])
add("arc in inches: the centre is converted too", ["G20", "G0 Z1", "G0 X0 Y0", "(--- inch arc ---)", "G1 Z-0.04 F10", "G2 X4 Y0 I2 J0"], zones=[rect(40, 40, 60, 60)])
add("full circle counter-clockwise alone", ["G0 Z20", "G0 X20 Y0", "G1 Z-1 F100", "G3 X20 Y0 I30 J0", "G0 Z20"], zones=[rect(75, -5, 85, 5)])
add("flat arc: the bulge of a short sweep reaches the zone, the chord does not", ["G0 Z20", "G0 X0 Y0", "G1 Z-1 F100", "G2 X38 Y0 I19 J-199.1", "G0 Z20"], zones=[rect(15, 0.5, 23, 5)], radius=0)
# real programs: three router jobs from the mill fixtures, with zones laid over them
mill = json.load(gzip.open(REPO + "/tests/fixtures/millgcode-cases.json.gz"))
byname = {c["name"]: c["gcode"].split("\n") for c in mill}
add("real program: tabs on square and circle, clamps at two corners", byname["tabs: automatic on square and circle"], zones=[rect(0, 0, 14, 14, 12, 5), rect(200, 40, 230, 60, 8, 3), ring(120, 30, 6, 16, 15, 5)], radius=1.5)
add("real program: two tools with tool change, clamp between the shapes", byname["two tools: the one that cuts out comes last"], zones=[rect(62, 5, 68, 35, 10, 5), rect(-20, -20, -5, -5, 20, 5)], radius=3)
add("real program: arcs and lead in/out, round clamp on a shape", byname["lead in and out: contours and circles, arc and line"], zones=[ring(130, 15, 5, 20, 9, 4), rect(100, 30, 150, 48, 6, 2)], radius=1.5)
add("real program: pockets, clamp over a pocket", byname["pockets spiral: plain, circle, with island, narrow"], zones=[rect(5, 3, 11, 9, 10, 5)], radius=1.5)
# random programs (fixed seed): moves of all kinds with three decimals, random zones
rnd = random.Random(20261128)
def f3(v): return ("%.3f" % v)
for n in range(24):
    zs = []
    for _ in range(rnd.randint(1, 4)):
        x0, y0 = rnd.uniform(0, 160), rnd.uniform(0, 110)
        if rnd.random() < 0.3: zs.append(ring(round(x0, 2), round(y0, 2), round(rnd.uniform(3, 15), 2), rnd.choice([8, 16, 32]), rnd.choice([5, 10, 18]), rnd.choice([0, 2, 5])))
        else: zs.append(rect(round(x0, 2), round(y0, 2), round(x0 + rnd.uniform(4, 40), 2), round(y0 + rnd.uniform(4, 40), 2), rnd.choice([5, 10, 18]), rnd.choice([0, 2, 5])))
    g = ["G21", "G90", "G0 Z5.00"]
    x = y = None
    for i in range(rnd.randint(40, 120)):
        t = rnd.random()
        nx, ny = rnd.uniform(-10, 200), rnd.uniform(-10, 150)
        if t < 0.05: g.append("(--- shape %d: %s ---)" % (i, rnd.choice(["POLYLINE outside", "CIRCLE inside", "LINE on-line"])))
        elif t < 0.30: g.append("G0 X%s Y%s" % (f3(nx), f3(ny))); x, y = nx, ny
        elif t < 0.38: g.append("G0 Z%s" % rnd.choice(["5.00", "20.00", "12.000", "2.5", "-0.5", "15.000"]))
        elif t < 0.44: g.append("G0 X%s Y%s Z%s" % (f3(nx), f3(ny), rnd.choice(["5.00", "1.000", "25", "9.999"]))); x, y = nx, ny
        elif t < 0.52: g.append("G1 Z%s F300" % f3(rnd.uniform(-6, 12)))
        elif t < 0.75: g.append("G1 X%s Y%s" % (f3(nx), f3(ny))); x, y = nx, ny
        elif t < 0.90 and x is not None:
            # arc with I J to a point at the same distance from the centre
            cx, cy = x + rnd.uniform(-30, 30), y + rnd.uniform(-30, 30)
            r = math.hypot(x - cx, y - cy); a = rnd.uniform(0, 2 * math.pi)
            ex, ey = cx + r * math.cos(a), cy + r * math.sin(a)
            g.append("%s X%s Y%s I%s J%s" % (rnd.choice(["G2", "G3"]), f3(ex), f3(ey), f3(cx - x), f3(cy - y))); x, y = ex, ey
        elif t < 0.94 and x is not None:
            g.append("%s X%s Y%s R%s" % (rnd.choice(["G2", "G3"]), f3(nx), f3(ny), f3(rnd.choice([-1, 1]) * (math.hypot(nx - x, ny - y) / 2 + rnd.uniform(0, 40))))); x, y = nx, ny
        elif t < 0.96: g.append(rnd.choice(["M0 (tool change)", "M6 T2", "G53 G0 Z0", "G28"])); x = y = None
        elif t < 0.98: g.append("G0 X%s" % f3(nx)); x = nx if x is not None else None
        else: g.append("G0 Y%s Z%s" % (f3(ny), rnd.choice(["3.000", "30.000"])))
    g += ["G0 Z5.00", "M5", "G0 X0 Y0", "M30"]
    add("random program %d" % (n + 1), g, zones=zs, radius=rnd.choice([0, 0.5, 1.5, 3, 6]))
assert len({c["name"] for c in cases}) == len(cases)
open(REPO + "/tests/fixtures/keepout-cases.json", "w", encoding="utf-8").write("[\n" + ",\n".join(json.dumps(c, ensure_ascii=True) for c in cases) + "\n]\n")
print(len(cases), "cases,", sum(len(c["gcode"]) for c in cases), "lines")
