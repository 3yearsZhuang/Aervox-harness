import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/dialog/dialog.js';
import '@material/web/switch/switch.js';
import '@material/web/tabs/tabs.js';
import '@material/web/tabs/primary-tab.js';
import '@material/web/ripple/ripple.js';
import '@material/web/progress/linear-progress.js';
import type { App } from 'vue';
import { material3ContextKey } from './context';
import { material3Palette } from './palette';
import { createMobileBackNavigation, mobileBackNavigationKey } from './mobile-back-navigation';
import './theme.css';
import './settings-layout.css';
import './settings-panels.css';

/** Loads only for the configured Android/mobile build, before Vue mounts. */
export function installMaterial3(app: App, root: HTMLElement = document.documentElement): () => void {
  const light = material3Palette(false), dark = material3Palette(true);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    const selected = root.dataset.theme;
    const palette = selected === 'dark' || selected !== 'light' && system.matches ? dark : light;
    for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
  };
  root.dataset.designSystem = 'material3';
  app.provide(material3ContextKey, true);
  const backNavigation = createMobileBackNavigation();
  app.provide(mobileBackNavigationKey, backNavigation);
  update();
  const observer = new MutationObserver(update);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const systemChanged = () => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem('aervox-theme'); } catch { /* Use the system without storage. */ }
    root.dataset.theme = saved === 'light' || saved === 'dark' ? saved : system.matches ? 'dark' : 'light';
    update();
  };
  system.addEventListener('change', systemChanged);
  const dispose = () => { backNavigation.dispose(); observer.disconnect(); system.removeEventListener('change', systemChanged); };
  app.onUnmount(dispose);
  return dispose;
}
