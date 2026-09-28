/* ============================================================
   vitest.config.js — Configuração do Vitest
   ------------------------------------------------------------
   Ambiente: jsdom (para DOMParser, window.location, etc).
   ============================================================ */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['js/utils.js', 'js/admin/ui/dom.js'],
      exclude: ['**/*.test.js']
    }
  }
});
