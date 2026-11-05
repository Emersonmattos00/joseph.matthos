import { describe, it, expect } from 'vitest';

import {
  getByPath,
  setByPath,
  sanitizeHtml,
  stripHtml,
  esc,
  escAttr
} from '../js/admin/ui/dom.js';

describe('Admin DOM helpers', () => {
  it('lê propriedades aninhadas', () => {
    expect(getByPath({ hero: { title: 'Joseph' } }, 'hero.title')).toBe('Joseph');
  });

  it('bloqueia prototype pollution', () => {
    const obj = {};
    expect(setByPath(obj, '__proto__.admin', true)).toBe(false);
    expect(setByPath(obj, 'constructor.prototype.admin', true)).toBe(false);
    expect({}.admin).toBeUndefined();
  });

  it('grava propriedades válidas', () => {
    const obj = {};
    expect(setByPath(obj, 'hero.title', 'Joseph Matthos')).toBe(true);
    expect(obj.hero.title).toBe('Joseph Matthos');
  });

  it('remove scripts completamente', () => {
    expect(sanitizeHtml('<p>Texto</p><script>alert(1)</script>')).toBe('<p>Texto</p>');
  });

  it('preserva tags permitidas', () => {
    expect(sanitizeHtml('<strong>Texto</strong>')).toBe('<strong>Texto</strong>');
  });

  it('remove atributos de eventos', () => {
    expect(sanitizeHtml('<b onclick="alert(1)">Texto</b>')).toBe('<b>Texto</b>');
  });

  it('rejeita javascript em links', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">Link</a>')).toBe('<a>Link</a>');
  });

  it('escapa conteúdo HTML', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
  });

  it('remove tags do texto', () => {
    expect(stripHtml('<p>Joseph <b>Matthos</b></p>')).toBe('Joseph Matthos');
  });
});
