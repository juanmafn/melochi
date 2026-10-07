import { contextBridge, ipcRenderer } from 'electron';
import { musicChannels } from '../shared/ipc';
import type { MusicWindowState, PlaylistRef } from '../shared/types';

const api = {
  getState: (refresh = false): Promise<MusicWindowState> => ipcRenderer.invoke(musicChannels.getState, refresh),
  setClientId: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(musicChannels.setClientId, id),
  connect: (): Promise<MusicWindowState> => ipcRenderer.invoke(musicChannels.connect),
  disconnect: (): Promise<MusicWindowState> => ipcRenderer.invoke(musicChannels.disconnect),
  setPlaylists: (moodId: string, list: PlaylistRef[]): Promise<boolean> => ipcRenderer.invoke(musicChannels.setPlaylists, moodId, list),
  test: (moodId: string): Promise<string> => ipcRenderer.invoke(musicChannels.test, moodId),
  openDashboard: (): Promise<void> => ipcRenderer.invoke(musicChannels.openDashboard),
  openConfig: (): Promise<void> => ipcRenderer.invoke(musicChannels.openConfig),
};

export type MusicApi = typeof api;

contextBridge.exposeInMainWorld('melochiMusic', api);
