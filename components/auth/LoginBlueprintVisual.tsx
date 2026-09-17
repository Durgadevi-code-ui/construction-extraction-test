/**
 * "Living Blueprint" visual for the login page's left panel — the
 * actual reference photo (public/living-blueprint.jpg: a miniature
 * building model mid-construction, crane overhead, set in greenery on
 * an architectural blueprint), not a drawn illustration. A very subtle
 * steel-blue/teal wash ties it into the app's palette without
 * flattening its natural, photographic feel. Purely decorative —
 * `object-cover` fills its panel without affecting that panel's size,
 * so it never changes the page's height/scroll behavior.
 */
export default function LoginBlueprintVisual() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- same plain-<img> convention this app already uses for static assets (see TopNav/DashboardShell logo usage); object-cover fills the panel exactly */}
      <img
        src="/living-blueprint.jpg"
        alt="Miniature building model under construction, crane overhead, set among greenery on an architectural blueprint"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div
        className="absolute inset-0 bg-gradient-to-t from-[#18323F]/75 via-[#18323F]/15 to-[#159A9C]/10"
        aria-hidden="true"
      />
    </>
  );
}
