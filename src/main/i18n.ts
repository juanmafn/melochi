import { join } from 'node:path';
import { LANGS, type Lang, type Localized } from '../shared/types';
import { readJson } from './jsonfile';

type Section = 'menu' | 'ui' | 'setup' | 'music' | 'chat';

type LocaleData = Record<Section, Record<string, string>> & {
  bubbles: Record<string, string[]>;
};

type Vars = Record<string, string | number>;

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export class I18n {
  lang: Lang = 'es';
  private data = {} as Record<Lang, LocaleData>;

  constructor(private dir: string) {
    this.reload();
  }

  reload(): void {
    for (const lang of LANGS) {
      this.data[lang] = readJson<LocaleData>(join(this.dir, `${lang}.json`));
    }
  }

  static systemLang(locale: string): Lang {
    return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
  }

  section(name: Section, lang: Lang = this.lang): Record<string, string> {
    return { ...this.data.es[name], ...this.data[lang][name] };
  }

  t(section: Section, key: string, vars?: Vars): string {
    return fill(this.section(section)[key] ?? key, vars);
  }

  hasBubble(key: string): boolean {
    return (this.data[this.lang].bubbles[key] ?? this.data.es.bubbles[key] ?? []).length > 0;
  }

  /** Frase aleatoria de un grupo de bocadillos. */
  bubble(key: string, vars?: Vars): string {
    const options = this.data[this.lang].bubbles[key] ?? this.data.es.bubbles[key] ?? [key];
    return fill(options[Math.floor(Math.random() * options.length)], vars);
  }

  /** Resuelve un texto traducible de la configuración. */
  loc(text: Localized | undefined, fallback = ''): string {
    if (text === undefined) return fallback;
    if (typeof text === 'string') return text;
    return text[this.lang] ?? text.es ?? text.en ?? fallback;
  }
}
