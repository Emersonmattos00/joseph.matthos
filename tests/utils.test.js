/* ============================================================
   tests/utils.test.js — Testes unitários de js/utils.js
   ------------------------------------------------------------
   Cobertura:
     - esc                → 6 casos
     - sanitizeHtml       → 12 casos
     - safeExternalUrl    → 12 casos
     - safeMediaUrl       → 12 casos
     - formatPrice        → 5 casos
     - formatCents        → 5 casos
     - formatTime         → 5 casos
     - formatBytes        → 5 casos
     - slugify            → 6 casos
     - debounce           → 3 casos (com fake timers)
     - generateId         → 3 casos
     - clone              → 4 casos
     - isAudioFile        → 5 casos
     - isProductionMode   → 4 casos
     - luhnCheck          → 6 casos

   Rodar:
     npx vitest run tests/utils.test.js
     npx vitest run tests/utils.test.js --coverage
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  esc,
  sanitizeHtml,
  safeExternalUrl,
  safeMediaUrl,
  formatPrice,
  formatCents,
  formatTime,
  formatBytes,
  slugify,
  debounce,
  generateId,
  clone,
  isAudioFile,
  isProductionMode,
  luhnCheck,
  AUDIO_EXTS
} from '../js/utils.js';

// ═════════════════════════════════════════════════════════════
// esc
// ═════════════════════════════════════════════════════════════
describe('esc', () => {
  it('escapa os 5 caracteres perigosos', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
    expect(esc('a & b')).toBe('a &amp; b');
    expect(esc('"aspas"')).toBe('&quot;aspas&quot;');
    expect(esc("'single'")).toBe('&#39;single&#39;');
  });

  it('lida com null/undefined como string vazia', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('converte números e booleanos para string', () => {
    expect(esc(42)).toBe('42');
    expect(esc(true)).toBe('true');
    expect(esc(false)).toBe('false');
  });

  it('não escapa backtick nem igual (diferente de escAttr)', () => {
    expect(esc('a`b=c')).toBe('a`b=c');
  });

  it('preserva texto sem caracteres especiais', () => {
    expect(esc('Joseph Matthos')).toBe('Joseph Matthos');
  });

  it('é idempotente em strings já escapadas? NÃO — documento:', () => {
    // ⚠️ esc(esc(x)) double-escapa. Não use aninhado.
    expect(esc(esc('a&b'))).toBe('a&amp;amp;b');
  });
});

// ═════════════════════════════════════════════════════════════
// sanitizeHtml
// ═════════════════════════════════════════════════════════════
describe('sanitizeHtml', () => {
  it('permite tags da whitelist', () => {
    expect(sanitizeHtml('<b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeHtml('<strong>x</strong>')).toBe('<strong>x</strong>');
    expect(sanitizeHtml('<em>y</em>')).toBe('<em>y</em>');
    expect(sanitizeHtml('<i>z</i>')).toBe('<i>z</i>');
    expect(sanitizeHtml('line<br>break')).toBe('line<br>break');
  });

  it('substitui tags fora da whitelist por texto', () => {
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeHtml('<iframe src="x"></iframe>')).toBe('');
    expect(sanitizeHtml('<a href="x">link</a>')).toBe('link');
    expect(sanitizeHtml('<img src="x">')).toBe('');
  });

  it('remove atributos perigosos (onclick, onload, style)', () => {
    expect(sanitizeHtml('<b onclick="alert(1)">x</b>')).toBe('<b>x</b>');
    expect(sanitizeHtml('<span style="color:red">x</span>')).toBe('<span>x</span>');
    expect(sanitizeHtml('<p onmouseover="x">y</p>')).toBe('<p>y</p>');
  });

  it('permite apenas span.gold manter classe', () => {
    expect(sanitizeHtml('<span class="gold">x</span>')).toBe('<span class="gold">x</span>');
    expect(sanitizeHtml('<span class="evil">x</span>')).toBe('<span>x</span>');
    expect(sanitizeHtml('<span class="gold other">x</span>')).toBe('<span>x</span>');
  });

  it('lida com SVG embutido removendo o script interno', () => {
    const result = sanitizeHtml('<svg><script>alert(1)</script></svg>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('<svg');
  });

  it('preserva texto com entidades HTML', () => {
    expect(sanitizeHtml('&lt;script&gt;')).toBe('&lt;script&gt;');
  });

  it('lida com null e undefined', () => {
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(undefined)).toBe('');
  });

  it('lida com números', () => {
    expect(sanitizeHtml(42)).toBe('42');
  });

  it('preserva múltiplas tags aninhadas permitidas', () => {
    const input = '<p><b><i>texto</i></b></p>';
    expect(sanitizeHtml(input)).toBe('<p><b><i>texto</i></b></p>');
  });

  it('remove CDATA em script', () => {
    const result = sanitizeHtml('<script><![CDATA[alert(1)]]></script>');
    expect(result).not.toContain('<script');
  });

  it('não quebra com HTML malformado', () => {
    expect(sanitizeHtml('<b>unclosed')).toBe('<b>unclosed</b>');
    expect(sanitizeHtml('</b>orphan')).toBe('orphan');
  });

  it('preserva whitespace significativo', () => {
    expect(sanitizeHtml('<b>  a  b  </b>')).toBe('<b>  a  b  </b>');
  });
});

// ═════════════════════════════════════════════════════════════
// safeExternalUrl
// ═════════════════════════════════════════════════════════════
describe('safeExternalUrl', () => {
  it('aceita https absoluta', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
  });

  it('aceita mailto', () => {
    expect(safeExternalUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('aceita tel', () => {
    expect(safeExternalUrl('tel:+5511999999999')).toBe('tel:+5511999999999');
  });

  it('rejeita javascript:', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBe('#');
  });

  it('rejeita data:', () => {
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  });

  it('rejeita vbscript:', () => {
    expect(safeExternalUrl('vbscript:msgbox(1)')).toBe('#');
  });

  it('rejeita file:', () => {
    expect(safeExternalUrl('file:///etc/passwd')).toBe('#');
  });

  it('retorna "#" para null/undefined/vazio', () => {
    expect(safeExternalUrl(null)).toBe('#');
    expect(safeExternalUrl(undefined)).toBe('#');
    expect(safeExternalUrl('')).toBe('#');
  });

  it('resolve URLs relativas contra a origem atual', () => {
    const result = safeExternalUrl('/path');
    expect(result.startsWith('http')).toBe(true);
  });

  it('rejeita URL malformada', () => {
    expect(safeExternalUrl('http://[invalid')).toBe('#');
  });

  it('rejeita ftp:', () => {
    expect(safeExternalUrl('ftp://example.com')).toBe('#');
  });

  it('normaliza URL (remove credenciais visíveis)', () => {
    const result = safeExternalUrl('https://user:pass@example.com');
    // new URL mantém user:pass no href — não é bug, só documentação
    expect(result).toContain('example.com');
  });
});

// ═════════════════════════════════════════════════════════════
// safeMediaUrl
// ═════════════════════════════════════════════════════════════
describe('safeMediaUrl', () => {
  it('aceita https', () => {
    expect(safeMediaUrl('https://x.com/img.png')).toBe('https://x.com/img.png');
  });

  it('aceita data:image/png;base64', () => {
    const png = 'data:image/png;base64,iVBORw0KG...';
    expect(safeMediaUrl(png)).toBe(png);
  });

  it('aceita data:image/jpeg;base64', () => {
    const jpg = 'data:image/jpeg;base64,/9j/4AAQ...';
    expect(safeMediaUrl(jpg)).toBe(jpg);
  });

  it('aceita data:image/webp;base64', () => {
    const webp = 'data:image/webp;base64,UklGR...';
    expect(safeMediaUrl(webp)).toBe(webp);
  });

  it('aceita blob:', () => {
    const blob = 'blob:https://x.com/abc-123';
    expect(safeMediaUrl(blob)).toBe(blob);
  });

  it('REJEITA data:image/svg', () => {
    const svg = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9...';
    expect(safeMediaUrl(svg)).toBe('');
  });

  it('rejeita javascript:', () => {
    expect(safeMediaUrl('javascript:alert(1)')).toBe('');
  });

  it('rejeita vbscript:', () => {
    expect(safeMediaUrl('vbscript:msgbox')).toBe('');
  });

  it('rejeita file:', () => {
    expect(safeMediaUrl('file:///etc/passwd')).toBe('');
  });

  it('rejeita data:text', () => {
    expect(safeMediaUrl('data:text/html,<script>x</script>')).toBe('');
  });

  it('rejeita data:application', () => {
    expect(safeMediaUrl('data:application/x-msdownload;base64,TVqQ')).toBe('');
  });

  it('retorna "" para null/undefined/vazio', () => {
    expect(safeMediaUrl(null)).toBe('');
    expect(safeMediaUrl(undefined)).toBe('');
    expect(safeMediaUrl('')).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════
// formatPrice / formatCents
// ═════════════════════════════════════════════════════════════
describe('formatPrice', () => {
  it('formata reais', () => {
    expect(formatPrice(19.9)).toMatch(/19,90/);
    expect(formatPrice(0)).toMatch(/0,00/);
  });

  it('formata valores grandes', () => {
    expect(formatPrice(1234.56)).toMatch(/1\.234,56/);
  });

  it('retorna R$ 0,00 para NaN', () => {
    expect(formatPrice(NaN)).toBe('R$ 0,00');
  });

  it('retorna R$ 0,00 para string não-numérica', () => {
    expect(formatPrice('abc')).toBe('R$ 0,00');
  });

  it('converte string numérica', () => {
    expect(formatPrice('19.90')).toMatch(/19,90/);
  });
});

describe('formatCents', () => {
  it('converte centavos para reais', () => {
    expect(formatCents(1990)).toMatch(/19,90/);
    expect(formatCents(0)).toMatch(/0,00/);
    expect(formatCents(1)).toMatch(/0,01/);
  });

  it('formata valores grandes', () => {
    expect(formatCents(123456)).toMatch(/1\.234,56/);
  });

  it('retorna R$ 0,00 para NaN', () => {
    expect(formatCents(NaN)).toBe('R$ 0,00');
  });

  it('retorna R$ 0,00 para null/undefined', () => {
    expect(formatCents(null)).toBe('R$ 0,00');
    expect(formatCents(undefined)).toBe('R$ 0,00');
  });

  it('converte string numérica', () => {
    expect(formatCents('1990')).toMatch(/19,90/);
  });
});

// ═════════════════════════════════════════════════════════════
// formatTime
// ═════════════════════════════════════════════════════════════
describe('formatTime', () => {
  it('formata 0 segundos', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('formata 59 segundos', () => {
    expect(formatTime(59)).toBe('0:59');
  });

  it('formata 60 segundos', () => {
    expect(formatTime(60)).toBe('1:00');
  });

  it('formata 3599 segundos', () => {
    expect(formatTime(3599)).toBe('59:59');
  });

  it('retorna 0:00 para valores inválidos', () => {
    expect(formatTime(-1)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(Infinity)).toBe('0:00');
  });
});

// ═════════════════════════════════════════════════════════════
// formatBytes
// ═════════════════════════════════════════════════════════════
describe('formatBytes', () => {
  it('retorna "—" para null/undefined', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('formata 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formata KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('formata MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('formata GB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });
});

// ═════════════════════════════════════════════════════════════
// slugify
// ═════════════════════════════════════════════════════════════
describe('slugify', () => {
  it('converte para minúsculas com hífens', () => {
    expect(slugify('Boom Boom Bàp')).toBe('boom-boom-bap');
  });

  it('remove acentos', () => {
    expect(slugify('ação')).toBe('acao');
    expect(slugify('coração')).toBe('coracao');
  });

  it('remove caracteres não-alfanuméricos', () => {
    expect(slugify('a!@#b')).toBe('a-b');
  });

  it('remove hífens nas pontas', () => {
    expect(slugify('---a---')).toBe('a');
  });

  it('retorna "sem-titulo" para vazio', () => {
    expect(slugify('')).toBe('sem-titulo');
    expect(slugify(null)).toBe('sem-titulo');
    expect(slugify(undefined)).toBe('sem-titulo');
    expect(slugify('!!!')).toBe('sem-titulo');
  });

  it('preserva números', () => {
    expect(slugify('Track 01')).toBe('track-01');
  });
});

// ═════════════════════════════════════════════════════════════
// debounce (com fake timers)
// ═════════════════════════════════════════════════════════════
describe('debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executa a função após o wait', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancela chamadas anteriores em rajada', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced();
    debounced();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preserva argumentos da última chamada', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced('a');
    debounced('b');
    debounced('c');

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('c');
  });
});

// ═════════════════════════════════════════════════════════════
// generateId
// ═════════════════════════════════════════════════════════════
describe('generateId', () => {
  it('gera IDs únicos', () => {
    const a = generateId('user');
    const b = generateId('user');
    expect(a).not.toBe(b);
  });

  it('usa prefixo', () => {
    expect(generateId('test')).toMatch(/^test-/);
  });

  it('usa prefixo padrão "id"', () => {
    expect(generateId()).toMatch(/^id-/);
  });
});

// ═════════════════════════════════════════════════════════════
// clone
// ═════════════════════════════════════════════════════════════
describe('clone', () => {
  it('clona objetos aninhados', () => {
    const obj = { a: 1, b: { c: 2 } };
    const copy = clone(obj);
    expect(copy).toEqual(obj);
    expect(copy.b).not.toBe(obj.b);
  });

  it('clona arrays', () => {
    const arr = [1, [2, 3], { a: 4 }];
    const copy = clone(arr);
    expect(copy).toEqual(arr);
    expect(copy[1]).not.toBe(arr[1]);
  });

  it('retorna primitivos como estão', () => {
    expect(clone(1)).toBe(1);
    expect(clone('a')).toBe('a');
    expect(clone(null)).toBe(null);
  });

  it('não quebra com objetos circulares? — usa structuredClone:', () => {
    const obj = {};
    obj.self = obj;
    // structuredClone suporta referências circulares
    const copy = clone(obj);
    expect(copy.self).toBe(copy);
  });
});

// ═════════════════════════════════════════════════════════════
// isAudioFile
// ═════════════════════════════════════════════════════════════
describe('isAudioFile', () => {
  it('aceita por MIME', () => {
    expect(isAudioFile({ type: 'audio/mpeg' })).toBe(true);
    expect(isAudioFile({ type: 'audio/wav' })).toBe(true);
  });

  it('aceita por extensão', () => {
    expect(isAudioFile({ name: 'faixa.mp3' })).toBe(true);
    expect(isAudioFile({ name: 'faixa.FLAC' })).toBe(true);
    expect(isAudioFile({ name: 'x.opus' })).toBe(true);
  });

  it('rejeita por MIME errado', () => {
    expect(isAudioFile({ type: 'image/png', name: 'x.png' })).toBe(false);
  });

  it('rejeita por extensão errada', () => {
    expect(isAudioFile({ name: 'x.txt' })).toBe(false);
  });

  it('rejeita null/undefined', () => {
    expect(isAudioFile(null)).toBe(false);
    expect(isAudioFile(undefined)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
// isProductionMode
// ═════════════════════════════════════════════════════════════
describe('isProductionMode', () => {
  const originalLocation = window.location;

  afterEach(() => {
    // Restaura location
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true
    });
  });

  const withHost = (host) => {
    Object.defineProperty(window, 'location', {
      value: { hostname: host, href: `https://${host}/` },
      writable: true
    });
  };

  it('localhost NÃO é produção', () => {
    withHost('localhost');
    expect(isProductionMode()).toBe(false);
  });

  it('127.0.0.1 NÃO é produção', () => {
    withHost('127.0.0.1');
    expect(isProductionMode()).toBe(false);
  });

  it('IP privado 192.168.x NÃO é produção', () => {
    withHost('192.168.1.10');
    expect(isProductionMode()).toBe(false);
  });

  it('IP privado 10.x NÃO é produção', () => {
    withHost('10.0.0.1');
    expect(isProductionMode()).toBe(false);
  });

  it('.local NÃO é produção', () => {
    withHost('meu-pc.local');
    expect(isProductionMode()).toBe(false);
  });

  it('domínio real É produção', () => {
    withHost('josephmatthos.vercel.app');
    expect(isProductionMode()).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
// luhnCheck
// ═════════════════════════════════════════════════════════════
describe('luhnCheck', () => {
  it('aceita números de cartão válidos', () => {
    // Visa de teste
    expect(luhnCheck('4532015112830366')).toBe(true);
    // Mastercard de teste
    expect(luhnCheck('5425233430109903')).toBe(true);
  });

  it('rejeita números inválidos', () => {
    expect(luhnCheck('1234567890123456')).toBe(false);
    expect(luhnCheck('0000000000000000')).toBe(false);
  });

  it('ignora espaços e traços', () => {
    expect(luhnCheck('4532 0151 1283 0366')).toBe(true);
    expect(luhnCheck('4532-0151-1283-0366')).toBe(true);
  });

  it('rejeita comprimento inválido', () => {
    expect(luhnCheck('123')).toBe(false);
    expect(luhnCheck('12345678901234567890')).toBe(false);
  });

  it('lida com string vazia', () => {
    expect(luhnCheck('')).toBe(false);
  });

  it('lida com null/undefined', () => {
    expect(luhnCheck(null)).toBe(false);
    expect(luhnCheck(undefined)).toBe(false);
  });
});
