import { contextBridge, ipcRenderer } from 'electron';
import { toMain, toOverlay } from '../shared/ipc';
import type { InteractionType, OverlayInit, PetPose, SkinManifest } from '../shared/types';

type Listener = (payload: any) => void;

const api = {
  getInit: (): Promise<OverlayInit | null> => ipcRenderer.invoke(toMain.getInit),
  getSkin: (): Promise<SkinManifest> => ipcRenderer.invoke(toMain.getSkin),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send(toMain.setIgnoreMouse, ignore),
  handoff: (pose: PetPose, targetDisplayId: number) => ipcRenderer.send(toMain.handoff, pose, targetDisplayId),
  reportPose: (pose: PetPose) => ipcRenderer.send(toMain.reportPose, pose),
  dragStart: (offX: number, offY: number) => ipcRenderer.send(toMain.dragStart, offX, offY),
  dragEnd: () => ipcRenderer.send(toMain.dragEnd),
  interact: (type: InteractionType) => ipcRenderer.send(toMain.interact, type),
  teleportHome: () => ipcRenderer.send(toMain.teleportHome),
  contextMenu: () => ipcRenderer.send(toMain.contextMenu),
  useItem: (slotIndex: number) => ipcRenderer.send(toMain.useItem, slotIndex),
  collect: (groundId: string) => ipcRenderer.send(toMain.collect, groundId),
  choose: (promptId: string, choiceId: string) => ipcRenderer.send(toMain.choose, promptId, choiceId),
  on: (channel: (typeof toOverlay)[keyof typeof toOverlay], listener: Listener) => {
    ipcRenderer.on(channel, (_e, payload) => listener(payload));
  },
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('melochi', api);
