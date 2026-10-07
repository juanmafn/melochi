import { contextBridge, ipcRenderer } from 'electron';
import { setupChannels } from '../shared/ipc';
import type { Lang } from '../shared/types';

export interface SetupInfo {
  lang: Lang;
  langs: Lang[];
  strings: Record<string, string>;
}

const api = {
  getInfo: (): Promise<SetupInfo> => ipcRenderer.invoke(setupChannels.getInfo),
  setLang: (lang: Lang): Promise<SetupInfo> => ipcRenderer.invoke(setupChannels.setLang, lang),
  submit: (name: string, lang: Lang): Promise<boolean> => ipcRenderer.invoke(setupChannels.submit, name, lang),
};

export type SetupApi = typeof api;

contextBridge.exposeInMainWorld('melochiSetup', api);
