#!/usr/bin/env node
// ============================================================
// gerar-hash-admin.js
// ------------------------------------------------------------
// Gera hash scrypt compatível com verifyScrypt() de api/_lib.js.
//
// Uso:
//   node gerar-hash-admin.js
//     → modo interativo (recomendado — pede confirmação)
//
//   node gerar-hash-admin.js "sua-senha-forte"
//     → modo argumento (⚠️ a senha fica no histórico do shell)
//
// Saída:
//   scrypt$<salt_hex>$<hash_hex>
//
// Cole o resultado em ADMIN_PASSWORD_HASH na Vercel.
// ============================================================

'use strict';

const crypto = require('crypto');
const readline = require('readline');

// ── Parâmetros (devem espelhar verifyScrypt() em api/_lib.js)
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const MIN_PASSWORD_LENGTH = 12;
const PREFIX = 'scrypt';

// ── Gera hash scrypt no formato scrypt$salt$hash
function gerarHash(senha) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(senha, salt, HASH_BYTES);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// ── Verifica se o hash gerado é válido para o formato esperado
function validarHashFormato(hash) {
  const parts = hash.split('$');
  if (parts.length !== 3) return false;
  if (parts[0] !== PREFIX) return false;

  const saltHex = parts[1];
  const hashHex = parts[2];

  // Salt deve ter exatamente SALT_BYTES * 2 caracteres hex
  if (saltHex.length !== SALT_BYTES * 2) return false;
  if (!/^[0-9a-f]+$/i.test(saltHex)) return false;

  // Hash deve ter exatamente HASH_BYTES * 2 caracteres hex
  if (hashHex.length !== HASH_BYTES * 2) return false;
  if (!/^[0-9a-f]+$/i.test(hashHex)) return false;

  return true;
}

// ── Lê senha sem ecoar (modo interativo)
function lerSenhaOculta(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    // Desabilita eco da senha
    const stdin = process.stdin;
    const originalWrite = rl._writeToOutput?.bind(rl);

    if (originalWrite) {
      rl._writeToOutput = function (string) {
        // Só ecoa o prompt e nova linha, esconde o resto
        if (string.includes('\n') || string === prompt) {
          originalWrite(string);
        } else {
          originalWrite('*');
        }
      };
    }

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// ── Modo interativo com confirmação
async function modoInterativo() {
  const senha = await lerSenhaOculta('Digite a nova senha do admin: ');

  if (!senha || senha.length < MIN_PASSWORD_LENGTH) {
    console.error(`\n❌ A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    process.exit(1);
  }

  const confirmacao = await lerSenhaOculta('Confirme a senha: ');

  if (senha !== confirmacao) {
    console.error('\n❌ As senhas não coincidem.');
    process.exit(1);
  }

  return senha;
}

// ── Modo argumento (com aviso)
function modoArgumento(senha) {
  console.warn(
    '\n⚠️  AVISO: a senha passada como argumento fica no histórico do shell\n' +
    '   (.bash_history, .zsh_history) e no `ps` de outros processos.\n' +
    '   Prefira o modo interativo: `node gerar-hash-admin.js`\n'
  );

  if (!senha || senha.length < MIN_PASSWORD_LENGTH) {
    console.error(`❌ A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    process.exit(1);
  }

  return senha;
}

// ── Main
async function main() {
  const arg = process.argv[2];
  const senha = arg ? modoArgumento(arg) : await modoInterativo();

  const hash = gerarHash(senha);

  // Auto-verificação: garante que o formato está correto
  if (!validarHashFormato(hash)) {
    console.error(
      '\n❌ ERRO INTERNO: o hash gerado não está no formato esperado.\n' +
      '   Isso indica incompatibilidade com verifyScrypt() em api/_lib.js.\n' +
      '   Verifique os parâmetros SALT_BYTES e HASH_BYTES neste script.'
    );
    process.exit(1);
  }

  console.log('\n✅ Hash gerado com sucesso:\n');
  console.log(hash);
  console.log('\n📋 Próximos passos:');
  console.log('   1. Copie o hash acima');
  console.log('   2. Vá em Vercel → Settings → Environment Variables');
  console.log('   3. Atualize ADMIN_PASSWORD_HASH');
  console.log('   4. Faça redeploy para o novo valor entrar em vigor\n');
}

main().catch((err) => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});
