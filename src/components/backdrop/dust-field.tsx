"use client";

import { useEffect, useRef } from "react";
import { useMotionPreference } from "@/hooks/use-motion-preference";
import {
  createParticles,
  particleCount,
  stepParticles,
  swayOffset,
  twinkleAlpha,
  type Particle,
} from "@/lib/backdrop/dust";

const MAX_DPR = 2;
const RESIZE_DEBOUNCE_MS = 150;

// Slow white specks drifting upward. One canvas, one rAF loop, no layout reads.
export function DustField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { motion } = useMotionPreference();

  // The only writer of html[data-motion], which the `motion-still` variant reads.
  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let elapsed = 0;

    // Invalid colour strings leave the previous fillStyle in place.
    ctx.fillStyle = "#ffffff";
    ctx.fillStyle =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--particle")
        .trim() || "#ffffff";

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      for (const p of particles) {
        ctx.globalAlpha = twinkleAlpha(p, elapsed);
        ctx.beginPath();
        ctx.arc(p.x + swayOffset(p, elapsed), p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function resize() {
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = createParticles(
        particleCount(width, height),
        width,
        height,
        Math.random,
      );
      draw();
    }

    function tick(now: number) {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      elapsed += Math.min(dt, 0.1);
      stepParticles(particles, dt, width, height);
      draw();
      frame = requestAnimationFrame(tick);
    }

    function start() {
      if (frame || motion === "still" || document.hidden) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    }

    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function onVisibility() {
      if (document.hidden) stop();
      else start();
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, RESIZE_DEBOUNCE_MS);
    }

    resize();
    start();
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [motion]);

  return <canvas ref={canvasRef} className="absolute inset-0 size-full" />;
}
