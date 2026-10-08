import type { ChatApi } from '../../preload/chat';
import type { ChatWindowState } from '../../shared/types';

declare global {
  interface Window {
    melochiChat: ChatApi;
  }
}

const api = window.melochiChat;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $('log');
const input = $<HTMLInputElement>('input');
let lastCount = -1;

function s(state: ChatWindowState, key: string, vars: Record<string, string> = {}): string {
  return (state.strings[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function render(state: ChatWindowState): void {
  document.documentElement.lang = state.strings.lang ?? 'es';
  $('name').textContent = state.petName;
  const status = $('status');
  status.className = state.status === 'online' ? '' : 'offline';
  status.textContent =
    state.status === 'online' ? `${state.moodName} · ${state.model}` : s(state, `status_${state.status}`, { model: state.model });
  input.placeholder = s(state, 'placeholder', { name: state.petName });
  $<HTMLButtonElement>('send').disabled = state.busy;
  $('typing').hidden = !state.busy;
  $('typing').textContent = s(state, 'typing', { name: state.petName });
  $('close').setAttribute('aria-label', s(state, 'close'));

  if (state.messages.length !== lastCount) {
    lastCount = state.messages.length;
    log.replaceChildren();
    if (!state.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = s(state, 'empty', { name: state.petName });
      log.appendChild(empty);
    }
    for (const m of state.messages) {
      const div = document.createElement('div');
      div.className = `msg ${m.role}`;
      div.textContent = m.text;
      div.title = new Date(m.at).toLocaleString();
      log.appendChild(div);
    }
    log.scrollTop = log.scrollHeight;
  }
}

$<HTMLFormElement>('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api.send(text);
  input.focus();
});

$('close').addEventListener('click', () => api.close());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});

api.onState(render);
render(await api.getState());
input.focus();
