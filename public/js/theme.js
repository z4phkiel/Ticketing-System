// Applies the saved theme (or the system's) before the page draws, so dark mode never flashes white.
// Loaded as a normal blocking script in <head>; app.js calls window.setTheme from the account menu.
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => localStorage.getItem("theme");
  const apply = dark => {
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0B1220" : "#2563EB");
    document.dispatchEvent(new CustomEvent("themechange", { detail: { dark } }));
  };
  apply(saved() ? saved() === "dark" : media.matches);
  media.addEventListener("change", e => { if (!saved()) apply(e.matches); });
  // another tab switched the theme: follow it
  window.addEventListener("storage", e => { if (e.key === "theme") apply(e.newValue ? e.newValue === "dark" : media.matches); });
  window.setTheme = dark => { localStorage.setItem("theme", dark ? "dark" : "light"); apply(dark); };
})();
