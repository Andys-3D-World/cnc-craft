# Writes tests/fixtures/rotarywrap-cases.json.gz: shared cases for src/rotaryWrap.ts and src-tauri/src/rotarywrap.rs.
# Run:  python3 tests/fixtures/rotarywrap-make.py   then   UPDATE_FIXTURES=1 npm test   then   cd src-tauri && cargo test rotarywrap
import json, gzip, random, math, os
REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
STOCK = {"shape": "round", "diameter": 40, "width": 40, "height": 30, "sides": 6, "flats": 40, "d0": 30, "d1": 50, "coneLen": 120}
def opt(axis="a", dia=40, **kw):
    o = {"axis": axis, "driveDia": dia, "partDia": dia, "mmPerRot": 100, "depthFeed": True}
    o.update(kw); return o
def stock(shape, **kw):
    s = dict(STOCK); s["shape"] = shape; s.update(kw); return s
cases = []
def add(name, gcode, options, labels=False): cases.append({"name": name, "gcode": gcode, "options": options, "labels": labels})
BASIC = ["G21", "G90", "G0 Z5", "G0 X0 Y0", "G1 Z-1 F300", "G1 X20 Y10 F600", "G1 X20 Y30", "G1 X0 Y30 (back)", "G1 Y0 ; home", "G0 Z5", "M5", "M30"]
add("round, A axis: straight cuts", BASIC, opt())
add("round, Y port: straight cuts", BASIC, opt("y"))
add("round, Y port, roller of another diameter", BASIC, opt("y", driveDia=60, mmPerRot=37.5))
add("round, A axis, reversed", BASIC, opt(reverse=True))
add("round, axis along Y", BASIC, opt(along="y"))
add("round, axis along Y, reversed, Y port", BASIC, opt("y", along="y", reverse=True))
add("round, axis along Y, input already internal", BASIC, opt(along="y", input="internal"))
add("round, laser: no depth feed, no Z", ["G90", "M4 S0", "G0 X0 Y0", "G1 X30 S500 F1200", "G1 Y20", "G1 X0 Y40 S300", "G2 X10 Y50 I10 J0", "G1 X10 Y0", "M5"], opt(depthFeed=False))
add("feed: deep cut shortens the way round, tiny part, zero diameter", ["G0 X0 Y0 Z0", "G1 Z-10 F300", "G1 Y20 F600", "G1 Z-19", "G1 Y40", "G1 Z-25", "G1 Y0", "G1 X5 Y0 Z2", "G1 Y30"], opt())
add("feed: zero part diameter", ["G0 X0 Y0 Z0", "G1 Z-1 F300", "G1 Y20 F600", "G1 X5"], opt(partDia=0))
add("feed: unchanged feed is not repeated, changes are", ["G0 X0 Y0", "G1 X10 F500", "G1 X20", "G1 X30 F500", "G1 Y10", "G1 Y20", "G1 X0 Y0", "F900", "G1 X5", "G1 Z-1 F100", "G1 X6 F0.2", "G1 X7 F0", "G1 Y9"], opt())
add("feed without a known position, cut before any feed", ["G1 X5", "G1 Y5", "G1 Z-1 F200", "G28", "G1 X1 F300", "G1 Y2", "G53 G0 Z0", "G1 Y3"], opt())
add("feed before a trailing comment, several comments, semicolon comments", ["G0 X0 Y0", "G1 X5 Y5 F300 (first)", "G1 X6 (a) Y7 (b) ", "G1 Y8 ; c F200", "G1 Y9 (x) ; y", "G1 Y10 F400;z", "G1 (lead) Y11", "G1 Y12 (unclosed", "G1 Y13 ; a ; b"], opt())
add("carriage returns at the line end", ["G0 X0 Y0\r", "G1 Y5 F300 (c)\r", "G1 Y6 ; c\r", "G1 X1 Y7\r", "(only a comment)\r", "\r"], opt())
add("lower case, no spaces, signs, leading dots, line numbers", ["n10 g0 x0 y0", "N20G1Y.5F300", "g1 x+1.5 y-.25", "G1X5Y5.", "g1 y 6 f 250", "G1 Y-0", "G1 X1e2 Y3"], opt())
add("Y inside brackets stays, Y after a letter stays, Y in a semicolon comment is converted", ["G0 X0 Y0", "G1 X1 (Y5) Y2 F300", "G1 X2 ; Y9", "G1 KY5 X3", "MY5", "G1 X4 Y 6"], opt())
add("words that stay: S, M, T, P at cuts and arcs", ["G0 X0 Y0 Z1", "M3 S12000", "G1 X5 Y5 S900 M8 F300", "G2 X15 Y5 I5 J0 S800 M9", "G4 P0.5", "T2 M6", "G1 X0"], opt())
add("drill cycle: feed remembered, position kept", ["G0 X0 Y0 Z5", "G81 X10 Y10 Z-3 R1 F120", "X20 Y15", "G80", "G1 X0 Y0 F300", "G1 Y5", "G83 X5 Y5 Z-5 Q1 R1 F100", "G80", "G1 Y20"], opt())
add("G53, G28, G30: untouched, position unknown", ["G0 X0 Y0", "G1 Y5 F300", "G53 G0 Y10", "G1 Y8", "G28 X0", "G1 X2", "G30", "G2 X5 Y5 I1"], opt())
add("dollar lines, blank lines, comment lines", ["$H", " $X", "", "   ", "(Y5)", "; Y6", "G0 X0 Y0", "G1 Y5 F300"], opt())
add("arc clockwise and counter-clockwise (I J), with feed", ["G0 X0 Y0 Z2", "G1 Z-1 F200", "G2 X20 Y0 I10 J0 F600", "G3 X0 Y0 I-10 J0", "G2 X0 Y0 I5 J5", "G0 Z5"], opt())
add("arc on the Y port", ["G0 X0 Y0 Z2", "G1 Z-1 F200", "G2 X20 Y0 I10 J0 F600", "G3 X10 Y10 I-10 J0"], opt("y"))
add("arc with R: short, long, both directions", ["G0 X0 Y0", "G2 X20 Y0 R12 F500", "G2 X0 Y0 R-12", "G3 X20 Y0 R12", "G3 X0 Y0 R-12", "G2 X8 Y8 R5.6569"], opt())
add("arc as a helix, Z in every piece", ["G0 X0 Y0 Z0", "G2 X20 Y0 Z-2 I10 J0 F400", "G3 X0 Y0 Z-2 I-10", "G2 X20 Y0 I10 Z-3"], opt())
add("arc without Z known (laser)", ["G0 X0 Y0", "G3 X10 Y10 I0 J10 F900 S400", "G2 X20 Y0 I10 J0"], opt(depthFeed=False))
add("tiny arc: at least four pieces; large arc: half-millimetre pieces", ["G0 X0 Y0", "G2 X0.2 Y0 I0.1 J0 F300", "G3 X100.2 Y0 I50 J0"], opt())
add("arc with the axis along Y", ["G0 X0 Y0 Z2", "G1 Z-1 F200", "G2 X20 Y0 I10 J0 F600", "G3 X0 Y0 I-10 J0", "G1 X5 Y5"], opt(along="y"))
add("refused: inches", ["G90", "G0 X0 Y0", "G20"], opt())
add("refused: G92", ["G0 X0 Y0", "G92 X0"], opt())
add("refused: G10", ["G10 L20 P1 X0"], opt())
add("refused: relative move", ["G0 X0 Y0", "G91", "M3", "G1 X5"], opt())
add("relative without a move is fine, back to absolute", ["G91", "M3 S100", "G90", "G0 X0 Y0", "G1 Y5 F100"], opt())
add("refused: arc in another plane", ["G0 X0 Y0", "G18", "G2 X5 Y0 I2.5"], opt())
add("refused: arc without a known start", ["G2 X5 Y5 I5"], opt())
add("refused: arc whose end is not on the circle", ["G0 X0 Y0", "G2 X20 Y3 I10 J0"], opt())
add("refused: arc with R too small, arc of zero length with R", ["G0 X0 Y0", "G1 X1", "G2 X30 Y0 R5"], opt())
add("refused: R arc back to its start", ["G0 X0 Y0", "G2 X0 Y0 R5"], opt())
add("refused on the internal side with the axis along Y: the line is still right", ["G0 X0 Y0", "G1 X5", "G1 Y5", "G2 X9 Y9 I1 J0"], opt(along="y"))
# ---- cone ----
cone = stock("cone")
CONE = ["G21", "G90", "G0 Z5", "G0 X10 Y60", "G1 Z-1 F300", "G1 X60 Y70 F600", "G1 X60 Y90", "G1 X10 Y90 (back)", "G1 Y60", "G0 Z5", "G0 X100 Y50 S0", "G1 X100.0000000001 Y80 Z-2", "M5"]
add("cone, A axis: cuts in pieces of 1 mm, Z follows the slope", CONE, opt(stock=cone))
add("cone, Y port, reversed", CONE, opt("y", stock=cone, reverse=True))
add("cone, axis along Y", CONE, opt(stock=cone, along="y"))
add("cone that gets thinner, laser", CONE, opt(stock=stock("cone", d0=60, d1=20, coneLen=80), depthFeed=False))
add("cone: Z before the position is known, X only, comments and extra words", ["G0 Z5 (up)", "G0 X10", "G1 Z1 S500", "G0 Y20 (go) M8", "G1 X30 Y25 F300 (cut) S900", "F450", "G1 X31", "G4 P1", "G1 Z-3"], opt(stock=cone))
add("cone: arcs", ["G0 X20 Y50 Z2", "G1 Z-1 F200", "G2 X40 Y50 I10 J0 F500", "G3 X20 Y50 R10", "G0 Z5"], opt(stock=cone))
add("cone: beyond both ends, zero length", ["G0 X-20 Y40 Z1", "G1 X200 Y45 F800", "G1 X-5"], opt(stock=stock("cone", coneLen=0)))
add("cone refused: cycle", ["G0 X0 Y0", "G81 X5 Y5 Z-1 R1 F100"], opt(stock=cone))
add("cone refused: relative, inch, offset, plane, arc", ["G0 X0 Y0", "G19", "G1 X5 Y5 F100", "G3 X9 Y9 I2"], opt(stock=cone))
add("cone: G80 alone is fine, G53 passes", ["G80", "G53 G0 Z0", "G0 X5 Y5", "G1 X9 F100"], opt(stock=cone))
# ---- square and polygon stock: faces side by side in the band ----
rectS = stock("rect")          # faces 40, 30, 40, 30 wide
def face_job(u0, a0=5, deep=-1):
    return ["G0 X%g Y%g" % (a0, u0 + 5), "G1 Z%g F300" % deep, "G1 X%g Y%g F600" % (a0 + 20, u0 + 5), "G1 X%g Y%g" % (a0 + 20, u0 + 20), "G2 X%g Y%g I-5 J0" % (a0 + 10, u0 + 20), "G1 X%g Y%g" % (a0, u0 + 5), "G0 Z5"]
def small(u0, deep=-1): return ["G0 X5 Y%g" % (u0 + 2), "G1 Z%g F300" % deep, "G1 X20 Y%g F600" % (u0 + 8), "G0 Z5"]
PRISM = ["G21", "G90", "G0 Z5"] + face_job(0) + face_job(40) + face_job(70) + face_job(110) + face_job(145) + ["M5", "M30"]
add("square stock: four faces and one turn further, A axis", PRISM, opt(stock=rectS), labels=True)
add("square stock without labels, laser (S0 at the turn)", PRISM, opt(stock=rectS, laser=True, depthFeed=False))
add("square stock, reversed", PRISM, opt(stock=rectS, reverse=True), labels=True)
PRISMY = [l.replace("X", "#").replace("Y", "X").replace("#", "Y").replace("I-5 J0", "J-5 I0") for l in PRISM]
add("square stock, axis along Y", PRISMY, opt(stock=rectS, along="y"), labels=True)
add("square stock, axis along Y, reversed", PRISMY, opt(stock=rectS, along="y", reverse=True))
add("hexagon: faces of equal width", ["G0 Z5"] + sum([face_job(round(k * 40 * math.tan(math.pi / 6), 3) + 0.5, 2) for k in [0, 2, 5, 1, 7, 12]], []), opt(stock=stock("poly")), labels=True)
add("triangle and twelve sides are the limits", ["G0 Z5", "G0 X0 Y5", "G1 Z-1 F100", "G1 X10 Y8", "G0 Z5", "G0 X0 Y75", "G1 Z-1", "G1 X5 Y76", "G0 Z5"], opt(stock=stock("poly", sides=2, flats=30)))
add("polygon with 20 sides counts as 12", ["G0 Z5", "G0 X0 Y2", "G1 Z-1 F100", "G1 X10 Y3", "G0 Z5", "G0 X0 Y15", "G1 Z-1", "G1 X5 Y16", "G0 Z5"], opt(stock=stock("poly", sides=20, flats=30)), labels=True)
add("square stock: the short way round, back over zero", ["G0 Z5"] + face_job(110) + face_job(0) + face_job(110) + face_job(40) + face_job(-30) + face_job(-135) + face_job(285), opt(stock=rectS), labels=True)
add("square stock: rapid with Z, rapid without lateral move, cut starts without a rapid", ["G0 X5 Y5 Z5", "G1 Z-1 F200", "G1 X20 Y8", "G0 Z5", "G0 Z8", "G0 X5 Y50 Z3", "G1 Z-1", "G1 Y55", "G0 X6", "G1 Y60", "G0 Z5", "G0 Y80", "G1 Z-2", "G1 X20"], opt(stock=rectS), labels=True)
add("square stock: a rapid in the material stays on its face", ["G0 X5 Y5", "G1 Z-1 F200", "G0 X20 Y10", "G1 X25", "G0 Z5", "G0 X5 Y45"], opt(stock=rectS))
add("square stock: cut that runs over the edge within the allowance", ["G0 Z5", "G0 X5 Y30", "G1 Z-1 F200", "G1 X20 Y44", "G0 Z5"], opt(stock=rectS))
add("square stock refused: cut across the edge", ["G0 Z5", "G0 X5 Y30", "G1 Z-1 F200", "G1 X6 Y31", "G1 X20 Y46", "G0 Z5"], opt(stock=rectS))
add("square stock: wider allowance (laser) lets it through", ["G0 Z5", "G0 X5 Y30", "G1 Z-1 F200", "G1 X6 Y31", "G1 X20 Y46", "G0 Z5"], opt(stock=rectS, overrun=15))
add("square stock refused: arc that swings over the edge", ["G0 Z5", "G0 X5 Y30", "G1 Z-1 F200", "G3 X5 Y38 I0 J4", "G2 X5 Y30 I0 J-4", "G2 X5 Y30 I0 J-20"], opt(stock=rectS))
add("square stock refused: cycle, inch, relative, plane, arc without start", ["G0 Z5", "G0 X5 Y5", "G82 X5 Y5 Z-1 R1 P1 F100"], opt(stock=rectS))
add("square stock refused: relative", ["G0 X5 Y5", "G91", "G1 X1"], opt(stock=rectS))
add("square stock refused: arc without start", ["G2 X5 Y5 I1"], opt(stock=rectS))
add("square stock refused: plane", ["G0 X5 Y5", "G1 Z-1", "G19", "G2 X6 Y6 I1"], opt(stock=rectS))
add("square stock: comments, dollar lines, machine coordinates, words in comments", ["(X5 Y5 Z5)", "$H", "G53 G0 Z0", "G0 X5 Y45 (to face 2 Y45)", "G1 Z-1 F200 ; Z-9", "G1 X10 Y50", "G0 Z5", "M5 (Z0)", "G28", "G0 X5 Y75"], opt(stock=rectS), labels=True)
add("square stock: rotation only before the first move, none without moves", ["M3 S1000", "G4 P1", "M5"], opt(stock=rectS))
add("flat rectangle: faces of very different height", ["G0 Z5"] + face_job(0) + small(80, -2) + face_job(100) + small(172, -0.5), opt(stock=stock("rect", width=80, height=12)), labels=True)
add("octagon, laser, axis along Y", ["G0 Y5 X2", "G1 Y20 X6 S500 F900", "G0 Y5 X20", "G1 Y20 X24", "G3 Y20 X28 J0 I2", "G0 Y5 X60", "G1 Y9 X66 S0"], opt(stock=stock("poly", sides=8, flats=40), along="y", laser=True, depthFeed=False, overrun=15), labels=True)
# ---- found by the fault check: each case catches one deliberate fault in rotarywrap.rs ----
add("dollar line with a space in front stays untouched", [" $J=G91 Y5 F100", "G0 X0 Y0", "G1 Y5 F300"], opt())
add("dollar line stays untouched with the axis along Y", ["$J=G53 X5.00001 Y2.50", "G0 X0 Y0", "G1 Y5 F200"], opt(along="y"))
add("the first of two equal words counts", ["G0 X0 Y0", "G1 X5 X9 Y2 Y7 F300 F100", "G1 X6 Y3"], opt())
add("arc line with line number and tool word", ["G0 X0 Y0", "N50 G2 X20 Y0 I10 J0 T3 S100 F400"], opt())
add("arc with J along Y", ["G0 X0 Y0 Z1", "G2 X10 Y10 I0 J10 F300", "G3 X0 Y0 I-10 J0"], opt(along="y"))
add("refused: arc end 0.05 mm off the circle", ["G0 X0 Y0", "G2 X20.05 Y0 I10 J0"], opt())
add("full circle counter-clockwise", ["G0 X0 Y0", "G3 X0 Y0 I5 J5 F300"], opt())
add("feed below 0.5 becomes F1", ["G0 X0 Y0", "G1 X5 F0.2", "G1 X6 F0.4", "G1 X7 F700"], opt())
add("G80 alone ends the cutting mode", ["G0 X0 Y0", "G1 Y5 F100", "G80", "X5 Y9", "G1 Y12"], opt())
add("G30 with words stays untouched", ["G0 X0 Y0", "G1 Y5 F100", "G30 X1 Y5", "G0 X0 Y0"], opt())
add("first cut with Z while Z is unknown: the depth of the target counts for the feed", ["G0 X0 Y0", "G1 X5 Y20 Z-10 F300", "G1 Y40"], opt())
add("square stock: a cut exactly on the edge belongs to the next face", ["G0 Z5", "G0 X5 Y40", "G1 Z-1 F100", "G1 X10 Y40", "G0 Z5"], opt(stock=rectS), labels=True)
add("square stock: a rapid in the material does not start a new group", ["G0 Z5", "G0 X5 Y35", "G1 Z-1 F200", "G0 X8 Y44", "G1 X12 Y44", "G0 Z5"], opt(stock=rectS), labels=True)
add("square stock: a rapid in Z alone does not start a new group", ["G0 Z5", "G0 X5 Y36", "G1 Z-1 F200", "G1 X9 Y38", "G0 Z5", "G0 Z8", "G1 Z-1", "G1 X12 Y44", "G0 Z5"], opt(stock=rectS), labels=True)
add("square stock: the start of a cut counts for its face", ["G0 Z5", "G0 X5 Y30", "G1 X9 Y44 Z-1 F200", "G0 Z5"], opt(stock=rectS), labels=True)
add("square stock: the middle of the range decides the face", ["G0 Z5", "G0 X5 Y38", "G1 Z-1 F200", "G1 X9 Y50", "G0 Z5"], opt(stock=rectS), labels=True)
add("square stock: two turns in a row, the height of the first is kept", ["G0 Z5", "G0 X5 Y10", "G1 Z-1 F200", "G1 X9 Y12", "G0 Z5", "G0 X5 Y66 Z3", "G0 X5 Y80", "G1 Z-1", "G1 X9 Y82", "G0 Z5"], opt(stock=rectS), labels=True)
add("cone without slope: a feed alone is remembered", ["G0 X0 Y0 Z0", "G1 X5 F300", "F450", "G1 X10", "G1 X15"], opt(stock=stock("cone", d0=40, d1=40)))
# ---- real programs from the mill fixtures ----
mill = json.load(gzip.open(os.path.join(REPO, "tests/fixtures/millgcode-cases.json.gz")))
byname = {c["name"]: c["gcode"].split("\n") for c in mill}
for nm, key in [("tabs", "tabs: automatic on square and circle"), ("lead in and out", "lead in and out: contours and circles, arc and line"), ("two tools", "two tools: the one that cuts out comes last"), ("arcs", "arcs outside and inside, with mill direction"), ("pockets", "pockets spiral: plain, circle, with island, narrow"), ("drilling", "drilling: one pass, pecking, hole of another size, drill on a square and a line")]:
    g = byname[key]
    add("real program (%s): round, A axis" % nm, g, opt(dia=80))
    add("real program (%s): round, Y port, axis along Y, reversed" % nm, g, opt("y", dia=80, along="y", reverse=True, mmPerRot=360))
    add("real program (%s): cone" % nm, g, opt(stock=stock("cone", d0=60, d1=90, coneLen=300)))
add("real program (pockets): large square stock, all on face 1", byname["pockets spiral: plain, circle, with island, narrow"], opt(stock=stock("rect", width=90, height=60)), labels=True)
add("real program (tabs): square stock, refused where a shape crosses an edge", byname["tabs: automatic on square and circle"], opt(stock=stock("rect", width=90, height=60)))
# ---- random programs (fixed seed) ----
rnd = random.Random(20261128)
f3 = lambda v: "%.3f" % v
for n in range(18):
    g = ["G21", "G90", "G0 Z5.00"]
    x = y = None
    for i in range(rnd.randint(30, 90)):
        t = rnd.random(); nx, ny = rnd.uniform(0, 120), rnd.uniform(0, 110)
        if t < 0.22: g.append("G0 X%s Y%s" % (f3(nx), f3(ny))); x, y = nx, ny
        elif t < 0.30: g.append("G0 Z%s" % rnd.choice(["5.00", "2.000"]))
        elif t < 0.40: g.append("G1 Z%s F%s" % (f3(rnd.uniform(-8, 0)), rnd.choice(["300", "120", "90.5"])))
        elif t < 0.70: g.append("G1 X%s Y%s%s" % (f3(nx), f3(ny), rnd.choice(["", "", " F600", " F1250", " (c)"]))); x, y = nx, ny
        elif t < 0.78: g.append("G1 X%s" % f3(nx)); x = nx
        elif t < 0.84: g.append("G1 Y%s Z%s" % (f3(ny), f3(rnd.uniform(-5, 0)))); y = ny
        elif t < 0.97 and x is not None and y is not None:
            cx, cy = x + rnd.uniform(-20, 20), y + rnd.uniform(-20, 20)
            r = math.hypot(x - cx, y - cy); a = rnd.uniform(0, 2 * math.pi)
            ex, ey = cx + r * math.cos(a), cy + r * math.sin(a)
            g.append("%s X%s Y%s I%s J%s%s" % (rnd.choice(["G2", "G3"]), f3(ex), f3(ey), f3(cx - x), f3(cy - y), rnd.choice(["", " F700", " Z-1.500"]))); x, y = ex, ey
        else: g.append(rnd.choice(["M3 S12000", "G4 P2", "(--- shape ---)", "M0 (tool change)"]))
    g += ["G0 Z5.00", "M5", "M30"]
    o = [opt(), opt("y"), opt(along="y"), opt(reverse=True, dia=63.7), opt(stock=stock("cone", d0=40, d1=70, coneLen=120)), opt("y", stock=stock("cone", d0=70, d1=35, coneLen=100), along="y", mmPerRot=40)][n % 6]
    add("random program %d" % (n + 1), g, o)
assert len({c["name"] for c in cases}) == len(cases)
# packed (gzip without a time stamp, so the same cases give the same file): the programs are long
with open(os.path.join(REPO, "tests/fixtures/rotarywrap-cases.json.gz"), "wb") as f:
    with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0, compresslevel=9) as z:
        z.write(("[\n" + ",\n".join(json.dumps(c, ensure_ascii=True) for c in cases) + "\n]\n").encode("utf-8"))
print(len(cases), "cases,", sum(len(c["gcode"]) for c in cases), "lines")
