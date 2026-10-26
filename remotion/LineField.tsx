/**
 * <LineField /> — the line + particle engine as a Remotion layer. Deterministic: frame n always draws the same
 * picture (the engine renders time n / fps; nothing carries between frames), so it renders correctly with any
 * --concurrency and inside <Sequence>/<Series> (it uses the sequence's local frame).
 *
 * Setup (once per Remotion project):
 *   1. copy `studio/engine/` next to this file as `./engine/` (it imports `three`, which Remotion projects have)
 *   2. copy `studio/vendor/harfbuzz/` and `studio/fonts/` into `public/linefield/` (text inputs need them)
 *   3. put the scene's own files (SVGs, fonts, baked folders) under `public/linefield/` too, or pass `sceneBase`
 *   4. remotion.config.ts: Config.setChromiumOpenGlRenderer("angle")  (GPU WebGL; the default software GL is slow)
 *
 *   <LineField scene={{ shots: [{ input: { svg: "logo.svg" }, duration: 3, in: { type: "sting" } }] }} />
 *   <LineField scene={spec} transparent />   // straight alpha: composites over anything under it
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
// @ts-expect-error — plain ES module, no type declarations
import { createEngine } from "./engine/linefield.mjs";

type Engine = { load: (s: object) => Promise<{ frames: number }>; renderTime: (t: number) => void; dispose: () => void };

export type LineFieldProps = {
  /** a scene spec (see SKILL.md): shots, look, budgets. width/height/fps come from the composition unless set here */
  scene: Record<string, unknown> & { shots: unknown[] };
  /** transparent background (straight alpha) instead of the scene background */
  transparent?: boolean;
  /** where engine assets live (harfbuzz, fonts) — default public/linefield/ */
  assetBase?: string;
  /** where the scene's relative paths resolve — default public/linefield/ */
  sceneBase?: string;
  /** offset in seconds into the scene (e.g. start mid-way) */
  offset?: number;
  /** playback rate of the scene (1 = real time) */
  rate?: number;
  /** canvas size in px (default: the composition size) — e.g. a 16:9 layer inside a 9:16 reel */
  width?: number;
  height?: number;
  style?: React.CSSProperties;
};

export const LineField: React.FC<LineFieldProps> = ({ scene, transparent, assetBase, sceneBase, offset = 0, rate = 1, width: w, height: h, style }) => {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig();
  const fps = cfg.fps, width = w ?? cfg.width, height = h ?? cfg.height;
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const [handle] = useState(() => delayRender("LineField: building the scene", { timeoutInMilliseconds: 120000 }));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const base = staticFile("linefield/");
        const e: Engine = await createEngine({ canvas: canvas.current, width, height, assetBase: assetBase ?? base, sceneBase: sceneBase ?? base });
        await e.load({ fps, ...scene, width, height, ...(transparent ? { background: "transparent" } : {}) });
        if (dead) { e.dispose(); return; }
        engine.current = e;
        setReady(true);
        continueRender(handle);
      } catch (err) {
        cancelRender(err);
      }
    })();
    return () => { dead = true; engine.current?.dispose(); engine.current = null; };
    // the scene is built once per mount; give the component a new `key` to rebuild it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // draw synchronously before Remotion takes the screenshot (the canvas keeps its drawing buffer)
  useLayoutEffect(() => {
    if (ready && engine.current) engine.current.renderTime(offset + (frame / fps) * rate);
  }, [frame, fps, ready, offset, rate]);

  return <canvas ref={canvas} width={width} height={height} style={{ position: "absolute", left: 0, top: 0, width, height, ...style }} />;
};
