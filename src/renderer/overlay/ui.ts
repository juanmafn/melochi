import { clamp } from '../../shared/displays';
import { VISIBLE_STATS, type DisplayInfo, type GameView, type InventoryView, type PanelId } from '../../shared/types';
import { skinUrl } from './skin';

type Vars = Record<string, string | number>;

function fmt(text: string | undefined, vars?: Vars): string {
  return (text ?? '').replace(/\{(\w+)\}/g, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Icono de un objeto de la skin; si la imagen no existe, muestra la inicial. */
function itemIcon(itemId: string, label: string, skinVersion: number): HTMLElement {
  const img = el('img', 'item-icon');
  img.src = skinUrl(`items/${itemId}.png`, skinVersion);
  img.alt = label;
  img.draggable = false;
  img.onerror = () => {
    const fallback = el('div', 'item-icon item-fallback', label.charAt(0).toUpperCase());
    img.replaceWith(fallback);
  };
  return img;
}

// ---------- Bocadillo ----------

export class Bubble {
  private root = el('div', 'bubble');
  private hideAt = 0;

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root);
  }

  show(text: string): void {
    this.root.textContent = text;
    this.root.classList.add('visible');
    this.hideAt = performance.now() + 2500 + text.length * 60;
  }

  hide(): void {
    this.root.classList.remove('visible');
    this.hideAt = 0;
  }

  /** Se llama cada frame con la posición de la cabeza de la mascota. */
  update(x: number, headY: number, visible: boolean, maxX: number): void {
    if (!visible || (this.hideAt && performance.now() > this.hideAt)) {
      if (this.root.classList.contains('visible')) this.hide();
      return;
    }
    const half = this.root.offsetWidth / 2;
    this.root.style.left = `${clamp(x, half + 8, maxX - half - 8)}px`;
    this.root.style.top = `${Math.max(headY - 10, this.root.offsetHeight + 8)}px`;
  }
}

// ---------- Objetos en el suelo ----------

export class GroundItems {
  private root = el('div', 'ground-layer');
  private nodes = new Map<string, HTMLElement>();

  constructor(
    parent: HTMLElement,
    private display: DisplayInfo,
    private onCollect: (id: string) => void,
  ) {
    parent.appendChild(this.root);
  }

  render(view: GameView, skinVersion: number, force = false): void {
    const mine = view.groundItems.filter((g) => g.displayId === this.display.id);
    const ids = new Set(mine.map((g) => g.id));
    for (const [id, node] of this.nodes) {
      if (!ids.has(id) || force) {
        node.remove();
        this.nodes.delete(id);
      }
    }
    for (const g of mine) {
      if (this.nodes.has(g.id)) continue;
      const wrap = el('button', 'ground-item interactive');
      const name = view.itemNames[g.item] ?? g.item;
      wrap.title = name;
      wrap.appendChild(itemIcon(g.item, name, skinVersion));
      wrap.style.left = `${g.x - this.display.bounds.x}px`;
      wrap.style.top = `${g.y - this.display.bounds.y}px`;
      wrap.addEventListener('click', () => {
        wrap.classList.add('collected');
        this.onCollect(g.id);
      });
      this.root.appendChild(wrap);
      this.nodes.set(g.id, wrap);
    }
  }
}

// ---------- Paneles ----------

abstract class Panel {
  protected root = el('div', 'panel interactive');
  protected body = el('div', 'panel-body');
  private titleEl = el('span', 'panel-title');
  isOpen = false;

  constructor(parent: HTMLElement, id: PanelId) {
    this.root.id = `panel-${id}`;
    const header = el('div', 'panel-header');
    const close = el('button', 'panel-close', '×');
    close.addEventListener('click', () => this.close());
    header.append(this.titleEl, close);
    this.root.append(header, this.body);
    parent.appendChild(this.root);
  }

  protected setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  get rect(): DOMRect | null {
    return this.isOpen ? this.root.getBoundingClientRect() : null;
  }

  /**
   * Abre el panel encima de (anchorX, anchorY). Si hay otro panel abierto (`avoid`),
   * se coloca a su lado, en el hueco donde quepa.
   */
  open(anchorX: number, anchorY: number, maxW: number, maxH: number, avoid?: DOMRect | null): void {
    this.isOpen = true;
    this.root.classList.add('open');
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    let left = anchorX - w / 2;
    let top = anchorY - h - 16;
    if (avoid) {
      const gap = 10;
      left = avoid.right + gap + w <= maxW - 8 ? avoid.right + gap : avoid.left - gap - w;
      top = avoid.bottom - h;
    }
    this.root.style.left = `${clamp(left, 8, maxW - w - 8)}px`;
    this.root.style.top = `${clamp(top, 8, maxH - h - 8)}px`;
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  abstract render(view: GameView, skinVersion: number): void;
}

export class InventoryPanel extends Panel {
  private grid = el('div', 'inv-grid');
  private empty = el('p', 'inv-empty');
  private ghost: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private onUse: (slot: number) => void,
    private isOverPet: (x: number, y: number) => boolean,
  ) {
    super(parent, 'inventory');
    this.body.append(this.empty, this.grid);
  }

  private signature = '';

  render(view: GameView, skinVersion: number): void {
    // Solo se reconstruye si algo visible ha cambiado (si no, se perderían el hover y los arrastres).
    const sig = JSON.stringify([
      view.lang,
      skinVersion,
      view.maxSlots,
      view.inventory.map((s) => [s.item, s.cantidad, s.usosRestantes, Math.ceil(s.cooldownRestante / 60000)]),
    ]);
    if (sig === this.signature || this.ghost) return;
    this.signature = sig;

    const ui = view.ui;
    this.setTitle(ui.inventoryTitle);
    this.empty.textContent = ui.emptyInventory;
    this.empty.hidden = view.inventory.length > 0;
    this.grid.replaceChildren();
    for (let i = 0; i < view.maxSlots; i++) {
      const slot = view.inventory[i];
      this.grid.appendChild(slot ? this.slotNode(slot, i, view, skinVersion) : el('div', 'inv-slot empty'));
    }
  }

  private slotNode(slot: InventoryView, index: number, view: GameView, skinVersion: number): HTMLElement {
    const ui = view.ui;
    const node = el('button', `inv-slot rarity-${slot.rareza}`);
    if (slot.favorito) node.classList.add('fav');
    if (slot.odiado) node.classList.add('hated');
    if (slot.cooldownRestante > 0) node.classList.add('cooling');
    node.appendChild(itemIcon(slot.item, slot.nombre, skinVersion));
    if (slot.cantidad > 1) node.appendChild(el('span', 'badge count', `×${slot.cantidad}`));
    if (slot.usosPorUnidad) node.appendChild(el('span', 'badge uses', `${slot.usosRestantes ?? slot.usosPorUnidad}`));
    if (slot.favorito) node.appendChild(el('span', 'badge mark', '♥'));

    const lines = [slot.nombre, slot.descripcion, ui[`rarity_${slot.rareza}`]];
    if (slot.usosPorUnidad) lines.push(fmt(ui.uses, { n: slot.usosRestantes ?? slot.usosPorUnidad }));
    if (slot.permanente) lines.push(ui.permanent);
    if (slot.favorito) lines.push(ui.favorite);
    if (slot.odiado) lines.push(ui.hated);
    if (slot.cooldownRestante > 0) lines.push(fmt(ui.cooldown, { min: Math.ceil(slot.cooldownRestante / 60000) }));
    node.title = lines.filter(Boolean).join('\n');

    // Clic = dárselo. También se puede arrastrar hasta la mascota.
    node.addEventListener('pointerdown', (e) => this.beginDrag(e, node, index));
    return node;
  }

  private beginDrag(e: PointerEvent, node: HTMLElement, index: number): void {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    node.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
        moved = true;
        const icon = node.querySelector('.item-icon');
        this.ghost = el('div', 'drag-ghost');
        if (icon) this.ghost.appendChild(icon.cloneNode(true));
        document.body.appendChild(this.ghost);
      }
      if (this.ghost) {
        this.ghost.style.left = `${ev.clientX}px`;
        this.ghost.style.top = `${ev.clientY}px`;
      }
    };
    const onUp = (ev: PointerEvent) => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      this.ghost?.remove();
      this.ghost = null;
      if (!moved || this.isOverPet(ev.clientX, ev.clientY)) this.onUse(index);
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
  }
}

export class StatsPanel extends Panel {
  constructor(parent: HTMLElement) {
    super(parent, 'stats');
  }

  render(view: GameView): void {
    const ui = view.ui;
    this.setTitle(fmt(ui.statsTitle, { name: view.petName }));
    const rows: HTMLElement[] = [];

    const mood = el('div', 'stat-mood');
    mood.append(el('span', 'stat-label', ui.mood), el('strong', `mood-name mood-${view.mood.id}`, view.mood.nombre));
    rows.push(mood);

    for (const s of VISIBLE_STATS) {
      const v = Math.round(view.stats[s]);
      const row = el('div', 'stat-row');
      const bar = el('div', 'stat-bar');
      const fill = el('div', `stat-fill stat-${s}${v < 30 ? ' low' : ''}`);
      fill.style.width = `${v}%`;
      bar.appendChild(fill);
      row.append(el('span', 'stat-label', ui[s]), bar, el('span', 'stat-value', String(v)));
      rows.push(row);
    }

    // Afinidad: de -100 a 100, con el centro en 0.
    const aff = Math.round(view.afinidad);
    const affRow = el('div', 'stat-row');
    const affBar = el('div', 'stat-bar affinity');
    const affFill = el('div', `stat-fill ${aff >= 0 ? 'aff-pos' : 'aff-neg'}`);
    affFill.style.left = aff >= 0 ? '50%' : `${50 + aff / 2}%`;
    affFill.style.width = `${Math.abs(aff) / 2}%`;
    affBar.appendChild(affFill);
    affRow.append(el('span', 'stat-label', `${aff >= 0 ? '♥' : '💔'} ${ui.afinidad}`), affBar, el('span', 'stat-value', String(aff)));
    rows.push(affRow);

    if (view.dndUntil > Date.now()) rows.push(el('div', 'dnd-badge', ui.dndBadge));
    this.body.replaceChildren(...rows);
  }
}
