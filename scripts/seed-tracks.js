/**
 * Script para popular a tabela `tracks` com os dados do B2
 * 
 * Pré-requisitos:
 * 1. Artista e álbuns já cadastrados na tabela `artists` e `albums`
 * 2. Arquivos no B2 com o padrão:
 *    - full/{slug}.mp3
 *    - previews/{slug}-preview.mp3
 * 
 * Uso: node script/seed-tracks.js
 */

require('dotenv').config();
const { randomUUID } = require('crypto');
const { eq } = require('drizzle-orm');
const { db } = require('../api/_db.js');
const { artists, albums, tracks } = require('../src/schema.js');

// ============================================
// CONFIGURAÇÃO — AJUSTE AQUI
// ============================================

const ARTIST_SLUG = 'joseph-matthos'; // slug do artista no banco

// Lista de álbuns com suas faixas
const ALBUMS_DATA = [
  {
    slug: 'tornado-da-arte',
    title: 'Tornado da Arte',
    coverKey: 'images/tornadodaarte.webp',
    releaseDate: '2025-09-10',
    tracks: [
      { title: 'Tornado da Arte', slug: 'tornado-da-arte', durationSeconds: 240, trackNumber: 1 },
      // Adicione mais faixas deste álbum aqui
    ],
  },
  {
    slug: 'mundo-atual',
    title: 'Mundo Atual',
    coverKey: 'images/mundoatual.webp',
    releaseDate: '2026-01-15',
    tracks: [
      { title: 'Mundo Atual', slug: 'mundo-atual', durationSeconds: 220, trackNumber: 1 },
    ],
  },
  {
    slug: 'contraditorio',
    title: 'Contraditório',
    coverKey: 'images/contraditorio.webp',
    releaseDate: '2026-02-20',
    tracks: [
      { title: 'Contraditório', slug: 'contraditorio', durationSeconds: 200, trackNumber: 1 },
    ],
  },
  // ... adicione os demais álbuns
];

// ============================================
// LÓGICA
// ============================================

async function main() {
  console.log('🚀 Iniciando seed de tracks...\n');

  // 1. Buscar o artista
  const [artist] = await db
    .select()
    .from(artists)
    .where(eq(artists.slug, ARTIST_SLUG))
    .limit(1);

  if (!artist) {
    console.error(`❌ Artista com slug "${ARTIST_SLUG}" não encontrado.`);
    console.error('   Crie primeiro o artista na tabela `artists`.');
    process.exit(1);
  }

  console.log(`✅ Artista encontrado: ${artist.name} (${artist.id})\n`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const albumData of ALBUMS_DATA) {
    console.log(`📀 Processando álbum: ${albumData.title}`);

    // 2. Verificar se o álbum já existe
    let [album] = await db
      .select()
      .from(albums)
      .where(eq(albums.slug, albumData.slug))
      .limit(1);

    if (!album) {
      console.log(`   ➕ Criando álbum...`);
      [album] = await db.insert(albums).values({
        id: randomUUID(),
        title: albumData.title,
        slug: albumData.slug,
        artistId: artist.id,
        releaseDate: albumData.releaseDate,
        coverUrl: `https://${process.env.B2_BUCKET_NAME}.${process.env.B2_REGION}.backblazeb2.com/${albumData.coverKey}`,
      }).returning();
      console.log(`   ✅ Álbum criado: ${album.id}`);
    } else {
      console.log(`   ⏭️  Álbum já existe: ${album.id}`);
    }

    // 3. Criar as faixas
    for (const trackData of albumData.tracks) {
      // Verificar se já existe
      const [existing] = await db
        .select()
        .from(tracks)
        .where(eq(tracks.slug, trackData.slug))
        .limit(1);

      if (existing) {
        console.log(`   ⏭️  Faixa já existe: ${trackData.title}`);
        totalSkipped++;
        continue;
      }

      // Chaves do B2
      const streamKey = `full/${trackData.slug}.mp3`;
      const previewKey = `previews/${trackData.slug}-preview.mp3`;

      await db.insert(tracks).values({
        id: randomUUID(),
        albumId: album.id,
        artistId: artist.id,
        title: trackData.title,
        slug: trackData.slug,
        durationSeconds: trackData.durationSeconds,
        trackNumber: trackData.trackNumber,
        status: 'PUBLISHED',
        streamKey,
        previewKey,
        masterKey: streamKey,
        updatedAt: new Date().toISOString(),
      });

      console.log(`   ✅ Faixa criada: ${trackData.title}`);
      totalCreated++;
    }
    console.log('');
  }

  console.log('🎉 Seed concluído!');
  console.log(`   Faixas criadas: ${totalCreated}`);
  console.log(`   Faixas puladas: ${totalSkipped}`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro no seed:', err);
  process.exit(1);
});
