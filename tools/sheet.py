#!/usr/bin/env python3
"""Contact sheet of PNG frames (alpha shown over a checkerboard). python3 tools/sheet.py out.jpg a.png b.png ... [--w 270]"""
import sys
from PIL import Image, ImageDraw
args = sys.argv[1:]; w = 270
if '--w' in args: i = args.index('--w'); w = int(args[i + 1]); del args[i:i + 2]
out, files = args[0], args[1:]
ims = []
for f in files:
    im = Image.open(f).convert('RGBA'); h = round(im.height * w / im.width); im = im.resize((w, h), Image.LANCZOS)
    bg = Image.new('RGBA', im.size, (40, 40, 40, 255)); d = ImageDraw.Draw(bg)
    for y in range(0, h, 12):
        for x in range(0, w, 12):
            if (x // 12 + y // 12) % 2: d.rectangle([x, y, x + 11, y + 11], fill=(70, 70, 70, 255))
    bg.alpha_composite(im); ImageDraw.Draw(bg).text((4, 4), f.split('/')[-1], fill=(255, 255, 0, 255)); ims.append(bg.convert('RGB'))
cols = min(len(ims), 6); rows = (len(ims) + cols - 1) // cols; H = max(i.height for i in ims)
sheet = Image.new('RGB', (cols * w, rows * H), (0, 0, 0))
for k, im in enumerate(ims): sheet.paste(im, ((k % cols) * w, (k // cols) * H))
sheet.save(out, quality=88); print(out, sheet.size)
