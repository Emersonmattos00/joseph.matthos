const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Lista de correções: título + álbum + número da faixa + ISRC
const correcoes = [
  { title: "Pedra, Meio, Caminho", album: "Poesia Viva", trackNumber: 5, isrc: "QTE6F32648792" },
  { title: "Pedra, Meio, Caminho", album: "Jardim do Coração", trackNumber: 4, isrc: "QTE6F32648792" },
  { title: "Limites da Imaginação", album: "Caminho, Direção", trackNumber: 2, isrc: "QTE6G92655207" },
  { title: "Porquê?", album: "Ressignifique!", trackNumber: 7, isrc: "QTE6HJ2653255" },
  { title: "Qual o Propósito?", album: "Ressignifique!", trackNumber: 10, isrc: "QTE6HJ2653258" },
  { title: "Peleja", album: "Abismo do Coração", trackNumber: 3, isrc: "QTE6HK2678229" },
  { title: "Cárcere", album: "Abismo do Coração", trackNumber: 4, isrc: "QTE6HK2678230" },
  { title: "Desperto no Escuro", album: "Abismo do Coração", trackNumber: 8, isrc: "QTE6HK2678234" },
  { title: "Cortejo", album: "Abismo do Coração", trackNumber: 10, isrc: "QTE6HK2678236" },
  { title: "A Ética do Silêncio", album: "Ocultos da Alma", trackNumber: 6, isrc: "QTE6HM2649609" },
  { title: "Circo do Terror", album: "Ocultos da Alma", trackNumber: 7, isrc: "QTE6HM2649610" },
  { title: "O Poder da Palavra", album: "Ocultos da Alma", trackNumber: 8, isrc: "QTE6HM2649611" },
  { title: "O Tempo Não Pára", album: "Peso da Caneta", trackNumber: 4, isrc: "QTE6HP2607393" },
  { title: "Em Que Curva?", album: "Máquina do Tempo", trackNumber: 7, isrc: "QTE6HQ2607173" },
  { title: "O Barulho do Silêncio", album: "Boom, Boom, Bap", trackNumber: 5, isrc: "QTE6HS2616991" },
  { title: "Reflexão", album: "O Despertar", trackNumber: 11, isrc: "QTE6HT2667684" },
  { title: "Gritos Gritados", album: "Mar de Inquirições", trackNumber: 5, isrc: "QTE6HV2660596" },
  { title: "Ser Criança", album: "Mar de Inquirições", trackNumber: 9, isrc: "QTE6HV2660601" },
  { title: "Anonimato e Fama", album: "Contraditório", trackNumber: 1, isrc: "QTE6J32630677" },
  { title: "A Natureza", album: "Mundo Atual", trackNumber: 4, isrc: "QTE6J42637732" },
  { title: "Fé Indescritível", album: "A Lógica da Consciência", trackNumber: 6, isrc: "QTA89Z600978" }
];

async function corrigir() {
  console.log("🔍 Corrigindo músicas por título + álbum...\n");

  let atualizados = 0;
  let naoEncontrados = 0;

  for (const { title, album, trackNumber, isrc } of correcoes) {
    try {
      // Busca o ID do álbum
      const [albumRow] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${album}%`} LIMIT 1`;
      if (!albumRow) {
        console.log(`⚠️ Álbum não encontrado: "${album}"`);
        naoEncontrados++;
        continue;
      }

      // Atualiza a música
      const res = await sql`
        UPDATE tracks 
        SET track_number = ${trackNumber}, 
            isrc = ${isrc}
        WHERE album_id = ${albumRow.id} 
        AND title ILIKE ${`%${title}%`}
        RETURNING id, title
      `;

      if (res.length > 0) {
        console.log(`✅ "${res[0].title}" (${album}) -> Faixa ${trackNumber}, ISRC: ${isrc}`);
        atualizados++;
      } else {
        console.log(`⚠️ Não encontrada: "${title}" (${album})`);
        naoEncontrados++;
      }
    } catch (err) {
      console.log(`❌ Erro em "${title}": ${err.message}`);
      naoEncontrados++;
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Músicas atualizadas: ${atualizados}`);
  console.log(`⚠️ Não encontradas: ${naoEncontrados}`);
}

corrigir().catch(console.error);