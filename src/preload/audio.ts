import { contextBridge, ipcRenderer } from 'electron';
import { audioChannels } from '../shared/ipc';
import type { AudioStatus } from '../shared/types';

const api = {
  onStart: (fn: () => void) => ipcRenderer.on(audioChannels.start, () => fn()),
  onStop: (fn: () => void) => ipcRenderer.on(audioChannels.stop, () => fn()),
  beat: (periodMs: number) => ipcRenderer.send(audioChannels.beat, periodMs),
  status: (s: AudioStatus) => ipcRenderer.send(audioChannels.status, s),
  error: (msg: string) => ipcRenderer.send(audioChannels.error, msg),
};

export type AudioApi = typeof api;

contextBridge.exposeInMainWorld('melochiAudio', api);
