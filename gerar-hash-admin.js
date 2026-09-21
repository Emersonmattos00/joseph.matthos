// gerar-hash-admin.js — gera hash compatível com verifyScrypt() de api/_lib.js
// Uso: node gerar-hash-admin.js "sua-senha-forte"
'use strict';

const crypto = require('crypto');
const readline = require('readline');

function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

async function main() {
  let senha = process.argv[2];

  if (!senha) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    senha = await new Promise((resolve) =>
      rl.question('Digite a nova senha do admin: ', (r) => {
        rl.close();
        resolve(r);
      })
    );
  }

  if (!senha || senha.length < 12) {
    console.error('❌ A senha deve ter pelo menos 12 caracteres.');
    process.exit(1);
  }

  console.log('\n✅ Hash gerado:\n');
  console.log(gerarHash(senha));
  console.log('\nCole este valor em ADMIN_PASSWORD_HASH na Vercel.');
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});