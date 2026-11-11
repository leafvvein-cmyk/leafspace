import { createElement, BookOpen, CalendarDays, Clock3, Search, Tag, Settings, Plus, ChevronLeft, ChevronRight, PenLine, ArrowLeft, Trash2, CloudOff, Check, MoreHorizontal, Download, Sun, Moon, Maximize2, Smile, X, PanelLeftClose, ImagePlus, LockKeyhole } from 'lucide';
import { isNative } from '../services/platform.js';

const icons = { book: BookOpen, calendar: CalendarDays, timeline: Clock3, search: Search, tag: Tag, settings: Settings, plus: Plus, left: ChevronLeft, right: ChevronRight, edit: PenLine, back: ArrowLeft, trash: Trash2, offline: CloudOff, check: Check, more: MoreHorizontal, download: Download, sun: Sun, moon: Moon, focus: Maximize2, smile: Smile, close: X, panel: PanelLeftClose, image: ImagePlus, lock: LockKeyhole };

export function icon(name, size = 20) {
  return createElement(icons[name] ?? BookOpen, { width: size, height: size, 'stroke-width': 1.65, 'aria-hidden': 'true' });
}

export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'className') element.className = value;
    else if (key === 'value') element.value = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

export function button(label, action, { glyph, className = 'button', title, ...attributes } = {}) {
  return h('button', { type: 'button', className, title, onclick: action, ...attributes }, glyph && icon(glyph), h('span', {}, label));
}

export function iconButton(label, glyph, action, className = 'icon-button') {
  return h('button', { type: 'button', className, 'aria-label': label, title: label, onclick: action }, icon(glyph));
}

export async function downloadFile(name, text, type = 'application/json;charset=utf-8') {
  if (isNative) {
    const { shareTextFile } = await import('../services/native-export.js');
    return shareTextFile(name, text);
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = h('a', { href: url, download: name });
  document.body.append(anchor); anchor.click(); anchor.remove();
  // Some browsers finish handing a Blob download to disk after the click has
  // returned. Revoking after one second can cancel it on slower devices or
  // under CPU pressure (notably while Argon2 is also running).
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function toast(message) {
  let target = document.querySelector('#toast');
  if (!target) { target = h('div', { id: 'toast', className: 'toast', role: 'status' }); document.body.append(target); }
  target.textContent = message;
  target.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove('visible'), 4500);
}
