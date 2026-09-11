"use client";

import { useEffect, useRef } from "react";

/**
 * Purely decorative ambient background — a continuously-moving, organic
 * network of warm-orange particles: independent drift per particle,
 * distance-based connections that fade in/out as particles move (never
 * fixed lines), and soft glow on a minority of "brighter" nodes. No
 * grid, no fixed geometric shapes, no two particles behaving
 * identically — see PARTICLE_COUNT/spawnParticle below for exactly
 * where that variation comes from. No text, content, or business
 * information of any kind lives here or ever should.
 *
 * Canvas-based (one <canvas>, not one DOM element per particle) to stay
 * cheap, and nothing here ever touches React state — the animation loop
 * mutates plain JS objects only, so no re-render is triggered per
 * frame. `pointer-events-none` and `fixed inset-0 z-0` keep it strictly
 * behind and never blocking real content/clicks/typing (see
 * app/layout.tsx, which renders this once, before the actual page in a
 * higher z-index wrapper). Being `fixed` to the viewport (not
 * positioned to page height) also means it's already present behind
 * whatever is on-screen at any scroll position, including empty space
 * further down a tall page, without needing to know that page's
 * content height.
 *
 * Respects prefers-reduced-motion: renders one static frame (particles
 * placed, connections drawn, no glow pulse, no drift) and never starts
 * the requestAnimationFrame loop at all, rather than just slowing it
 * down.
 */
export default function BackgroundFX() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    const LINK_DISTANCE = 170;

    /** Mobile 15-25 / Tablet 20-35 / Desktop 30-55 / Large desktop
     * 40-65 — a random count within the band per viewport width, so a
     * reload doesn't always show the exact same density either. */
    function particleCountForWidth(w: number): number {
      const [min, max] = w < 640 ? [15, 25] : w < 1024 ? [20, 35] : w < 1440 ? [30, 55] : [40, 65];
      return Math.round(min + Math.random() * (max - min));
    }

    type Particle = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      /** Each particle's own speed ceiling — never uniform. */
      maxSpeed: number;
      radius: number;
      /** Baseline dot opacity — varies per particle so the field never
       * looks like identical stamped copies. */
      baseAlpha: number;
      /** ~1 in 5 particles render with a soft canvas glow (shadowBlur)
       * instead of a plain dot — "occasional slightly brighter nodes,"
       * never all of them (would look like a uniform pattern, and cost
       * more to render every frame). */
      glow: boolean;
      /** Slow per-particle wander clock — nudges heading gently over
       * time instead of a hard bounce-only path, so movement reads as
       * organic drift rather than a bouncing-ball geometry. */
      wanderPhase: number;
      wanderSpeed: number;
    };

    function spawnParticle(): Particle {
      const maxSpeed = 0.05 + Math.random() * 0.13; // distinct per particle
      const angle = Math.random() * Math.PI * 2;
      const speed = maxSpeed * (0.4 + Math.random() * 0.6);
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        maxSpeed,
        radius: 1 + Math.random() * 1.6,
        baseAlpha: 0.22 + Math.random() * 0.22,
        glow: Math.random() < 0.2,
        wanderPhase: Math.random() * Math.PI * 2,
        wanderSpeed: 0.0006 + Math.random() * 0.0008,
      };
    }

    let particles: Particle[] = Array.from({ length: particleCountForWidth(width) }, spawnParticle);

    let frameId: number | undefined;

    function draw() {
      ctx!.clearRect(0, 0, width, height);

      if (!reduceMotion) {
        for (const p of particles) {
          // Slow heading wander: a gentle sinusoidal nudge to velocity
          // direction, not a random jump — this is what makes the path
          // curve organically instead of bouncing in straight lines.
          p.wanderPhase += p.wanderSpeed;
          const wander = Math.sin(p.wanderPhase) * 0.01;
          const angle = Math.atan2(p.vy, p.vx) + wander;
          const speed = Math.min(p.maxSpeed, Math.hypot(p.vx, p.vy));
          p.vx = Math.cos(angle) * speed;
          p.vy = Math.sin(angle) * speed;

          p.x += p.vx;
          p.y += p.vy;

          // Smooth reflect at the edges — no teleport/wrap (which would
          // read as a sudden reposition), just a natural bounce back
          // into the field.
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height) p.vy *= -1;
        }
      }

      // Dynamic connections: recomputed every frame from current
      // positions only — nothing here is a fixed/stored line, so a
      // connection appears the instant two particles drift within
      // range and fades the instant they drift apart.
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DISTANCE) {
            // Non-linear falloff (closer pairs brighten disproportionately
            // faster than they fade) reads as a more natural "close ->
            // noticeably connected, far -> barely there" curve than a
            // flat linear ramp.
            const closeness = 1 - dist / LINK_DISTANCE;
            const alpha = Math.pow(closeness, 1.6) * 0.16;
            ctx!.strokeStyle = `rgba(255, 107, 0, ${alpha})`;
            ctx!.lineWidth = 1;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.stroke();
          }
        }
      }

      for (const p of particles) {
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        if (p.glow) {
          ctx!.shadowColor = "rgba(255, 107, 0, 0.55)";
          ctx!.shadowBlur = 8;
          ctx!.fillStyle = `rgba(255, 140, 26, ${p.baseAlpha + 0.15})`;
        } else {
          ctx!.shadowBlur = 0;
          ctx!.fillStyle = `rgba(255, 140, 26, ${p.baseAlpha})`;
        }
        ctx!.fill();
      }
      ctx!.shadowBlur = 0;

      if (!reduceMotion) {
        frameId = requestAnimationFrame(draw);
      }
    }
    draw();

    let resizeTimer: ReturnType<typeof setTimeout>;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resize();
        // Re-seed the particle set to match the new viewport's target
        // density band (e.g. resizing from mobile to desktop width
        // should bring the count up, not leave a sparse mobile set
        // stretched across a wide screen).
        particles = Array.from({ length: particleCountForWidth(width) }, spawnParticle);
        if (reduceMotion) draw();
      }, 200);
    }
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
