#!/usr/bin/env python3
"""Line-art image → long, evenly spaced vector lines that follow the drawing's own strokes.

python3 scripts/flowlines.py <lineart.png> studio/data/<name> [--dmin 3.0] [--dmax 9] [--dots 9000] [--subject 0.07]

Why not trace the pixels: in highlights the drawn lines touch and fuse, so pixel tracing gives blobs and stubs.
Instead read two things from the drawing — the stroke DIRECTION (structure tensor) and how BRIGHT each area is —
and redraw it with clean streamlines: they run along the strokes, sit closer where it is bright and farther
where it is dark, and stop in black. Output: meta.json, lines.bin, lines_idx.bin, dots.bin (read by studio/index.html).
"""
import argparse, json, os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter
from skimage.measure import approximate_polygon

a = argparse.ArgumentParser()
a.add_argument("image"); a.add_argument("out")
a.add_argument("--dmin", type=float, default=3.0, help="line spacing in the brightest areas (px of a 1536-wide image)")
a.add_argument("--dmax", type=float, default=9.0, help="line spacing in the darkest areas that still get lines")
a.add_argument("--black", type=float, default=0.05, help="local brightness under this gets no lines")
a.add_argument("--subject", type=float, default=0.07, help="blurred brightness that counts as the figure (lines outside are dropped)")
a.add_argument("--dots", type=int, default=9000, help="particles sprinkled on the brightest specks")
a.add_argument("--seed", type=int, default=7)
args = a.parse_args()
os.makedirs(args.out, exist_ok=True)
rng = np.random.default_rng(args.seed)

src = Image.open(args.image).convert("L")
OW, OH = src.size
S = OW / 1536.0                                            # spacing params are given for a 1536-wide image
g = np.asarray(src, np.float32) / 255.0
H, W = g.shape

# stroke direction: structure tensor of the drawing; strokes run perpendicular to its main gradient
gx = gaussian_filter(g, 1.0 * S, order=(0, 1)); gy = gaussian_filter(g, 1.0 * S, order=(1, 0))
r = 4.0 * S
Jxx, Jyy, Jxy = gaussian_filter(gx * gx, r), gaussian_filter(gy * gy, r), gaussian_filter(gx * gy, r)
th = 0.5 * np.arctan2(2 * Jxy, Jxx - Jyy) + np.pi / 2
VX, VY = np.cos(th).astype(np.float32), np.sin(th).astype(np.float32)
# local brightness (how much white ink is around) → spacing + line intensity
B = gaussian_filter(g, 2.5 * S); B = np.clip(B / np.percentile(B, 99.5), 0, 1)
gmax = maximum_filter(g, 3)
# subject mask: the drawing's own background has faint wavy strokes; keep only the figure (the page draws its own background)
from scipy.ndimage import binary_fill_holes, binary_opening
Mk = gaussian_filter(g, 10 * S) > args.subject
Mk = binary_fill_holes(binary_opening(Mk, iterations=3))
B = B * Mk
# line intensity: a tighter local average, stretched so highlights read white and shadows stay faint
Bi = gaussian_filter(g, 1.6 * S); Bi = np.power(np.clip(Bi / np.percentile(Bi, 98.5), 0, 1), 0.85)

cell = 1.0 * S                                              # occupancy grid
occ = np.zeros((int(H / cell) + 2, int(W / cell) + 2), bool)
def spacing(y, x): return (args.dmin + (args.dmax - args.dmin) * (1 - B[int(y), int(x)]) ** 1.5) * S
def free(y, x, d):
    k = max(1, int(d / cell / 2)); cy, cx = int(y / cell), int(x / cell)
    return not occ[max(0, cy - k):cy + k + 1, max(0, cx - k):cx + k + 1].any()
def trace(y, x, sgn):
    out, px, py = [], None, None
    for _ in range(int(2400 * S)):
        i, j = int(y + 0.5), int(x + 0.5)
        dx, dy = VX[i, j], VY[i, j]
        if px is not None and dx * px + dy * py < 0: dx, dy = -dx, -dy   # the field has no sign: keep heading the same way
        if px is not None and dx * px + dy * py < 0.6: break             # too sharp a turn: end the line here
        px, py = dx, dy
        x += sgn * dx * S; y += sgn * dy * S
        if not (1 <= x < W - 2 and 1 <= y < H - 2) or B[int(y), int(x)] < args.black: break
        if not free(y, x, spacing(y, x)): break
        out.append((y, x))
    return out

# seeds: bright places first so the key forms (eyes, nose, hair) get their lines before the dim fill
cand = np.argwhere(B > args.black)
cand = cand[rng.permutation(len(cand))][: int(len(cand) / (2 * S * S))]
cand = cand[np.argsort(-B[cand[:, 0], cand[:, 1]] + rng.random(len(cand)) * 0.25, kind="stable")]
polys = []
for (y0, x0) in cand:
    y0, x0 = float(y0), float(x0)
    if not free(y0, x0, spacing(y0, x0)): continue
    p = trace(y0, x0, -1)[::-1] + [(y0, x0)] + trace(y0, x0, 1)
    if len(p) < 8 * S:
        continue
    for (y, x) in p: occ[int(y / cell), int(x / cell)] = True
    polys.append(np.array(p, np.float32))

V, I, Wd, idx = [], [], [], [0]
for p in polys:
    q = approximate_polygon(p, 0.35 * S)
    ys, xs = np.clip(q[:, 0].astype(int), 0, H - 1), np.clip(q[:, 1].astype(int), 0, W - 1)
    V.append(np.stack([q[:, 1], q[:, 0]], 1)); I.append(np.clip(Bi[ys, xs], 0.08, 1)); Wd.append(0.7 + 1.3 * B[ys, xs])
    idx.append(idx[-1] + len(q))
V = np.concatenate(V); I = np.concatenate(I); Wd = np.concatenate(Wd)
with open(os.path.join(args.out, "lines.bin"), "wb") as f:
    f.write(np.round(V * 4).astype(np.uint16).tobytes())
    f.write((I * 255).astype(np.uint8).tobytes())
    f.write(np.clip(Wd * 16, 0, 255).astype(np.uint8).tobytes())
np.array(idx, np.uint32).tofile(os.path.join(args.out, "lines_idx.bin"))

# particles: specks of light where the drawing is brightest, plus dust off the edges
w = (np.power(gmax, 3) * (B > args.black) * Mk).ravel().astype(np.float64)
pick = rng.choice(w.size, size=args.dots, p=w / w.sum())
dy, dx = np.divmod(pick, W)
D = np.stack([dx + rng.random(len(dx)), dy + rng.random(len(dx)), gmax[dy, dx] * (0.5 + 0.5 * rng.random(len(dx))), 0.5 + rng.random(len(dx)) ** 4 * 1.2], 1)
with open(os.path.join(args.out, "dots.bin"), "wb") as f:
    f.write(np.round(D[:, :2] * 4).astype(np.uint16).tobytes())
    f.write((np.clip(D[:, 2], 0, 1) * 255).astype(np.uint8).tobytes())
    f.write(np.clip(D[:, 3] * 16, 0, 255).astype(np.uint8).tobytes())
meta = dict(source=os.path.basename(args.image), width=OW, height=OH, polylines=len(idx) - 1, vertices=int(len(V)), dots=int(len(D)), method="flowlines")
json.dump(meta, open(os.path.join(args.out, "meta.json"), "w"), indent=1)
print(json.dumps(meta))
