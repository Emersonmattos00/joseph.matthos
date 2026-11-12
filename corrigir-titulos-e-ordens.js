const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento com os títulos EXATOS do banco de dados
const correcoes = [
  // Poesia Viva
  { album: "Poesia Viva", title: "Pedra Meio Caminho", trackNumber: 5, isrc: "QTE6F32648792" },
  
  // Jardim do Coração
  { album: "Jardim do Coração", title: "Pedra Meio Caminho", trackNumber: 4, isrc: "QTE6F32648792" },
  
  // Caminho, Direção
  { album: "Caminho, Direção", title: "Limite da Imaginação", trackNumber: 2, isrc: "QTE6G92655207" },
  
  // Ressignifique!
  { album: "Ressignifique!", title: "Porque?", trackNumber: 7, isrc: "QTE6HJ2653255" },
  { album: "Ressignifique!", title: "Qual o Propósito", trackNumber: 10, isrc: "QTE6HJ2653258" },
  
  // Abismo do Coração
  { album: "Abismo do Coração", title: "Encarcerado", trackNumber: 4, isrc: "QTE6HK2678230" }, // Cárcere
  { album: "Abismo do Coração", title: "Cotejo", trackNumber: 10, isrc: "QTE6HK2678236" }, // Cortejo
  { album: "Abismo do Coração", title: "Acordado No Escuro", trackNumber: 8, isrc: "QTE6HK2678234" }, // Desperto no Escuro
  { album: "Abismo do Coração", title: "Sentimento Sepultado", trackNumber: 3, isrc: "QTE6HK2678229" }, // Peleja
  
  // Ocultos da Alma
  { album: "Ocultos da Alma", title: "Ética do Silêncio", trackNumber: 6, isrc: "QTE6HM2649609" },
  { album: "Ocultos da Alma", title: "Circo de Terror", trackNumber: 7, isrc: "QTE6HM2649610" },
  { album: "Ocultos da Alma", title: "Poder da Palavra", trackNumber: 8, isrc: "QTE6HM2649611" },
  
  // Peso da Caneta
  { album: "Peso da Caneta", title: "O Tempo Não Para", trackNumber: 4, isrc: "QTE6HP2607393" },
  
  // Máquina do Tempo
  { album: "Máquina do Tempo", title: "Em Que Curva", trackNumber: 7, isrc: "QTE6HQ2607173" },
  
  // Boom, Boom, Bap
  { album: "Boom, Boom, Bap", title: "Barulho do Silêncio", trackNumber: 5, isrc: "QTE6HS2616991" },
  
  // O Despertar
  { album: "O Despertar", title: "Reflexão", trackNumber: 11, isrc: "QTE6HT2667684" },
  
  // Mar de Inquirições
  { album: "Mar de Inquirições", title: "Gritos Silenciosos", trackNumber: 5, isrc: "QTE6HV2660596" }, // Gritos Gritados
  { album: "Mar de Inquirições", title: "Ser Inocência", trackNumber: 9, isrc: "QTE6HV2660601" }, // Ser Criança
  
  // Contraditório
  { album: "Contraditório", title: "Anonimato Fama", trackNumber: 1, isrc: "QTE6J32630677" },
  
  // Mundo Atual
  { album: "Mundo Atual", title: "Natureza", trackNumber: 4, isrc: "QTE6J42637732" },
  
  // A Lógica da Consciência
  { album: "A Lógica da Consciência", title: "Fé Indestrutível", trackNumber: 6, isrc: "QTA89Z600978" }
];

async function corrigir() {
  console.log("🔍 Corrigindo músicas com títulos exatos do banco...\n");

  let atualizados = 0;
  let naoEncontrados = 0;

  for (const { album, title, trackNumber, isrc } of correcoes) {
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