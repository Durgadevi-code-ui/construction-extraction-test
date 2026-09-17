import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hides the built-in dev-mode route indicator (bottom-left "Rendering…"
  // overlay) — framework chrome, not app UI; dev-only, no production
  // effect, and Next 16's devIndicators API has no icon-customization
  // option (only `position` or disabling it entirely).
  devIndicators: false,
};

export default nextConfig;
