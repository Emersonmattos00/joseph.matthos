require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Mapeamento EXATO baseado na lista que você confirmou como correta
const albunsCorretos = {
  "A Lógica da Consciência": [
    { n: 1, titulo: "Eu Posso?" }, { n: 2, titulo: "Cadê a Razão?" }, { n: 3, titulo: "Saber Dosar" },
    { n: 4, titulo: "Tempestade Humana" }, { n: 5, titulo: "Tudo Suporta" }, { n: 6, titulo: "Fé Indestrutível" },
    { n: 7, titulo: "A Lógica da Consciência" }, { n: 8, titulo: "Viver na Verdade" }, { n: 9, titulo: "Favela Viva" },
    { n: 10, titulo: "Sociedade Vazia" }
  ],
  "Abismo do Coração": [
    { n: 1, titulo: "Prisão da Razão" }, { n: 2, titulo: "Abismo do Coração" }, { n: 3, titulo: "Peleja" },
    { n: 4, titulo: "Cárcere" }, { n: 5, titulo: "Circunstanciado" }, { n: 6, titulo: "Modo de Viver" },
    { n: 7, titulo: "Onde Estou?" }, { n: 8, titulo: "Desperto no Escuro" }, { n: 9, titulo: "Saber Viver" },
    { n: 10, titulo: "Cortejo" }
  ],
  "Ainda Dá Tempo": [
    { n: 1, titulo: "Servo" }, { n: 2, titulo: "Apreensivo" }, { n: 3, titulo: "Ainda Dá Tempo" },
    { n: 4, titulo: "Aqui Jaz um Sentimento" }, { n: 5, titulo: "Ciclo" }, { n: 6, titulo: "Psiquê Insana" },
    { n: 7, titulo: "Pra Amar" }, { n: 8, titulo: "O Fechar das Cortinas" }, { n: 9, titulo: "Loucura Sana" },
    { n: 10, titulo: "Eu Lamento" }, { n: 11, titulo: "Saudade de Você" }
  ],
  "Apocalipse da Emoção": [
    { n: 1, titulo: "A Velha" }, { n: 2, titulo: "Apocalipse da Emoção" }, { n: 3, titulo: "Começo, Meio e Fim" },
    { n: 4, titulo: "Comigo Mesmo" }, { n: 5, titulo: "Final" }, { n: 6, titulo: "Idílio" },
    { n: 7, titulo: "Mar" }, { n: 8, titulo: "Morrer Vivendo" }, { n: 9, titulo: "Quem Ama Vive" },
    { n: 10, titulo: "Quem Vai Responder" }, { n: 11, titulo: "Tormenta" }, { n: 12, titulo: "Viver Morrendo" }
  ],
  "Boom, Boom, Bap": [
    { n: 1, titulo: "Barulho do Silêncio" }, { n: 2, titulo: "Ego" }, { n: 3, titulo: "Manual de Sobrevivência" },
    { n: 4, titulo: "Mesma Matéria" }, { n: 5, titulo: "Outro Nível" }, { n: 6, titulo: "Paradoxo" },
    { n: 7, titulo: "Predestinado" }, { n: 8, titulo: "Trono da Vontade" }, { n: 9, titulo: "Vaidade da Vaidade" },
    { n: 10, titulo: "Velho Homem" }
  ],
  "Caminho, Direção": [
    { n: 1, titulo: "A Vida Me Ensina" }, { n: 2, titulo: "Caminho, Direção" }, { n: 3, titulo: "Encontrei a Luz" },
    { n: 4, titulo: "Entre Luz e Sombra" }, { n: 5, titulo: "Eu Tenho Solução" }, { n: 6, titulo: "Limite da Imaginação" },
    { n: 7, titulo: "Quem Esclarece?" }, { n: 8, titulo: "Sou Superestimado" }, { n: 9, titulo: "Só Ame" },
    { n: 10, titulo: "Tempos Antigos" }
  ],
  "Contraditório": [
    { n: 1, titulo: "Anonimato Fama" }, { n: 2, titulo: "Carpindo" }, { n: 3, titulo: "Confuso" },
    { n: 4, titulo: "Contraditório" }, { n: 5, titulo: "Família Ingrata" }, { n: 6, titulo: "Gírias" },
    { n: 7, titulo: "Indefinível" }, { n: 8, titulo: "Ironia" }, { n: 9, titulo: "Liberdade Presa" },
    { n: 10, titulo: "Luxo, Lixo" }, { n: 11, titulo: "Não Me Importo" }, { n: 12, titulo: "Policiar" },
    { n: 13, titulo: "Reflexo da Alma" }, { n: 14, titulo: "Saudoso" }, { n: 15, titulo: "Só Observo" }
  ],
  "Dilemas": [
    { n: 1, titulo: "Amor Importante" }, { n: 2, titulo: "Assim" }, { n: 3, titulo: "De Súbito" },
    { n: 4, titulo: "Dilema do Ser" }, { n: 5, titulo: "Dilemas" }, { n: 6, titulo: "O Amanhã" },
    { n: 7, titulo: "O Ofício" }, { n: 8, titulo: "Prisioneiro em Liberdade" }, { n: 9, titulo: "Quiçá" },
    { n: 10, titulo: "Se Estou com Você" }, { n: 11, titulo: "Será" }, { n: 12, titulo: "Verdadeiro Amor" }
  ],
  "Espelho da Alma": [
    { n: 1, titulo: "Acredite" }, { n: 2, titulo: "Afeição" }, { n: 3, titulo: "Amor Revolto" },
    { n: 4, titulo: "Auto-Afirmar" }, { n: 5, titulo: "Aventurar" }, { n: 6, titulo: "Chave" },
    { n: 7, titulo: "Espelho da Alma" }, { n: 8, titulo: "Falar ou Não" }, { n: 9, titulo: "Muito Prazer" },
    { n: 10, titulo: "Olhos de Prazer" }, { n: 11, titulo: "Onde" }, { n: 12, titulo: "Só o Amor" },
    { n: 13, titulo: "Tudo Muda" }, { n: 14, titulo: "Viva" }
  ],
  "Eu Comigo": [
    { n: 1, titulo: "Conclusão" }, { n: 2, titulo: "Crack! Shhh!" }, { n: 3, titulo: "Eu Comigo" },
    { n: 4, titulo: "Instante do Momento" }, { n: 5, titulo: "Molhada de Céu" }, { n: 6, titulo: "O Ciclo" },
    { n: 7, titulo: "O Despertar da Consciência" }, { n: 8, titulo: "O Que Sou?" }, { n: 9, titulo: "Trovador" },
    { n: 10, titulo: "Ímpar" }
  ],
  "História Infinita": [
    { n: 1, titulo: "Arquitetura do Ser" }, { n: 2, titulo: "Debate do Ser" }, { n: 3, titulo: "Em Três Atos" },
    { n: 4, titulo: "Existência Coesa" }, { n: 5, titulo: "Fortaleza" }, { n: 6, titulo: "História Infinita" },
    { n: 7, titulo: "O Universo" }, { n: 8, titulo: "Paradoxo da Consciência" }, { n: 9, titulo: "Planto e Colho" },
    { n: 10, titulo: "Será!" }, { n: 11, titulo: "Vegetar" }
  ],
  "Jardim do Coração": [
    { n: 1, titulo: "Apenas" }, { n: 2, titulo: "Ilação" }, { n: 3, titulo: "Imagine" },
    { n: 4, titulo: "Intervalo" }, { n: 5, titulo: "Início" }, { n: 6, titulo: "Jardim do Coração" },
    { n: 7, titulo: "Jornada Sem Objetivo" }, { n: 8, titulo: "Pedra Meio Caminho" }, { n: 9, titulo: "Pá Lavra" },
    { n: 10, titulo: "Rainha da Noite" }, { n: 11, titulo: "Suplício Aflito" }
  ],
  "Mar de Inquirições": [
    { n: 1, titulo: "Arquitetura da Ausência" }, { n: 2, titulo: "Cadê Você?" }, { n: 3, titulo: "Dimensão da Psiquê" },
    { n: 4, titulo: "Fenômenos da Mente" }, { n: 5, titulo: "Gritos Gritados" }, { n: 6, titulo: "Mar de Inquirições" },
    { n: 7, titulo: "Onde Está o Brilho?" }, { n: 8, titulo: "Preto e Branco" }, { n: 9, titulo: "Ser Inocência" },
    { n: 10, titulo: "Único, Singular" }
  ],
  "Mentalidade de Ouro Vol. 1": [
    { n: 1, titulo: "20 Conquistar" }, { n: 2, titulo: "Jornada" }, { n: 3, titulo: "Minha Preta" },
    { n: 4, titulo: "Ninguém" }, { n: 5, titulo: "Ser Não Ser" }
  ],
  "Mentalidade de Ouro Vol. 2": [
    { n: 1, titulo: "Avance" }, { n: 2, titulo: "Identidade?" }, { n: 3, titulo: "Inversão de Valores" },
    { n: 4, titulo: "Meio do Tempo" }, { n: 5, titulo: "Passo a Passo" }, { n: 6, titulo: "Razão vs Coração" },
    { n: 7, titulo: "Relento" }, { n: 8, titulo: "Eis a Questão" }, { n: 9, titulo: "Toque" },
    { n: 10, titulo: "Uma Canção" }
  ],
  "Mentalidade de Ouro Vol. 3": [
    { n: 1, titulo: "Caos" }, { n: 2, titulo: "Deserto" }, { n: 3, titulo: "Lírico" },
    { n: 4, titulo: "Mentalidade de Ouro" }, { n: 5, titulo: "Ninguém?" }, { n: 6, titulo: "Normal" },
    { n: 7, titulo: "Poeta" }, { n: 8, titulo: "Sei Lá!?" }, { n: 9, titulo: "Traz de Volta" },
    { n: 10, titulo: "Vida do Tempo" }
  ],
  "Mentalidade de Ouro Vol. 4": [
    { n: 1, titulo: "Ah Deus!" }, { n: 2, titulo: "Cordardia" }, { n: 3, titulo: "Hoje; Só Hoje" },
    { n: 4, titulo: "Incessante Inspiração" }, { n: 5, titulo: "Lua Molhada de Céu" }, { n: 6, titulo: "Pele" },
    { n: 7, titulo: "Sabor" }, { n: 8, titulo: "Saudade" }, { n: 9, titulo: "Sumidouro Social" },
    { n: 10, titulo: "Triade" }
  ],
  "Mentalidade de Ouro Vol. 5": [
    { n: 1, titulo: "A Folha" }, { n: 2, titulo: "A Questão É! Full" }, { n: 3, titulo: "Aquela Janela" },
    { n: 4, titulo: "A Vida Bela" }, { n: 5, titulo: "Factual Sonho" }, { n: 6, titulo: "Fique Perto de Mim" },
    { n: 7, titulo: "Lugar" }, { n: 8, titulo: "Mistico" }, { n: 9, titulo: "Momento" },
    { n: 10, titulo: "Olhos" }, { n: 11, titulo: "Palavra" }, { n: 12, titulo: "Pedido" },
    { n: 13, titulo: "Poética" }, { n: 14, titulo: "Pressões da Vida" }, { n: 15, titulo: "Saudosa Lembrança" },
    { n: 16, titulo: "Singular" }, { n: 17, titulo: "Um Lindo Momento" }
  ],
  "Mundo Atual": [
    { n: 1, titulo: "Aprendizado" }, { n: 2, titulo: "Banalizaram" }, { n: 3, titulo: "Mundo Atual" },
    { n: 4, titulo: "Natureza" }, { n: 5, titulo: "Não Sei" }, { n: 6, titulo: "O Que É Normal?" },
    { n: 7, titulo: "Quem Matou?" }, { n: 8, titulo: "Saber Morrer" }, { n: 9, titulo: "Se Perdeu!" },
    { n: 10, titulo: "Sonhar Insano" }
  ],
  "Máquina do Tempo": [
    { n: 1, titulo: "A Natureza Ensina" }, { n: 2, titulo: "Ainda dá Tempo?" }, { n: 3, titulo: "Ciclo da Entrega" },
    { n: 4, titulo: "Em Extinção" }, { n: 5, titulo: "Em Que Curva" }, { n: 6, titulo: "Energia Desnecessária" },
    { n: 7, titulo: "Entregar" }, { n: 8, titulo: "Máquina do Tempo" }, { n: 9, titulo: "Valores Sem Valor" },
    { n: 10, titulo: "Viver Naquele Tempo" }
  ],
  "Nada Acabou": [
    { n: 1, titulo: "Coeso" }, { n: 2, titulo: "Isolado" }, { n: 3, titulo: "Jardim Paraíso" },
    { n: 4, titulo: "Memorial" }, { n: 5, titulo: "Meu Lugar No Mundo" }, { n: 6, titulo: "Movimentos" },
    { n: 7, titulo: "Nada Acabou" }, { n: 8, titulo: "Não à Ilusão" }, { n: 9, titulo: "Pena Capital" },
    { n: 10, titulo: "Queria Voltar" }, { n: 11, titulo: "Subjetivo" }, { n: 12, titulo: "Ânsia do Prazer" }
  ],
  "O Despertar": [
    { n: 1, titulo: "Aparente Normalidade" }, { n: 2, titulo: "Cubículo" }, { n: 3, titulo: "Fique Fora da Vitrine" },
    { n: 4, titulo: "Interação" }, { n: 5, titulo: "O Despertar da Consciência" }, { n: 6, titulo: "Outra Versão" },
    { n: 7, titulo: "Pense" }, { n: 8, titulo: "Presta Atenção" }, { n: 9, titulo: "Quem?" },
    { n: 10, titulo: "Queria Ser Alguém" }, { n: 11, titulo: "Reflexão" }, { n: 12, titulo: "Vivendo a Reflexão" }
  ],
  "O Instante": [
    { n: 1, titulo: "A Lua Me Disse" }, { n: 2, titulo: "Brunas Vozes" }, { n: 3, titulo: "Cotejo da Vida" },
    { n: 4, titulo: "Maior" }, { n: 5, titulo: "O Exórdio" }, { n: 6, titulo: "O Instante" },
    { n: 7, titulo: "O Momento" }, { n: 8, titulo: "O Sentido" }, { n: 9, titulo: "Palmeirar Sabiá" },
    { n: 10, titulo: "Queria Sonhar" }, { n: 11, titulo: "Ser ou Não" }, { n: 12, titulo: "Sonhar" },
    { n: 13, titulo: "Vento" }, { n: 14, titulo: "Vou Amar" }, { n: 15, titulo: "Ânimo" }
  ],
  "Ocultos da Alma": [
    { n: 1, titulo: "Amor no Céu" }, { n: 2, titulo: "Circo de Terror" }, { n: 3, titulo: "Eclipse" },
    { n: 4, titulo: "Ocultos da Alma" }, { n: 5, titulo: "Onde Está o Homem?" }, { n: 6, titulo: "Poder da Palavra" },
    { n: 7, titulo: "Sem Noção, Sem Ética" }, { n: 8, titulo: "Ser Pai" }, { n: 9, titulo: "Sua Consciência" },
    { n: 10, titulo: "Ética do Silêncio" }
  ],
  "Peso da Caneta": [
    { n: 1, titulo: "A Mente é Livre" }, { n: 2, titulo: "A Prisão do Silêncio" }, { n: 3, titulo: "Areia, Lua e Mar" },
    { n: 4, titulo: "História Viva" }, { n: 5, titulo: "Meu Legado" }, { n: 6, titulo: "O Legado da Tinta" },
    { n: 7, titulo: "O Tempo Não Para" }, { n: 8, titulo: "O Tempo Passa" }, { n: 9, titulo: "Peso da Caneta" },
    { n: 10, titulo: "Sangra Poesia" }
  ],
  "Poesia Viva": [
    { n: 1, titulo: "Coração" }, { n: 2, titulo: "Factual Sonho" }, { n: 3, titulo: "Ilação" },
    { n: 4, titulo: "Pedra Meio Caminho" }, { n: 5, titulo: "Poesia Viva" }, { n: 6, titulo: "Rainha da Noite" },
    { n: 7, titulo: "Raios de Sal" }, { n: 8, titulo: "Sem Rumo" }, { n: 9, titulo: "Ser Pedra" }
  ],
  "Prisões Invisíveis": [
    { n: 1, titulo: "Ainda há Sonhos" }, { n: 2, titulo: "Branca Escuridão" }, { n: 3, titulo: "Celebrar a Inconsciência" },
    { n: 4, titulo: "Consciência Refletida" }, { n: 5, titulo: "Gritos do Silêncio" }, { n: 6, titulo: "Introspecção" },
    { n: 7, titulo: "Morrer Pra Viver" }, { n: 8, titulo: "O Porão da Alma" }, { n: 9, titulo: "Prisões Invisíveis" },
    { n: 10, titulo: "Ser Consciente" }, { n: 11, titulo: "Tomada de Decisão" }, { n: 12, titulo: "É Difícil Voar" }
  ],
  "Razão do Coração": [
    { n: 1, titulo: "A Fatura Chegou" }, { n: 2, titulo: "Apressado" }, { n: 3, titulo: "Benefício do Amor" },
    { n: 4, titulo: "Ilógico" }, { n: 5, titulo: "Interrogações" }, { n: 6, titulo: "Labirinto do Meu Ser" },
    { n: 7, titulo: "O Encontro" }, { n: 8, titulo: "O Mundo Virou" }, { n: 9, titulo: "Pareço o Mesmo" },
    { n: 10, titulo: "Queria Sossego" }, { n: 11, titulo: "Razão do Coração" }, { n: 12, titulo: "Tac, Clique" }
  ],
  "Ressignifique!": [
    { n: 1, titulo: "Amor Que Decide" }, { n: 2, titulo: "Estações do Amor" }, { n: 3, titulo: "Fenômeno de Mim" },
    { n: 4, titulo: "Homem" }, { n: 5, titulo: "O Clima" }, { n: 6, titulo: "Porque?" },
    { n: 7, titulo: "Poço Sem Fundo" }, { n: 8, titulo: "Qual o Propósito" }, { n: 9, titulo: "Que Mundo é Esse?" },
    { n: 10, titulo: "Ressignifique!" }
  ],
  "Tempo Indomável": [
    { n: 1, titulo: "Analfabeto do Afeto" }, { n: 2, titulo: "Analfabeto Emocional" }, { n: 3, titulo: "Preciso Convencer?" },
    { n: 4, titulo: "Quem Pode?" }, { n: 5, titulo: "Quem Sou Eu" }, { n: 6, titulo: "Simplesmente" },
    { n: 7, titulo: "Sociedade Melindrosa" }, { n: 8, titulo: "Solidão em Paz" }, { n: 9, titulo: "Tempo Indomável" }
  ],
  "Tornado da Arte": [
    { n: 1, titulo: "Arte Frenética" }, { n: 2, titulo: "Arte Não Dorme" }, { n: 3, titulo: "Futuro" },
    { n: 4, titulo: "História Infinita" }, { n: 5, titulo: "Incoerente" }, { n: 6, titulo: "Passado" },
    { n: 7, titulo: "Por Entre os Dedos" }, { n: 8, titulo: "Presente" }, { n: 9, titulo: "Tornado da Arte" }
  ],
  "Íntima Relação": [
    { n: 1, titulo: "Até Quando" }, { n: 2, titulo: "Crepúsculo" }, { n: 3, titulo: "Desprezar a Sabedoria" },
    { n: 4, titulo: "Imaginação" }, { n: 5, titulo: "O Olhar" }, { n: 6, titulo: "Parcial" },
    { n: 7, titulo: "Paronímia" }, { n: 8, titulo: "Sentinela" }, { n: 9, titulo: "Ser ou Não Ser" },
    { n: 10, titulo: "Viver" }, { n: 11, titulo: "Íntima Relação" }
  ],
};

function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('🚀 Iniciando mega correção de álbuns, nomes e ordem...\n');
  
  const dbAlbuns = await sql`SELECT id, title FROM albums`;
  
  for (const [albumNome, musicas] of Object.entries(albunsCorretos)) {
    const dbAlbum = dbAlbuns.find(a => normalize(a.title) === normalize(albumNome));
    
    if (!dbAlbum) {
      console.log(`⚠️ Álbum não encontrado no banco: ${albumNome}`);
      continue;
    }

    console.log(`\n💿 Processando álbum: ${albumNome} (ID: ${dbAlbum.id})`);

    const dbTracks = await sql`SELECT id, title, preview_key FROM tracks WHERE album_id = ${dbAlbum.id} ORDER BY id ASC`;
    
    // 1. Atualiza os nomes e a ordem
    for (const musica of musicas) {
      const normTarget = normalize(musica.titulo);
      
      const dbTrack = dbTracks.find(t => {
        const normDb = normalize(t.title);
        return normDb === normTarget || normDb.includes(normTarget) || normTarget.includes(normDb);
      });

      if (dbTrack) {
        await sql`
          UPDATE tracks 
          SET title = ${musica.titulo}, track_number = ${musica.n} 
          WHERE id = ${dbTrack.id}
        `;
        console.log(`  ✅ [${musica.n}] ${musica.titulo}`);
      } else {
        console.log(`  ❌ Não encontrada no banco: ${musica.titulo}`);
      }
    }

    // 2. Remove duplicatas que sobraram
    const tracksAtualizadas = await sql`SELECT id, title, preview_key FROM tracks WHERE album_id = ${dbAlbum.id} ORDER BY track_number ASC, id ASC`;
    const vistos = new Set();
    
    for (const t of tracksAtualizadas) {
      if (vistos.has(t.title)) {
        await sql`DELETE FROM tracks WHERE id = ${t.id}`;
        console.log(`  🗑️ Duplicata removida: ${t.title}`);
      } else {
        vistos.add(t.title);
      }
    }
  }

  console.log('\n🎉 Mega correção concluída!');
  process.exit(0);
}

main().catch(console.error);