#!/usr/bin/env node
/* ============================================================
   scripts/hash-admin-password.js
   ------------------------------------------------------------
   Gera ADMIN_PASSWORD_HASH com scrypt para colar no Vercel.

   Uso:
     node scripts/hash-admin-password.js
     node scripts/hash-admin-password.js "senha"
     echo "senha" | node scripts/hash-admin-password.js --stdin

   Formato do hash:
     scrypt$<salt-hex>$<hash-hex>

   Compatível com `verifyScrypt` de api/_lib.js.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const readline = require('readline');

// ─────────────────────────────────────────────────────────────
// Parâmetros do scrypt
// ─────────────────────────────────────────────────────────────
// N = 16384 → ~16 MB de memória, ~50-100 ms em hardware moderno.
// É o padrão recomendado pela OWASP para scrypt (2024).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// ─────────────────────────────────────────────────────────────
// Política de senha
// ─────────────────────────────────────────────────────────────
const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

const COMMON_PASSWORDS = new Set([
  'admin123', 'admin1234', 'administrador', 'password', 'password1',
  'senha123', 'senha12345', '1234567890', '12345678', 'qwerty123',
  'letmein', 'welcome1', 'iloveyou', 'abc12345', '1q2w3e4r',
  'qwertyuiop', 'asdfghjkl', 'trocar123', 'mudar123', 'adminadmin'
]);

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // Modo pipe: --stdin
  if (args[0] === '--stdin') {
    const password = await readStdin();
    if (!password) {
      fail('Nenhuma senha recebida via stdin.');
    }
    return runSingle(password);
  }

  // Modo direto: argumento
  if (args[0] && !args[0].startsWith('--')) {
    return runSingle(args[0]);
  }

  // Modo interativo (padrão)
  return runInteractive();
}

// ─────────────────────────────────────────────────────────────
// Modo interativo
// ─────────────────────────────────────────────────────────────
async function runInteractive() {
  console.log('');
  console.log('🔐  Gerador de ADMIN_PASSWORD_HASH (scrypt)');
  console.log('');

  const password = await promptHidden('Senha: ');
  const confirm = await promptHidden('Confirmar: ');

  if (password !== confirm) {
    fail('As senhas não conferem.');
  }

  if (!validate(password)) {
    fail('Senha rejeitada pela política.');
  }

  await runSingle(password, { interactive: true });
}

// ─────────────────────────────────────────────────────────────
// Geração + validação + output
// ─────────────────────────────────────────────────────────────
async function runSingle(password, { interactive = false } = {}) {
  if (typeof password !== 'string' || !password) {
    fail('Senha inválida.');
  }

  if (!interactive) {
    if (!validate(password)) {
      fail('Senha rejeitada pela política.');
    }
  }

  console.log('');
  console.log('⏳  Gerando hash...');

  const hash = await hashPassword(password);

  console.log('');
  console.log('✅  Hash gerado com sucesso.');
  console.log('');
  console.log('Cole em ADMIN_PASSWORD_HASH no Vercel:');
  console.log('');
  console.log('────────────────────────────────────────────────────');
  console.log(hash);
  console.log('────────────────────────────────────────────────────');
  console.log('');
  console.log('--- Metadados ---');
  console.log(`Algoritmo:  scrypt`);
  console.log(`Salt:       ${SALT_BYTES} bytes (${SALT_BYTES * 8} bits)`);
  console.log(`Hash:       ${SCRYPT_KEYLEN} bytes (${SCRYPT_KEYLEN * 8} bits)`);
  console.log(`N:          ${SCRYPT_N}`);
  console.log(`r:          ${SCRYPT_R}`);
  console.log(`p:          ${SCRYPT_P}`);
  console.log(`Comprimento: ${hash.length} caracteres`);
  console.log('');
  console.log('⚠️  Guarde esta senha em gerenciador de senhas.');
  console.log('⚠️  Não versione este hash em repositório.');
  console.log('');
}

// ─────────────────────────────────────────────────────────────
// Política de senha
// ─────────────────────────────────────────────────────────────
function validate(password) {
  if (typeof password !== 'string') {
    console.error('❌ Senha inválida.');
    return false;
  }

  if (password.length < MIN_LENGTH) {
    console.error(`❌ Senha muito curta (mínimo ${MIN_LENGTH} caracteres).`);
    return false;
  }

  if (password.length > MAX_LENGTH) {
    console.error(`❌ Senha muito longa (máximo ${MAX_LENGTH} caracteres).`);
    return false;
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    console.error('❌ Senha muito comum. Escolha outra.');
    return false;
  }

  // Rejeita sequências óbvias (123456..., abcdef...)
  if (/^(.)\1+$/.test(password)) {
    console.error('❌ Senha com caracteres repetidos.');
    return false;
  }

  // Exige variedade razoável
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  const variety = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;

  if (variety < 3) {
    console.error(
      '❌ Use pelo menos 3 tipos: minúsculas, maiúsculas, dígitos, símbolos.'
    );
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Hash
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES);

    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) return reject(err);
        const hash = `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
        resolve(hash);
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────
// Input helpers
// ─────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      resolve(data.trim().replace(/\r?\n$/, ''));
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    let password = '';

    // Esconde o que o usuário digita
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      if (typeof chunk === 'string' && /[^\n]/.test(chunk)) {
        // Não ecoa caracteres digitados
        return true;
      }
      return originalWrite(chunk, ...args);
    };

    process.stdout.write(question);

    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') {
        // Enter → finaliza
        process.stdin.removeListener('data', onData);
        process.stdout.write = originalWrite;
        process.stdout.write('\n');
        rl.close();
        resolve(password);
        return;
      }
      if (s === '\u0003') {
        // Ctrl+C → aborta
        process.stdout.write = originalWrite;
        process.stdout.write('\n');
        rl.close();
        reject(new Error('Cancelado'));
        return;
      }
      if (s === '\u007F' || s === '\b') {
        // Backspace
        password = password.slice(0, -1);
        return;
      }
      // Ignora outros caracteres de controle
      if (s >= ' ') password += s;
    };

    process.stdin.on('data', onData);
  });
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  });
}