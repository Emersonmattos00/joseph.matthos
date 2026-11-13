const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento dos ISRCs (extraídos dos prints)
const dados = {
  "Dilemas": [
    { title: "Amor Importante", isrc: "QRAUM2600129" },
    { title: "Se Estou Com Você", isrc: "QRAUM2600130" },
    { title: "Será", isrc: "QRAUM2600131" },
    { title: "Dilemas", isrc: "QRAUM2600132" },
    { title: "O Ofício", isrc: "QRAUM2600133" },
    { title: "Prisioneiro em Liberdade", isrc: "QRAUM2600134" },
    { title: "Quiçá", isrc: "QRAUM2600135" },
    { title: "De Súbito", isrc: "QRAUM2600136" },
    { title: "Assim", isrc: "QRAUM2600137" },
    { title: "Dilema do Ser", isrc: "QRAUM2600138" },
    { title: "O Amanhã", isrc: "QRAUM2600139" },
    { title: "Verdadeiro Amor", isrc: "QRAUM2600140" }
  ],
  "Espelho da Alma": [
    { title: "Amor Revolto", isrc: "QRAUM2600073" },
    { title: "Tudo Muda", isrc: "QRAUM2600064" },
    { title: "Auto-Afirmar", isrc: "QRAUM2600066" },
    { title: "Falar ou Não", isrc: "QRAUM2600067" },
    { title: "Acredite", isrc: "QRAUM2600075" },
    { title: "Espelho da Alma", isrc: "QRAUM2600065" },
    { title: "Muito Prazer", isrc: "QRAUM2600076" },
    { title: "Onde", isrc: "QRAUM2600068" },
    { title: "Chave", isrc: "QRAUM2600077" },
    { title: "Aventurar", isrc: "QRAUM2600070" },
    { title: "Afeição", isrc: "QRAUM2600071" },
    { title: "Viva", isrc: "QRAUM2600069" },
    { title: "Olhos de Prazer", isrc: "QRAUM2600074" },
    { title: "Só o Amor", isrc: "QRAUM2600072" }
  ],
  "História Infinita": [
    { title: "O Universo", isrc: "QRAUM2600094" },
    { title: "Será!", isrc: "QRAUM2600095" },
    { title: "Planto e Colho", isrc: "QRAUM2600096" },
    { title: "Arquitetura do Ser", isrc: "QRAUM2600097" },
    { title: "Existência Coesa", isrc: "QRAUM2600098" },
    { title: "Paradoxo da Consciência", isrc: "QRAUM2600099" },
    { title: "Vegetar", isrc: "QRAUM2600090" },
    { title: "Debate do Ser", isrc: "QRAUM2600091" },
    { title: "Em Três Atos", isrc: "QRAUM2600092" },
    { title: "História Infinita", isrc: "QRAUM2600093" },
    { title: "Fortaleza", isrc: "QRAUM2600100" }
  ],
  "Nada Acabou": [
    { title: "Meu Lugar no Mundo", isrc: "QRAUM2600162" },
    { title: "Ânsia do Prazer", isrc: "QRAUM2600109" },
    { title: "Isolado", isrc: "QRAUM2600110" },
    { title: "Não à Ilusão", isrc: "QRAUM2600111" },
    { title: "Coeso", isrc: "QRAUM2600112" },
    { title: "Subjetivo", isrc: "QRAUM2600101" },
    { title: "Memorial", isrc: "QRAUM2600102" },
    { title: "Pena Capital", isrc: "QRAUM2600104" },
    { title: "Movimentos", isrc: "QRAUM2600105" },
    { title: "Nada Acabou", isrc: "QRAUM2600106" },
    { title: "Jardim Paraíso", isrc: "QRAUM2600107" },
    { title: "Queria Voar", isrc: "QRAUM2600103" }
  ],
  "O Instante": [
    { title: "Ânimo", isrc: "QRAUM2600037" },
    { title: "Ser ou Não", isrc: "QRAUM2600038" },
    { title: "Cotejo da Vida", isrc: "QRAUM2600039" },
    { title: "Vento", isrc: "QRAUM2600040" },
    { title: "Palmeirar Sabiá", isrc: "QRAUM2600041" },
    { title: "O Sentido", isrc: "QRAUM2600043" },
    { title: "Sonhar", isrc: "QRAUM2600044" },
    { title: "Maior", isrc: "QRAUM2600045" },
    { title: "A Lua Me Disse", isrc: "QRAUM2600046" },
    { title: "O Exórdio", isrc: "QRAUM2600032" },
    { title: "Queria Sonhar", isrc: "QRAUM2600033" },
    { title: "Brunas Vozes", isrc: "QRAUM2600034" },
    { title: "Vou Amar", isrc: "QRAUM2600035" },
    { title: "O Instante", isrc: "QRAUM2600036" },
    { title: "O Momento", isrc: "QRAUM2600042" }
  ],
  "Prisões Invisíveis": [
    { title: "Ainda há Sonhos", isrc: "QRAUM2600078" },
    { title: "É Difícil Voar", isrc: "QRAUM2600079" },
    { title: "Ser Consciente", isrc: "QRAUM2600080" },
    { title: "Prisões Invisíveis", isrc: "QRAUM2600081" },
    { title: "Gritos do Silêncio", isrc: "QRAUM2600082" },
    { title: "Morrer Pra Viver", isrc: "QRAUM2600083" },
    { title: "Tomada de Decisão", isrc: "QRAUM2600084" },
    { title: "Consciência Refletida", isrc: "QRAUM2600085" },
    { title: "Celebrar a Inconsciência", isrc: "QRAUM2600086" },
    { title: "Branca Escuridão", isrc: "QRAUM2600087" },
    { title: "Introspecção", isrc: "QRAUM2600088" },
    { title: "O Porão da Alma", isrc: "QRAUM2600089" }
  ],
  "Razão do Coração": [
    { title: "Benefício do Amor", isrc: "QRAUM2600141" },
    { title: "Apressado", isrc: "QRAUM2600142" },
    { title: "O Mundo Virou", isrc: "QRAUM2600143" },
    { title: "Labirinto do Meu Ser", isrc: "QRAUM2600144" },
    { title: "Interrogações", isrc: "QRAUM2600145" },
    { title: "A Fatura Chegou", isrc: "QRAUM2600146" },
    { title: "Razão do Coração", isrc: "QRAUM2600147" },
    { title: "O Encontro", isrc: "QRAUM2600148" },
    { title: "Pareço o Mesmo", isrc: "QRAUM2600149" },
    { title: "Ilógico", isrc: "QRAUM2600150" },
    { title: "Queria Sossego", isrc: "QRAUM2600151" },
    { title: "Tac, Clique", isrc: "QRAUM2600152" }
  ],
  "Íntima Relação": [
    { title: "Viver", isrc: "QRAUM2600115" },
    { title: "Sentinela", isrc: "QRAUM2600116" },
    { title: "Imaginação", isrc: "QRAUM2600117" },
    { title: "Crepúsculo", isrc: "QRAUM2600118" },
    { title: "Parcial", isrc: "QRAUM2600119" },
    { title: "Ser ou Não Ser", isrc: "QRAUM2600120" },
    { title: "Desprezar a Sabedoria", isrc: "QRAUM2600121" },
    { title: "Paronímia", isrc: "QRAUM2600122" },
    { title: "Até Quando", isrc: "QRAUM2600125" },
    { title: "Íntima Relação", isrc: "QRAUM2600123" },
    { title: "O Olhar", isrc: "QRAUM2600124" }
  ]
};

async function preencher() {
  console.log("🔍 Preenchendo ISRCs restantes...\n");

  let atualizados = 0;
  let naoEncontrados = 0;

  for (const [albumTitle, tracks] of Object.entries(dados)) {
    console.log(`\n🎵 Álbum: ${albumTitle}`);

    const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;
    if (!album) {
      console.log(`   ❌ Álbum não encontrado. Pulando.`);
      continue;
    }

    for (const { title, isrc } of tracks) {
      try {
        const res = await sql`
          UPDATE tracks 
          SET isrc = ${isrc}
          WHERE album_id = ${album.id} 
          AND title ILIKE ${`%${title}%`}
          RETURNING id, title
        `;

        if (res.length > 0) {
          console.log(`   ✅ "${res[0].title}" -> ISRC: ${isrc}`);
          atualizados++;
        } else {
          console.log(`   ⚠️ Não encontrada: "${title}"`);
          naoEncontrados++;
        }
      } catch (err) {
        console.log(`   ❌ Erro em "${title}": ${err.message}`);
        naoEncontrados++;
      }
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Músicas atualizadas: ${atualizados}`);
  console.log(`⚠️ Não encontradas: ${naoEncontrados}`);
}

preencher().catch(console.error);