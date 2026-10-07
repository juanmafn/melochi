// Nombres de los canales IPC. "toMain" los envía el renderer; "toOverlay" los envía main.

export const toMain = {
  getInit: 'overlay:get-init',
  getSkin: 'skin:get',
  setIgnoreMouse: 'overlay:set-ignore-mouse',
  handoff: 'pet:handoff',
  reportPose: 'pet:report-pose',
  dragStart: 'pet:drag-start',
  dragEnd: 'pet:drag-end',
  interact: 'pet:interact',
  teleportHome: 'pet:teleport-home',
  contextMenu: 'pet:context-menu',
  useItem: 'inventory:use',
  collect: 'ground:collect',
} as const;

export const toOverlay = {
  state: 'game:state',
  own: 'pet:own',
  release: 'pet:release',
  drag: 'pet:drag',
  throw: 'pet:throw',
  goHome: 'pet:go-home',
  reaction: 'game:reaction',
  say: 'game:say',
  skinReload: 'skin:reload',
  panel: 'ui:panel',
} as const;

export const setupChannels = {
  getInfo: 'setup:get-info',
  submit: 'setup:submit',
  setLang: 'setup:set-lang',
} as const;
