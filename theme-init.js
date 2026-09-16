(() => {
  'use strict';
  const KEY = 'scanbox.theme';
  const root = document.documentElement;
  const getSystem = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  let pref = 'system';
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') pref = saved;
  } catch {}
  root.dataset.themePreference = pref;
  root.dataset.theme = pref === 'system' ? getSystem() : pref;
})();
