# Step 2 — turn the cinematic portrait into line art

Use the same image model. Attach the step 1 portrait as the reference and paste this prompt. Keep it at 9:16 and 2K.

```
Turn the reference photo into a monochrome white-on-black drawing built mostly from lines. Same person, same face, same pose and framing, fully recognisable. The whole form is drawn with many dense, fine, flowing white lines: cross-contour lines that wrap around the forehead, cheeks, nose, lips, chin and neck and follow their 3D curvature like a topographic wireframe; long flowing lines for every strand of hair; parallel lines that follow the folds of the clothing. Crisp outlines on the face contour, eyes, eyelashes, brows, nostrils and lips. Lighter areas get more and brighter lines, shadows get fewer and fainter ones. Only a light sprinkle of fine particles where the light is strongest and drifting off the edges. Faint wavy flow-lines in the black background. Pure black background, no grey fills, no photographic texture, no colour, extremely detailed, elegant, like a glowing line-art light sketch. No text.
```

Add the details that must survive, such as "the hoop earrings", "the beard" or "the lapels of the blazer".

Check:
- The lines should cover the face, densest where the light was.
- The background should be black.
- The framing should match step 1.

`flowlines.py` reads the direction and brightness of these strokes, so denser and cleaner line art gives a better portrait.

**Why not skip to code?** A purely local edge detector was tried. It gives either specks or a photocopy. The model's drawing decides where lines go, like an engraver. The code then redraws that drawing as clean vector lines it can animate.
