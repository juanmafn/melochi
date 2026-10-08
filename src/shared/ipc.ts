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
  choose: 'bubble:choose',
  openChat: 'chat:open',
  toyDone: 'toy:done',
  dismissNote: 'note:dismiss',
  fled: 'pet:fled',
  climbAbort: 'pet:climb-abort',
} as const;

export const chatChannels = {
  getState: 'chat:get-state',
  send: 'chat:send',
  close: 'chat:close',
  /** main → ventana de chat */
  state: 'chat:state',
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
  toy: 'toy:start',
  hint: 'game:hint',
  unperch: 'pet:unperch',
  /** Golpe de ritmo de la música (periodo en ms). */
  beat: 'music:beat',
  climb: 'pet:climb',
} as const;

/** Ventana oculta que escucha el audio del PC para sacar el ritmo. */
export const audioChannels = {
  /** main → ventana */
  start: 'audio:start',
  stop: 'audio:stop',
  /** ventana → main */
  beat: 'audio:beat',
  status: 'audio:status',
  error: 'audio:error',
} as const;

export const musicChannels = {
  getState: 'music:get-state',
  setClientId: 'music:set-client-id',
  connect: 'music:connect',
  disconnect: 'music:disconnect',
  setPlaylists: 'music:set-playlists',
  test: 'music:test',
  openDashboard: 'music:open-dashboard',
  openConfig: 'music:open-config',
} as const;

export const setupChannels = {
  getInfo: 'setup:get-info',
  submit: 'setup:submit',
  setLang: 'setup:set-lang',
} as const;
