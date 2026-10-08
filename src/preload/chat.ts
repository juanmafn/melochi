import { contextBridge, ipcRenderer } from 'electron';
import { chatChannels } from '../shared/ipc';
import type { ChatWindowState } from '../shared/types';

const api = {
  getState: (): Promise<ChatWindowState> => ipcRenderer.invoke(chatChannels.getState),
  send: (text: string): Promise<void> => ipcRenderer.invoke(chatChannels.send, text),
  close: () => ipcRenderer.send(chatChannels.close),
  onState: (cb: (s: ChatWindowState) => void) => {
    ipcRenderer.on(chatChannels.state, (_e, s: ChatWindowState) => cb(s));
  },
};

export type ChatApi = typeof api;

contextBridge.exposeInMainWorld('melochiChat', api);
