require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

/* ============================================================
   backfill-fullpath.js — DL-01 (correção de dados)
   ------------------------------------------------------------
   O catálogo legado tem full_path NULL (migração 0001 criou a
   coluna sem backfill; os scripts antigos só populavam
   stream_key). O painel usa full_path nos downloads e no
   player de teste; o site público usa stream_key — por isso
   o site funcionava e o painel não baixava.

   O que faz (guardas inclusas):
   1. Copia stream_key → full_path onde full_path IS NULL
      (excluindo stream_key apontando para 'previews/%', que é
      caminho de prévia, não de áudio completo);
   2. Informa quantas faixas têm preview_path NULL com
      preview_key preenchido (APENAS diagnóstico — não escreve).

   Como rodar:
     DRY_RUN=true  (padrão) → só mostra o que faria
     DRY_RUN=false node backfill-fullpath.js   → aplica
   Requisitos: DATABASE_URL no .env.local (mesma convenção dos
   demais scripts de manutenção do projeto).
   ============================================================ */

const sql = neon(process.env.DATABASE_URL);
const DRY_RUN = process.env.DRY_RUN !== 'false';

async function main() {
  console.log(`🔧 backfill-fullpath.js — DRY_RUN=${DRY_RUN}\n`);

  const candidates = await sql`
    SELECT id, title, stream_key
    FROM tracks
    WHERE full_path IS NULL
      AND stream_key IS NOT NULL
      AND stream_key <> ''
      AND stream_key NOT LIKE 'previews/%'
    ORDER BY id ASC`;

  console.log(`Faixas com full_path NULL e stream_key utilizável: ${candidates.length}\n`);
  for (const t of candidates) {
    console.log(`  • [${t.id}] "${t.title}" → full_path = "${t.stream_key}"`);
  }

  if (!candidates.length) {
    console.log('\n✅ Nada a fazer: nenhum full_path NULL com stream_key utilizável.');
  } else if (DRY_RUN) {
    console.log('\n⏸  DRY_RUN ativo — nada foi escrito. Para aplicar:');
    console.log('   DRY_RUN=false node backfill-fullpath.js');
  } else {
    let ok = 0, fail = 0;
    for (const t of candidates) {
      try {
        await sql`UPDATE tracks SET full_path = ${t.stream_key} WHERE id = ${t.id}`;
        ok++;
      } catch (err) {
        fail++;
        console.error(`  ❌ [${t.id}] ${err.message}`);
      }
    }
    console.log(`\n✅ full_path preenchido em ${ok} faixa(s)${fail ? `, ${fail} falha(s)` : ''}.`);
  }

  const [diag] = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE full_path IS NULL)::int AS full_path_nulos,
      COUNT(*) FILTER (WHERE preview_path IS NULL AND preview_key IS NOT NULL)::int AS preview_path_nulos_com_key,
      COUNT(*) FILTER (WHERE stream_key LIKE 'previews/%')::int AS stream_key_apontando_preview
    FROM tracks`;

  console.log('\n📊 Diagnóstico da tabela tracks:');
  console.log(`   total de faixas:                          ${diag.total}`);
  console.log(`   full_path ainda NULL:                     ${diag.full_path_nulos}`);
  console.log(`   preview_path NULL (com preview_key):      ${diag.preview_path_nulos_com_key}  ← só diagnóstico, não alterado`);
  console.log(`   stream_key ainda apontando 'previews/%':  ${diag.stream_key_apontando_preview}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('❌', err.message); process.exit(1); });
