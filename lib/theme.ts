/**
 * App-wide Light/Dark theme — one `data-theme` attribute on <html>,
 * which app/globals.css maps onto the shared color tokens. Light is the
 * default (nothing stored); the choice is remembered per browser.
 */
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

/** Runs inline in <head> (app/layout.tsx) before the first paint, so a
 * saved Dark choice never flashes Light on a full page load. */
export const THEME_INIT_SCRIPT = `(function(){try{if(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)})==="dark")document.documentElement.setAttribute("data-theme","dark")}catch(e){}})()`;
