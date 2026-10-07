import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { setupChannels } from '../shared/ipc';
import { LANGS, type Lang } from '../shared/types';
import type { I18n } from './i18n';
import type { Paths } from './paths';

export interface SetupResult {
  name: string;
  lang: Lang;
}

/** Ventana del primer arranque: idioma y nombre de la mascota. Devuelve null si se cierra sin terminar. */
export function runSetup(paths: Paths, i18n: I18n): Promise<SetupResult | null> {
  return new Promise((resolve) => {
    let result: SetupResult | null = null;
    const win = new BrowserWindow({
      width: 440,
      height: 470,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: 'Melochi',
      show: false,
      backgroundColor: '#fff7ef',
      webPreferences: {
        preload: join(paths.preload, 'setup.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const info = (lang: Lang) => ({ lang, langs: LANGS, strings: i18n.section('setup', lang) });
    ipcMain.handle(setupChannels.getInfo, () => info(i18n.lang));
    ipcMain.handle(setupChannels.setLang, (_e, lang: Lang) => {
      if (LANGS.includes(lang)) i18n.lang = lang;
      return info(i18n.lang);
    });
    ipcMain.handle(setupChannels.submit, (_e, name: string, lang: Lang) => {
      const clean = String(name ?? '').trim().slice(0, 24);
      if (!clean || !LANGS.includes(lang)) return false;
      result = { name: clean, lang };
      win.close();
      return true;
    });

    win.on('closed', () => {
      for (const ch of Object.values(setupChannels)) ipcMain.removeHandler(ch);
      resolve(result);
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(join(paths.renderer, 'setup.html'));
  });
}
