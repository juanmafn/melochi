import { Menu, type MenuItemConstructorOptions } from 'electron';
import { LANGS, type ChatGameKind, type Lang, type MinigameKind, type PanelId } from '../shared/types';
import type { I18n } from './i18n';
import type { Settings } from './save';

export interface MenuActions {
  openPanel(panel: PanelId): void;
  openMusic(): void;
  openChat(): void;
  play: {
    can(kind: MinigameKind): boolean;
    start(kind: MinigameKind): void;
    canChat(): boolean;
    chat(kind: ChatGameKind): void;
  };
  ai: {
    enabled(): boolean;
    setEnabled(on: boolean): void;
    models(): string[];
    model(): string;
    setModel(model: string): void;
    gpu(): boolean;
    setGpu(on: boolean): void;
    forget(): void;
  };
  setDnd(minutes: number): void;
  goHome(): void;
  setHomeHere(): void;
  setLang(lang: Lang): void;
  setMuted(muted: boolean): void;
  selectSkin(id: string): void;
  listSkins(): string[];
  currentSkin(): string;
  openSkinsFolder(): void;
  openConfigFolder(): void;
  reloadSkin(): void;
  quit(): void;
}

const LANG_NAMES: Record<Lang, string> = { es: 'Español', en: 'English' };

/** Menú de la mascota (clic derecho) y del icono de la bandeja. */
export function buildPetMenu(i18n: I18n, settings: Settings, a: MenuActions): Menu {
  const t = (key: string, vars?: Record<string, string>) => i18n.t('menu', key, vars);
  const dndActive = settings.dndUntil > Date.now();
  const until = new Date(settings.dndUntil).toLocaleTimeString(i18n.lang, { hour: '2-digit', minute: '2-digit' });

  const models = a.ai.models();
  const modelItems: MenuItemConstructorOptions[] = models.length
    ? models.map((m) => ({ label: m, type: 'radio', checked: a.ai.model() === m, click: () => a.ai.setModel(m) }))
    : [{ label: t('aiNoModels'), enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    { label: t('talk'), click: () => a.openChat() },
    { type: 'separator' },
    { label: t('inventory'), click: () => a.openPanel('inventory') },
    { label: t('stats'), click: () => a.openPanel('stats') },
    {
      label: t('play'),
      submenu: [
        ...(['rps', 'song', 'hide'] as MinigameKind[]).map((kind) => ({
          label: t(`play_${kind}`),
          enabled: a.play.can(kind),
          click: () => a.play.start(kind),
        })),
        { type: 'separator' as const },
        ...(['riddles', 'trivia', 'story'] as ChatGameKind[]).map((kind) => ({
          label: t(`play_${kind}`),
          enabled: a.play.canChat(),
          click: () => a.play.chat(kind),
        })),
      ],
    },
    { type: 'separator' },
    {
      label: dndActive ? t('dndActive', { time: until }) : t('dnd'),
      submenu: [
        { label: t('dnd15'), click: () => a.setDnd(15) },
        { label: t('dnd30'), click: () => a.setDnd(30) },
        { label: t('dnd60'), click: () => a.setDnd(60) },
        { type: 'separator' },
        { label: t('dndOff'), enabled: dndActive, click: () => a.setDnd(0) },
      ],
    },
    { label: t('goHome'), click: () => a.goHome() },
    { label: t('setHome'), click: () => a.setHomeHere() },
    { type: 'separator' },
    {
      label: t('settings'),
      submenu: [
        { label: t('music'), click: () => a.openMusic() },
        {
          label: t('ai'),
          submenu: [
            { label: t('aiEnabled'), type: 'checkbox', checked: a.ai.enabled(), click: (item) => a.ai.setEnabled(item.checked) },
            { label: t('aiModel'), submenu: modelItems },
            { label: t('aiGpu'), type: 'checkbox', checked: a.ai.gpu(), click: (item) => a.ai.setGpu(item.checked) },
            { type: 'separator' },
            { label: t('aiForget'), click: () => a.ai.forget() },
          ],
        },
        { type: 'separator' },
        {
          label: t('language'),
          submenu: LANGS.map((lang) => ({
            label: LANG_NAMES[lang],
            type: 'radio' as const,
            checked: settings.lang === lang,
            click: () => a.setLang(lang),
          })),
        },
        { label: t('mute'), type: 'checkbox', checked: settings.muted, click: (item) => a.setMuted(item.checked) },
        { type: 'separator' },
        {
          label: 'Skin',
          submenu: a.listSkins().map((id) => ({
            label: id,
            type: 'radio' as const,
            checked: a.currentSkin() === id,
            click: () => a.selectSkin(id),
          })),
        },
        { label: t('reloadSkin'), click: () => a.reloadSkin() },
        { label: t('openSkins'), click: () => a.openSkinsFolder() },
        { label: t('openConfig'), click: () => a.openConfigFolder() },
      ],
    },
    { type: 'separator' },
    { label: t('quit'), click: () => a.quit() },
  ];
  return Menu.buildFromTemplate(template);
}
