#!/usr/bin/env python3
"""Any photo (object, product, logo shot, building, hand, pet …) → flowing light lines + particles, no image model needed.

python3 scripts/image2lines.py <photo> <out_dir> [--mask auto|alpha|none] [--edges 0.6] [--dmin 3] [--dmax 10] [--dots 7000]

Portraits get the best result through the v1 path (image model → line art → flowlines.py). Objects and products do not
need it: their shape lives in edges and light. So this script builds its own "drawing" from the photo — edge strength
(where the form turns) mixed with luminance (where the light sits) — then traces it with the same evenly spaced
streamlines as flowlines.py: lines follow the edges and the shading, close together in light, sparse in shadow.
The subject is cut out first (PNG alpha, or the colour that differs from the border), so the background stays empty.
Output: meta.json, lines.bin, lines_idx.bin, dots.bin — the same format the studio and render.mjs read.
"""
import argparse, json, os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, maximum_filter, binary_fill_holes, binary_opening, binary_closing, label
from skimage.measure import approximate_polygon

a = argparse.ArgumentParser()
a.add_argument("image"); a.add_argument("out")
a.add_argument("--mask", default="auto", choices=["auto", "alpha", "none"], help="how to find the subject")
a.add_argument("--edges", type=float, default=0.6, help="0 = lines from light only, 1 = lines from edges only")
a.add_argument("--dmin", type=float, default=3.0, help="line spacing in the brightest areas (px of a 1536-wide image)")
a.add_argument("--dmax", type=float, default=10.0, help="line spacing in the darkest areas that still get lines")
a.add_argument("--black", type=float, default=0.04, help="ink under this gets no lines")
a.add_argument("--dots", type=int, default=7000)
a.add_argument("--max-side", type=int, default=1536, help="work size (the long side)")
a.add_argument("--seed", type=int, default=7)
args = a.parse_args()
os.makedirs(args.out, exist_ok=True)
rng = np.random.default_rng(args.seed)

im = Image.open(args.image)
k = args.max_side / max(im.size)
if k < 1: im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
rgba = np.asarray(im.convert("RGBA"), np.float32) / 255.0
rgb, alpha = rgba[..., :3], rgba[..., 3]
H, W = alpha.shape
S = max(W, H) / 1536.0
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)

# ---- subject mask
if args.mask == "alpha" or (args.mask == "auto" and alpha.min() < 0.9):
    M = alpha > 0.5
elif args.mask == "auto":   # the background is whatever colour the border has; the subject is what differs from it
    b = np.concatenate([rgb[:4].reshape(-1, 3), rgb[-4:].reshape(-1, 3), rgb[:, :4].reshape(-1, 3), rgb[:, -4:].reshape(-1, 3)])
    bg = np.median(b, 0); spread = np.percentile(np.linalg.norm(b - bg, axis=1), 95)
    d = gaussian_filter(np.linalg.norm(rgb - bg, axis=2), 2 * S)
    M = d > max(0.08, spread * 1.5)
    M = binary_closing(binary_opening(M, iterations=2), iterations=4)
    lab, n = label(M)
    if n > 1:   # keep the big parts only (drop specks of noise)
        sizes = np.bincount(lab.ravel()); sizes[0] = 0; M = np.isin(lab, np.where(sizes > sizes.max() * 0.04)[0])
    M = binary_fill_holes(M)
else:
    M = np.ones_like(alpha, bool)
Mf = gaussian_filter(M.astype(np.float32), 1.5 * S)

# ---- the "drawing": edges where the form turns + luminance where the light sits
gx = gaussian_filter(lum, 1.2 * S, order=(0, 1)); gy = gaussian_filter(lum, 1.2 * S, order=(1, 0))
E = np.hypot(gx, gy); E = np.clip(E / (np.percentile(E[M], 97) + 1e-6), 0, 1) ** 0.8
Lm = np.clip(lum / (np.percentile(lum[M], 99) + 1e-6), 0, 1) ** 1.1
ink = (args.edges * E + (1 - args.edges) * Lm) * Mf
# the outline of the subject is always drawn: a thin bright rim along the mask edge
rim = np.clip(gaussian_filter(M.astype(np.float32), 1.0 * S) * (1 - gaussian_filter(M.astype(np.float32), 3.0 * S)) * 4, 0, 1)
g = np.clip(np.maximum(ink, rim * 0.75), 0, 1)

# stroke direction: lines run along edges (perpendicular to the luminance gradient), smoothed by the structure tensor
r = 8.0 * S
Jxx, Jyy, Jxy = gaussian_filter(gx * gx, r), gaussian_filter(gy * gy, r), gaussian_filter(gx * gy, r)
th = 0.5 * np.arctan2(2 * Jxy, Jxx - Jyy) + np.pi / 2
VX, VY = np.cos(th).astype(np.float32), np.sin(th).astype(np.float32)
B = gaussian_filter(g, 2.5 * S); B = np.clip(B / (np.percentile(B[M], 99.5) + 1e-6), 0, 1) * (Mf > 0.5)
Bi = gaussian_filter(g, 1.4 * S); Bi = np.power(np.clip(Bi / (np.percentile(Bi[M], 98.5) + 1e-6), 0, 1), 0.85)

cell = 1.0 * S
occ = np.zeros((int(H / cell) + 2, int(W / cell) + 2), bool)
def spacing(y, x): return (args.dmin + (args.dmax - args.dmin) * (1 - B[int(y), int(x)]) ** 1.5) * S
def free(y, x, d):
    kk = max(1, int(d / cell / 2)); cy, cx = int(y / cell), int(x / cell)
    return not occ[max(0, cy - kk):cy + kk + 1, max(0, cx - kk):cx + kk + 1].any()
def trace(y, x, sgn):
    out, px, py = [], None, None
    for _ in range(int(2400 * S)):
        i, j = int(y + 0.5), int(x + 0.5)
        dx, dy = VX[i, j], VY[i, j]
        if px is not None and dx * px + dy * py < 0: dx, dy = -dx, -dy
        if px is not None and dx * px + dy * py < 0.6: break
        px, py = dx, dy
        x += sgn * dx * S; y += sgn * dy * S
        if not (1 <= x < W - 2 and 1 <= y < H - 2) or B[int(y), int(x)] < args.black: break
        if not free(y, x, spacing(y, x)): break
        out.append((y, x))
    return out

cand = np.argwhere(B > args.black)
cand = cand[rng.permutation(len(cand))][: int(len(cand) / (2 * S * S))]
cand = cand[np.argsort(-B[cand[:, 0], cand[:, 1]] + rng.random(len(cand)) * 0.25, kind="stable")]
polys = []
for (y0, x0) in cand:
    y0, x0 = float(y0), float(x0)
    if not free(y0, x0, spacing(y0, x0)): continue
    p = trace(y0, x0, -1)[::-1] + [(y0, x0)] + trace(y0, x0, 1)
    if len(p) < 8 * S: continue
    for (y, x) in p: occ[int(y / cell), int(x / cell)] = True
    polys.append(np.array(p, np.float32))
if not polys: raise SystemExit("no lines found — try --mask none or a lower --black")

V, I, Wd, idx = [], [], [], [0]
for p in polys:
    q = approximate_polygon(p, 0.35 * S)
    ys, xs = np.clip(q[:, 0].astype(int), 0, H - 1), np.clip(q[:, 1].astype(int), 0, W - 1)
    V.append(np.stack([q[:, 1], q[:, 0]], 1)); I.append(np.clip(Bi[ys, xs], 0.08, 1)); Wd.append(0.7 + 1.3 * B[ys, xs])
    idx.append(idx[-1] + len(q))
V = np.concatenate(V); I = np.concatenate(I); Wd = np.concatenate(Wd)
with open(os.path.join(args.out, "lines.bin"), "wb") as f:
    f.write(np.round(V * 4).astype(np.uint16).tobytes()); f.write((I * 255).astype(np.uint8).tobytes()); f.write(np.clip(Wd * 16, 0, 255).astype(np.uint8).tobytes())
np.array(idx, np.uint32).tofile(os.path.join(args.out, "lines_idx.bin"))

gmax = maximum_filter(g, 3)
w = (np.power(gmax, 3) * (B > args.black)).ravel().astype(np.float64)
pick = rng.choice(w.size, size=args.dots, p=w / w.sum()); dy, dx = np.divmod(pick, W)
D = np.stack([dx + rng.random(len(dx)), dy + rng.random(len(dx)), gmax[dy, dx] * (0.5 + 0.5 * rng.random(len(dx))), 0.5 + rng.random(len(dx)) ** 4 * 1.2], 1)
with open(os.path.join(args.out, "dots.bin"), "wb") as f:
    f.write(np.round(D[:, :2] * 4).astype(np.uint16).tobytes()); f.write((np.clip(D[:, 2], 0, 1) * 255).astype(np.uint8).tobytes()); f.write(np.clip(D[:, 3] * 16, 0, 255).astype(np.uint8).tobytes())
ys, xs = np.nonzero(M)
meta = dict(source=os.path.basename(args.image), width=W, height=H, polylines=len(idx) - 1, vertices=int(len(V)), dots=int(len(D)), method="image",
            subject=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None)
json.dump(meta, open(os.path.join(args.out, "meta.json"), "w"), indent=1)
print(json.dumps(meta))
