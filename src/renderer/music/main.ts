import type { MusicApi } from '../../preload/music';
import type { MusicWindowState } from '../../shared/types';

declare global {
  interface Window {
    melochiMusic: MusicApi;
  }
}

const api = window.melochiMusic;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: MusicWindowState;

function s(key: string, vars: Record<string, string> = {}): string {
  return (state.strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function errorText(err: string): string {
  if (err === 'PORT_IN_USE') return s('errPort');
  if (err === 'LOGIN_TIMEOUT') return s('errTimeout');
  if (err === 'NO_CLIENT_ID') return s('errClientId');
  if (err.includes('INVALID_CLIENT') || err.includes('invalid_client')) return s('errInvalidClient');
  if (err.includes('403')) return s('errForbidden');
  return `${s('errGeneric')}\n${err}`;
}

function render(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-s]')) node.textContent = s(node.dataset.s!);
  document.title = `Melochi — ${s('title')}`;

  $('connected').hidden = !state.connected;
  $('setup').hidden = state.connected;
  $('status').textContent = s('connectedAs', { user: state.user ?? '…' });
  $('redirect').textContent = state.redirectUri;
  const input = $<HTMLInputElement>('clientId');
  if (document.activeElement !== input) input.value = state.clientId;
  input.placeholder = s('clientIdPlaceholder');
  $('error').hidden = !state.error;
  $('error').textContent = state.error ? errorText(state.error) : '';

  $('favs').textContent = state.favoritos.length ? state.favoritos.join(', ') : s('none');
  $('hated').textContent = state.odiados.length ? state.odiados.join(', ') : s('none');

  $('moodsCard').hidden = !state.connected;
  renderMoods();
}

function renderMoods(): void {
  const list = $('moodList');
  list.replaceChildren();
  for (const mood of state.moods) {
    const box = el('div', 'mood');
    const head = el('div', 'mood-head');
    const test = el('button', 'secondary small', s('test'));
    const result = el('span', 'test-result');
    test.addEventListener('click', async () => {
      result.textContent = '…';
      const r = await api.test(mood.id);
      result.textContent = s(`test_${r}`);
    });
    const right = el('div');
    right.append(result, document.createTextNode(' '), test);
    head.append(el('span', 'mood-name', mood.nombre), right);

    const chips = el('div', 'chips');
    for (const p of mood.playlists) {
      const chip = el('span', 'chip', p.name);
      const remove = el('button', undefined, '×');
      remove.title = s('remove');
      remove.addEventListener('click', () => save(mood.id, mood.playlists.filter((x) => x.uri !== p.uri)));
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
    if (!mood.playlists.length) {
      chips.appendChild(el('span', 'hint', s('noPlaylist', { queries: mood.busqueda.map((q) => `«${q}»`).join(', ') })));
    }

    const select = el('select');
    select.add(new Option(s('addPlaylist'), ''));
    const assigned = new Set(mood.playlists.map((p) => p.uri));
    for (const p of state.library) {
      if (!assigned.has(p.uri)) select.add(new Option(p.owner ? `${p.name} — ${p.owner}` : p.name, p.uri));
    }
    select.addEventListener('change', () => {
      const p = state.library.find((x) => x.uri === select.value);
      if (p) save(mood.id, [...mood.playlists, { uri: p.uri, name: p.name }]);
    });

    box.append(head, chips, select);
    list.appendChild(box);
  }
}

async function save(moodId: string, playlists: { uri: string; name: string }[]): Promise<void> {
  await api.setPlaylists(moodId, playlists);
  state = await api.getState();
  render();
}

async function saveClientId(): Promise<boolean> {
  const input = $<HTMLInputElement>('clientId');
  const res = await api.setClientId(input.value);
  if (!res.ok) {
    state.error = 'NO_CLIENT_ID';
    render();
  }
  return res.ok;
}

$('clientId').addEventListener('change', () => void saveClientId());

$('connect').addEventListener('click', async () => {
  if (!(await saveClientId())) return;
  if (!$<HTMLInputElement>('clientId').value.trim()) {
    state.error = 'NO_CLIENT_ID';
    render();
    return;
  }
  const btn = $<HTMLButtonElement>('connect');
  btn.disabled = true;
  btn.textContent = s('connecting');
  state = await api.connect();
  btn.disabled = false;
  render();
});

$('disconnect').addEventListener('click', async () => {
  state = await api.disconnect();
  render();
});

$('dashboard').addEventListener('click', () => void api.openDashboard());
$('openConfig').addEventListener('click', () => void api.openConfig());
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.redirectUri);
  $('copy').textContent = s('copied');
  setTimeout(() => ($('copy').textContent = s('copy')), 1500);
});

state = await api.getState(true);
render();
