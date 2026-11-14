// jsdom 에 없는 브라우저 API(Electron 의 Chromium 에는 있다). astryx Dialog 가 CSS.escape 를 쓴다
const g = globalThis as { CSS?: { escape?: (s: string) => string } };
if (!g.CSS?.escape) g.CSS = { ...g.CSS, escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
// jsdom 의 <dialog> 에 showModal·close 가 없다
const D = (globalThis as { HTMLDialogElement?: { prototype: { showModal?: () => void; close?: () => void; show?: () => void } } }).HTMLDialogElement;
if (D && !D.prototype.showModal) {
  D.prototype.showModal = function (this: HTMLElement) { this.setAttribute('open', ''); };
  D.prototype.show = function (this: HTMLElement) { this.setAttribute('open', ''); };
  D.prototype.close = function (this: HTMLElement) { this.removeAttribute('open'); };
}
