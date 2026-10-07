import type { SetupApi, SetupInfo } from '../../preload/setup';
import type { Lang } from '../../shared/types';

declare global {
  interface Window {
    melochiSetup: SetupApi;
  }
}

const LANG_NAMES: Record<Lang, string> = { es: 'Español', en: 'English' };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const langSelect = $<HTMLSelectElement>('lang');
const nameInput = $<HTMLInputElement>('name');

function render(info: SetupInfo): void {
  const s = info.strings;
  for (const id of ['title', 'langLabel', 'nameLabel', 'spotifyLabel', 'spotifySoon', 'start']) {
    $(id).textContent = s[id] ?? id;
  }
  nameInput.placeholder = s.namePlaceholder ?? '';
  document.documentElement.lang = info.lang;
  if (!langSelect.options.length) {
    for (const lang of info.langs) langSelect.add(new Option(LANG_NAMES[lang], lang));
  }
  langSelect.value = info.lang;
}

langSelect.addEventListener('change', async () => {
  render(await window.melochiSetup.setLang(langSelect.value as Lang));
});

$<HTMLFormElement>('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!nameInput.value.trim()) return;
  await window.melochiSetup.submit(nameInput.value, langSelect.value as Lang);
});

render(await window.melochiSetup.getInfo());
nameInput.focus();
