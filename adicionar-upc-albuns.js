const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento: Nome do Álbum -> UPC (extraído dos seus prints)
const upcs = {
  "Mentalidade de Ouro Vol. 1": "882988848801",
  "Mentalidade de Ouro Vol. 2": "882988742055",
  "Mentalidade de Ouro Vol. 3": "882988578005",
  "Mentalidade de Ouro Vol. 4": "882988533219",
  "Mentalidade de Ouro Vol. 5": "883005681272",
  "Poesia Viva": "883005424664",
  "Jardim do Coração": "882093306074",
  "Caminho, Direção": "881999300285",
  "Ressignifique!": "882011686851",
  "Abismo do Coração": "882061959516",
  "Ocultos da Alma": "882061053153",
  "Peso da Caneta": "700085971157",
  "Máquina do Tempo": "701546861703",
  "Boom, Boom, Bap": "701518650458",
  "O Despertar": "701508900693",
  "Eu Comigo": "701508583612",
  "Mar de Inquirições": "701496813241",
  "Contraditório": "700989567388",
  "Mundo Atual": "700978905078",
  "Tornado da Arte": "700971352305",
  "Tempo Indomável": "700235211256",
  "A Lógica da Consciência": "700173510558",
  "Ainda Dá Tempo": "8721466629476",
  "O Instante": "8721466629520",
  "Espelho da Alma": "8721466629810",
  "Apocalipse da Emoção": "8721466629490",
  "História Infinita": "8721466629865",
  "Íntima Relação": "8721466629889",
  "Dilemas": "8721466629896",
  "Razão do Coração": "8721466629902",
  "Nada Acabou": "8721466629858"
};

async function adicionarUPC() {
  console.log("🔍 Adicionando UPC aos álbuns...\n");

  let atualizados = 0;
  let naoEncontrados = 0;

  for (const [titulo, upc] of Object.entries(upcs)) {
    try {
      const res = await sql`
        UPDATE albums 
        SET upc = ${upc} 
        WHERE title ILIKE ${`%${titulo}%`}
        RETURNING id, title, upc
      `;

      if (res.length > 0) {
        console.log(`✅ "${res[0].title}" -> UPC: ${upc}`);
        atualizados++;
      } else {
        console.log(`⚠️ Álbum não encontrado: "${titulo}"`);
        naoEncontrados++;
      }
    } catch (err) {
      console.log(`❌ Erro em "${titulo}": ${err.message}`);
      naoEncontrados++;
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Álbuns atualizados: ${atualizados}`);
  console.log(`⚠️ Não encontrados: ${naoEncontrados}`);
}

adicionarUPC().catch(console.error);