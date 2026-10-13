/**
 * Cria o artista Joseph Matthos e todos os álbuns
 * Execute UMA VEZ antes do seed-tracks.js
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');
const { db } = require('../api/_db');
const { artists, albums } = require('../src/schema.js');

const ARTIST = {
  name: 'Joseph Matthos',
  slug: 'joseph-matthos',
  bio: 'HIP HOP POÉTICO • REAL • INSPIRADOR',
  imageUrl: 'https://joseph-matthos-audio.us-west-004.backblazeb2.com/images/josephmatthos.webp',
};

const ALBUMS_DATA = [
  { slug: 'tornado-da-arte', title: 'Tornado da Arte', cover: 'tornadodaarte.webp', releaseDate: '2025-09-10' },
  { slug: 'mundo-atual', title: 'Mundo Atual', cover: 'mundoatual.webp', releaseDate: '2026-01-15' },
  { slug: 'contraditorio', title: 'Contraditório', cover: 'contraditorio.webp', releaseDate: '2026-02-20' },
  { slug: 'mar-de-inquiricoes', title: 'Mar de Inquirições', cover: 'mardeinquiricoes.webp', releaseDate: '2026-03-01' },
  { slug: 'eu-comigo', title: 'Eu Comigo', cover: 'eucomigo.webp', releaseDate: '2026-03-15' },
  { slug: 'o-despertar', title: 'O Despertar', cover: 'odespertar.webp', releaseDate: '2026-04-01' },
  { slug: 'boom-boom-bap', title: 'Boom, Boom, Bap', cover: 'boomboombap.webp', releaseDate: '2026-04-15' },
  { slug: 'maquina-do-tempo', title: 'Máquina do Tempo', cover: 'maquinadotempo.webp', releaseDate: '2026-05-01' },
  { slug: 'peso-da-caneta', title: 'Peso da Caneta', cover: 'pesodacaneta.webp', releaseDate: '2026-05-15' },
  { slug: 'nada-acabou', title: 'Nada Acabou (Vol. 1)', cover: 'nadaacabou.webp', releaseDate: '2026-06-01' },
  { slug: 'ocultos-da-alma', title: 'Ocultos da Alma', cover: 'ocultosdaalma.webp', releaseDate: '2026-06-15' },
  { slug: 'razao-do-coracao', title: 'Razão do Coração (Vol. 1)', cover: 'razaodocoracao.webp', releaseDate: '2026-07-01' },
  { slug: 'dilemas', title: 'Dilemas (Vol. 1)', cover: 'dilemas.webp', releaseDate: '2026-07-15' },
  { slug: 'abismo-do-coracao', title: 'Abismo do Coração', cover: 'abismodocoracao.webp', releaseDate: '2026-08-01' },
  { slug: 'ressignifique', title: 'Ressignifique!', cover: 'ressignifique.webp', releaseDate: '2026-08-15' },
  { slug: 'intima-relacao', title: 'Íntima Relação (Vol. 1)', cover: 'intimarelacao.webp', releaseDate: '2026-09-01' },
  { slug: 'caminho-direcao', title: 'Caminho, Direção', cover: 'caminhodirecao.webp', releaseDate: '2026-09-15' },
  { slug: 'historia-infinita', title: 'História Infinita (Vol. ...)', cover: 'historiainfinita.webp', releaseDate: '2026-10-01' },
  { slug: 'prisoes-invisiveis', title: 'Prisões Invisíveis (Vol. ...)', cover: 'prisoesinvisiveis.webp', releaseDate: '2026-10-10' },
  { slug: 'apocalipse-da-emocao', title: 'Apocalipse da Emoção...', cover: 'apocalisedaemocao.webp', releaseDate: '2026-10-15' },
  { slug: 'espelho-da-alma', title: 'Espelho da Alma (Vol. ...)', cover: 'espelhodaalma.webp', releaseDate: '2026-10-20' },
  { slug: 'o-instante', title: 'O Instante', cover: 'oinstante.webp', releaseDate: '2026-10-25' },
  { slug: 'ainda-da-tempo', title: 'Ainda dá Tempo', cover: 'aindadatempo.webp', releaseDate: '2026-10-28' },
  { slug: 'jardim-do-coracao', title: 'Jardim do Coração', cover: 'jardimdocoracao.webp', releaseDate: '2026-11-01' },
  { slug: 'mentalidade-de-ouro-v1', title: 'Mentalidade de Ouro (Vol. 1)', cover: 'menatlidadedeourov1.webp', releaseDate: '2026-11-05' },
  { slug: 'mentalidade-de-ouro-v2', title: 'Mentalidade de Ouro (Vol. 2)', cover: 'menatlidadedeourov2.webp', releaseDate: '2026-11-10' },
  { slug: 'mentalidade-de-ouro-v3', title: 'Mentalidade de Ouro (Vol. 3)', cover: 'menatlidadedeourov3.webp', releaseDate: '2026-11-15' },
  { slug: 'mentalidade-de-ouro-v4', title: 'Mentalidade de Ouro (Vol. 4)', cover: 'menatlidadedeourov4.webp', releaseDate: '2026-11-20' },
  { slug: 'mentalidade-de-ouro-v5', title: 'Mentalidade de Ouro (Vol. 5)', cover: 'menatlidadedeourov5.webp', releaseDate: '2026-11-25' },
  { slug: 'poesia-viva', title: 'Poesia Viva', cover: 'poesiaviva.webp', releaseDate: '2026-12-01' },
];

async function main() {
  console.log('🚀 Criando artista e álbuns...\n');

  // 1. Criar/buscar artista
  let [artist] = await db.select().from(artists).where(eq(artists.slug, ARTIST.slug)).limit(1);

  if (!artist) {
    [artist] = await db.insert(artists).values({
      id: randomUUID(),
      name: ARTIST.name,
      slug: ARTIST.slug,
      bio: ARTIST.bio,
      imageUrl: ARTIST.imageUrl,
    }).returning();
    console.log(`✅ Artista criado: ${artist.name} (${artist.id})\n`);
  } else {
    console.log(`⏭️  Artista já existe: ${artist.name} (${artist.id})\n`);
  }

  // 2. Criar álbuns
  let created = 0;
  let skipped = 0;

  for (const a of ALBUMS_DATA) {
    const [existing] = await db.select().from(albums).where(eq(albums.slug, a.slug)).limit(1);

    if (existing) {
      skipped++;
      continue;
    }

    await db.insert(albums).values({
      id: randomUUID(),
      title: a.title,
      slug: a.slug,
      artistId: artist.id,
      releaseDate: a.releaseDate,
      coverUrl: `https://joseph-matthos-audio.us-west-004.backblazeb2.com/images/${a.cover}`,
      sortOrder: created,
    });

    console.log(`   ✅ ${a.title}`);
    created++;
  }

  console.log(`\n🎉 Concluído!`);
  console.log(`   Álbuns criados: ${created}`);
  console.log(`   Álbuns existentes: ${skipped}`);
  process.exit(0);
}

main().catch(err => { console.error('❌', err); process.exit(1); });
