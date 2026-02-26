(() => {
  const STORAGE_KEY = "ui_theme";
  const DARK = "dark";
  const LIGHT = "light";

  function getStoredTheme() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === DARK || stored === LIGHT ? stored : null;
    } catch (_error) {
      return null;
    }
  }

  function prefersDark() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function resolveTheme() {
    const stored = getStoredTheme();
    if (stored) return stored;
    return prefersDark() ? DARK : LIGHT;
  }

  function applyTheme(theme) {
    const safeTheme = theme === DARK ? DARK : LIGHT;
    document.documentElement.setAttribute("data-theme", safeTheme);
    document.documentElement.style.colorScheme = safeTheme;
    return safeTheme;
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_error) {}
  }

  function setTheme(theme, persist = true) {
    const applied = applyTheme(theme);
    if (persist) saveTheme(applied);
    return applied;
  }

  function getTheme() {
    return document.documentElement.getAttribute("data-theme") || resolveTheme();
  }

  function updateToggleLabel(button, theme) {
    if (!button) return;
    const isDark = theme === DARK;
    button.textContent = isDark ? "Modo claro" : "Modo escuro";
    button.setAttribute("aria-label", isDark ? "Ativar modo claro" : "Ativar modo escuro");
  }

  function bindToggle(button) {
    if (!button) return;

    const syncLabel = () => updateToggleLabel(button, getTheme());
    syncLabel();

    button.addEventListener("click", () => {
      const next = getTheme() === DARK ? LIGHT : DARK;
      setTheme(next, true);
      syncLabel();
    });
  }

  applyTheme(resolveTheme());

  if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", () => {
      if (getStoredTheme()) return;
      applyTheme(resolveTheme());
    });
  }

  window.ThemeController = {
    bindToggle,
    getTheme,
    setTheme,
  };
})();
