require('dotenv').config();
const { eq } = require('drizzle-orm');
const { db } = require('../api/_db');
const { albums } = require('../src/schema.js');

// Mapeamento: slug do álbum → arquivo de imagem no B2
const COVERS = {
  'tornado-da-arte': 'tornadodaarte.webp',
  'mundo-atual': 'mundoatual.webp',
  'contraditorio': 'contraditorio.webp',
  'mar-de-inquiricoes': 'mardeinquiricoes.webp',
  'eu-comigo': 'eucomigo.webp',
  'o-despertar': 'odespertar.webp',
  'boom-boom-bap': 'boomboombap.webp',
  'maquina-do-tempo': 'maquinadotempo.webp',
  'peso-da-caneta': 'pesodacaneta.webp',
  'nada-acabou': 'nadaacabou.webp',
  'ocultos-da-alma': 'ocultosdaalma.webp',
  'razao-do-coracao': 'razaodocoracao.webp',
  'dilemas': 'dilemas.webp',
  'abismo-do-coracao': 'abismodocoracao.webp',
  'ressignifique': 'ressignifique.webp',
  'intima-relacao': 'intimarelacao.webp',
  'caminho-direcao': 'caminhodirecao.webp',
  'historia-infinita': 'historiainfinita.webp',
  'prisoes-invisiveis': 'prisoesinvisiveis.webp',
  'apocalipse-da-emocao': 'apocalisedaemocao.webp',
  'espelho-da-alma': 'espelhodaalma.webp',
  'o-instante': 'oinstante.webp',
  'ainda-da-tempo': 'aindadatempo.webp',
  'jardim-do-coracao': 'jardimdocoracao.webp',
  'mentalidade-de-ouro-v1': 'menatlidadedeourov1.webp',
  'mentalidade-de-ouro-v2': 'menatlidadedeourov2.webp',
  'mentalidade-de-ouro-v3': 'menatlidadedeourov3.webp',
  'mentalidade-de-ouro-v4': 'menatlidadedeourov4.webp',
  'mentalidade-de-ouro-v5': 'menatlidadedeourov5.webp',
  'poesia-viva': 'poesiaviva.webp',
};

const B2_BASE = 'https://f005.backblazeb2.com/file/joseph.matthos/assets/img';

async function main() {
  console.log('🖼️  Populando capas dos álbuns...\n');

  const allAlbums = await db.select().from(albums);
  let updated = 0;
  let skipped = 0;

  for (const album of allAlbums) {
    const coverFile = COVERS[album.slug];

    if (!coverFile) {
      console.log('⚠️  Sem mapeamento para: ' + album.slug);
      skipped++;
      continue;
    }

    const coverUrl = B2_BASE + '/' + coverFile;

    if (album.coverUrl === coverUrl) {
      skipped++;
      continue;
    }

    await db
      .update(albums)
      .set({ coverUrl })
      .where(eq(albums.id, album.id));

    console.log('✅ ' + album.title + ' → ' + coverFile);
    updated++;
  }

  console.log('\n🎉 Concluído!');
  console.log('   Atualizados: ' + updated);
  console.log('   Pulados: ' + skipped);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
