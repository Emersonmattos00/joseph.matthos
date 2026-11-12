const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// ⚠️ MAPEAMENTO COMPLETO BASEADO NOS PRINTS ⚠️
const dados = {
  "Mentalidade de Ouro, Vol. 1": [
    { title: "Ser Não Ser", isrc: "QTE6EY2677077" },
    { title: "20 Conquistar", isrc: "QTE6EY2677079" },
    { title: "Ninguém", isrc: "QTE6EY2677080" },
    { title: "Jornada", isrc: "QTE6EY2677081" },
    { title: "Minha Preta", isrc: "QTE6EY2677082" }
  ],
  "Mentalidade de Ouro, Vol. 2": [
    { title: "Meio do Tempo", isrc: "QTE6EY2698498" },
    { title: "Eis a Questão!", isrc: "QTE6EY2698499" },
    { title: "Avance", isrc: "QTE6EY2698500" },
    { title: "Toque", isrc: "QTE6EY2698501" },
    { title: "Passo a Passo", isrc: "QTE6EY2698502" },
    { title: "Razão vs Coração", isrc: "QTE6EY2698503" },
    { title: "Identidade?", isrc: "QTE6EY2698504" },
    { title: "Relento", isrc: "QTE6EY2698505" },
    { title: "Inversão de Valores", isrc: "QTE6EY2698506" },
    { title: "Uma Canção", isrc: "QTE6EY2698507" }
  ],
  "Mentalidade de Ouro, Vol. 3": [
    { title: "Mentalidade de Ouro", isrc: "QTE6EZ2630615" },
    { title: "Poeta", isrc: "QTE6EZ2630616" },
    { title: "Ninguém?", isrc: "QTE6EZ2630617" },
    { title: "Vida do Tempo", isrc: "QTE6EZ2630618" },
    { title: "Normal", isrc: "QTE6EZ2630619" },
    { title: "Traz de Volta", isrc: "QTE6EZ2630620" },
    { title: "Caos", isrc: "QTE6EZ2630621" },
    { title: "Sei Lá!?", isrc: "QTE6EZ2630622" },
    { title: "Lírico", isrc: "QTE6EZ2630623" },
    { title: "Deserto", isrc: "QTE6EZ2630624" }
  ],
  "Mentalidade de Ouro, Vol. 4": [
    { title: "Saudade", isrc: "QTE6EZ2638762" },
    { title: "Tríade", isrc: "QTE6EZ2638763" },
    { title: "Hoje; Só Hoje", isrc: "QTE6EZ2638764" },
    { title: "Corardia", isrc: "QTE6EZ2638765" },
    { title: "Ah Deus!", isrc: "QTE6EZ2638766" },
    { title: "Sumidouro Social", isrc: "QTE6EZ2638767" },
    { title: "Incessante Inspiração", isrc: "QTE6EZ2638768" },
    { title: "Lua Molhada de Céu", isrc: "QTE6EZ2638769" },
    { title: "Pele", isrc: "QTE6EZ2638770" },
    { title: "Sabor", isrc: "QTE6EZ2638771" }
  ],
  "Mentalidade de Ouro, Vol. 5": [
    { title: "Poética", isrc: "QTE6F32600399" },
    { title: "Factual Sonho", isrc: "QTE6F32600400" },
    { title: "Fique Perto de Mim", isrc: "QTE6F32600401" },
    { title: "Um Lindo Momento", isrc: "QTE6F32600402" },
    { title: "Lugar", isrc: "QTE6F32600403" },
    { title: "Momento", isrc: "QTE6F32600404" },
    { title: "Palavra", isrc: "QTE6F32600405" },
    { title: "A Folha", isrc: "QTE6F32600406" },
    { title: "Olhos", isrc: "QTE6F32600407" },
    { title: "Místico", isrc: "QTE6F32600408" },
    { title: "Pedido", isrc: "QTE6F32600409" },
    { title: "Singular", isrc: "QTE6F32600410" },
    { title: "A Vida É Bela", isrc: "QTE6F32600411" },
    { title: "A Questão É! Full", isrc: "QTE6F32600412" },
    { title: "Aquela Janela", isrc: "QTE6F32600413" },
    { title: "Pressões da Vida", isrc: "QTE6F32600414" },
    { title: "Saudosa Lembrança", isrc: "QTE6F32600415" }
  ],
  "Poesia Viva": [
    { title: "Rainha da Noite", isrc: "QTE6F32648788" },
    { title: "Ser Pedra", isrc: "QTE6F32648789" },
    { title: "Poesia Viva", isrc: "QTE6F32648790" },
    { title: "Ilação", isrc: "QTE6F32648791" },
    { title: "Pedra, Meio, Caminho", isrc: "QTE6F32648792" },
    { title: "Sem Rumo", isrc: "QTE6F32648793" },
    { title: "Factual Sonho", isrc: "QTE6F32600400" },
    { title: "Raios de Sal", isrc: "QTE6F32648794" },
    { title: "Coração", isrc: "QTE6F32648795" }
  ],
  "Jardim do Coração": [
    { title: "Jardim do Coração", isrc: "QTE6F52665559" },
    { title: "Suplício Aflito", isrc: "QTE6F52665560" },
    { title: "Ilação", isrc: "QTE6F32648791" },
    { title: "Pedra, Meio, Caminho", isrc: "QTE6F32648792" },
    { title: "Início", isrc: "QTE6F52665561" },
    { title: "Pá Lavra", isrc: "QTE6F52665562" },
    { title: "Imagine", isrc: "QTE6F52665563" },
    { title: "Apenas", isrc: "QTE6F52665564" },
    { title: "Jornada Sem Objetivo", isrc: "QTE6F52665565" },
    { title: "Intervalo", isrc: "QTE6F52665566" },
    { title: "Rainha da Noite", isrc: "QTE6F32648788" }
  ],
  "Caminho, Direção": [
    { title: "Sou Superestimado", isrc: "QTE6G92655206" },
    { title: "Limites da Imaginação", isrc: "QTE6G92655207" },
    { title: "Tempos Antigos", isrc: "QTE6G92655208" },
    { title: "A Vida Me Ensina", isrc: "QTE6G92655209" },
    { title: "Eu Tenho Solução", isrc: "QTE6G92655210" },
    { title: "Caminho, Direção", isrc: "QTE6G92655211" },
    { title: "Entre Luz e Sombra", isrc: "QTE6G92655212" },
    { title: "Encontrei a Luz", isrc: "QTE6G92655213" },
    { title: "Quem Esclarece?", isrc: "QTE6G92655214" },
    { title: "Só Ame", isrc: "QTE6G92655215" }
  ],
  "Ressignifique!": [
    { title: "Estações do Amor", isrc: "QTE6HJ2653249" },
    { title: "Fenômeno de Mim", isrc: "QTE6HJ2653250" },
    { title: "Homem", isrc: "QTE6HJ2653251" },
    { title: "Amor Que Decide", isrc: "QTE6HJ2653252" },
    { title: "O Clima", isrc: "QTE6HJ2653253" },
    { title: "Poço Sem Fundo", isrc: "QTE6HJ2653254" },
    { title: "Porquê?", isrc: "QTE6HJ2653255" },
    { title: "Ressignifique!", isrc: "QTE6HJ2653256" },
    { title: "Que Mundo é Esse?", isrc: "QTE6HJ2653257" },
    { title: "Qual o Propósito?", isrc: "QTE6HJ2653258" }
  ],
  "Abismo do Coração": [
    { title: "Prisão da Razão", isrc: "QTE6HK2678227" },
    { title: "Abismo do Coração", isrc: "QTE6HK2678228" },
    { title: "Peleja", isrc: "QTE6HK2678229" },
    { title: "Cárcere", isrc: "QTE6HK2678230" },
    { title: "Circunstanciado", isrc: "QTE6HK2678231" },
    { title: "Modo de Viver", isrc: "QTE6HK2678232" },
    { title: "Onde Estou?", isrc: "QTE6HK2678233" },
    { title: "Desperto no Escuro", isrc: "QTE6HK2678234" },
    { title: "Saber Viver", isrc: "QTE6HK2678235" },
    { title: "Cortejo", isrc: "QTE6HK2678236" }
  ],
  "Ocultos da Alma": [
    { title: "Amor no Céu", isrc: "QTE6HM2649603" },
    { title: "Eclipse", isrc: "QTE6HM2649605" },
    { title: "Ocultos da Alma", isrc: "QTE6HM2649606" },
    { title: "Sua Consciência", isrc: "QTE6HM2649607" },
    { title: "Ser Pai", isrc: "QTE6HM2649608" },
    { title: "A Ética do Silêncio", isrc: "QTE6HM2649609" },
    { title: "Circo do Terror", isrc: "QTE6HM2649610" },
    { title: "O Poder da Palavra", isrc: "QTE6HM2649611" },
    { title: "Sem Noção, Sem Ética", isrc: "QTE6HM2649612" },
    { title: "Onde Está o Homem?", isrc: "QTE6HM2649613" }
  ],
  "Peso da Caneta": [
    { title: "O Tempo Passa", isrc: "QTE6HP2607390" },
    { title: "Areia, Lua e Mar", isrc: "QTE6HP2607391" },
    { title: "Meu Legado", isrc: "QTE6HP2607392" },
    { title: "O Tempo Não Pára", isrc: "QTE6HP2607393" },
    { title: "História Viva", isrc: "QTE6HP2607394" },
    { title: "A Mente é Livre", isrc: "QTE6HP2607395" },
    { title: "Sangra Poesia", isrc: "QTE6HP2607396" },
    { title: "Peso da Caneta", isrc: "QTE6HP2607397" },
    { title: "A Prisão do Silêncio", isrc: "QTE6HP2607398" },
    { title: "O Legado da Tinta", isrc: "QTE6HP2607399" }
  ],
  "Máquina do Tempo": [
    { title: "Ciclo da Entrega", isrc: "QTE6HQ2607167" },
    { title: "A Natureza Ensina", isrc: "QTE6HQ2607168" },
    { title: "Máquina do Tempo", isrc: "QTE6HQ2607169" },
    { title: "Ainda dá Tempo?", isrc: "QTE6HQ2607170" },
    { title: "Viver Naquele Tempo", isrc: "QTE6HQ2607171" },
    { title: "Em Extinção", isrc: "QTE6HQ2607172" },
    { title: "Em Que Curva?", isrc: "QTE6HQ2607173" },
    { title: "Valores Sem Valor", isrc: "QTE6HQ2607174" },
    { title: "Entregar", isrc: "QTE6HQ2607175" },
    { title: "Energia Desnecessária", isrc: "QTE6HQ2607176" }
  ],
  "Boom, Boom, Bap": [
    { title: "Predestinado", isrc: "QTE6HS2616997" },
    { title: "Trono da Vontade", isrc: "QTE6HS2616998" },
    { title: "Paradoxo", isrc: "QTE6HS2616999" },
    { title: "Vaidade da Vaidade", isrc: "QTE6HS2616990" },
    { title: "O Barulho do Silêncio", isrc: "QTE6HS2616991" },
    { title: "Outro Nível", isrc: "QTE6HS2616992" },
    { title: "Velho Homem", isrc: "QTE6HS2616993" },
    { title: "Manual de Sobrevivência", isrc: "QTE6HS2616994" },
    { title: "Mesma Matéria", isrc: "QTE6HS2616995" },
    { title: "Ego", isrc: "QTE6HS2616996" }
  ],
  "O Despertar": [
    { title: "Aparente Normalidade", isrc: "QTE6HT2667674" },
    { title: "Cubículo", isrc: "QTE6HT2667675" },
    { title: "Fique Fora da Vitrine", isrc: "QTE6HT2667676" },
    { title: "Interação", isrc: "QTE6HT2667677" },
    { title: "O Despertar", isrc: "QTE6HT2667678" },
    { title: "Outra Versão", isrc: "QTE6HT2667679" },
    { title: "Pense", isrc: "QTE6HT2667680" },
    { title: "Presta Atenção", isrc: "QTE6HT2667681" },
    { title: "Quem?", isrc: "QTE6HT2667682" },
    { title: "Queria Ser Alguém", isrc: "QTE6HT2667683" },
    { title: "Reflexão", isrc: "QTE6HT2667684" },
    { title: "Vivendo a Reflexão", isrc: "QTE6HT2667685" }
  ],
  "Eu Comigo": [
    { title: "O Despertar da Consciência", isrc: "QTE6HU2624757" },
    { title: "Eu Comigo", isrc: "QTE6HU2624758" },
    { title: "Conclusão", isrc: "QTE6HU2624759" },
    { title: "Crack! Shhh!", isrc: "QTE6HU2624760" },
    { title: "Ímpar", isrc: "QTE6HU2624761" },
    { title: "Instante do Momento", isrc: "QTE6HU2624762" },
    { title: "Molhada de Céu", isrc: "QTE6HU2624763" },
    { title: "O Ciclo", isrc: "QTE6HU2624764" },
    { title: "O Que Sou?", isrc: "QTE6HU2624765" },
    { title: "Trovador", isrc: "QTE6HU2624766" }
  ],
  "Mar de Inquirições": [
    { title: "Arquitetura da Ausência", isrc: "QTE6HV2660592" },
    { title: "Cadê Você?", isrc: "QTE6HV2660593" },
    { title: "Dimensão da Psiquê", isrc: "QTE6HV2660594" },
    { title: "Fenômenos da Mente", isrc: "QTE6HV2660595" },
    { title: "Gritos Gritados", isrc: "QTE6HV2660596" },
    { title: "Mar de Inquirições", isrc: "QTE6HV2660598" },
    { title: "Onde Está o Brilho?", isrc: "QTE6HV2660599" },
    { title: "Preto e Branco", isrc: "QTE6HV2660600" },
    { title: "Ser Criança", isrc: "QTE6HV2660601" },
    { title: "Único, Singular", isrc: "QTE6HV2660602" }
  ],
  "Contraditório": [
    { title: "Anonimato e Fama", isrc: "QTE6J32630677" },
    { title: "Carpindo", isrc: "QTE6J32630678" },
    { title: "Confuso", isrc: "QTE6J32630679" },
    { title: "Contraditório", isrc: "QTE6J32630680" },
    { title: "Família Ingrata", isrc: "QTE6J32630681" },
    { title: "Gírias", isrc: "QTE6J32630682" },
    { title: "Indefinível", isrc: "QTE6J32630683" },
    { title: "Ironia", isrc: "QTE6J32630684" },
    { title: "Liberdade Presa", isrc: "QTE6J32630685" },
    { title: "Luxo, Lixo", isrc: "QTE6J32630686" },
    { title: "Não Me Importo", isrc: "QTE6J32630687" },
    { title: "Policiar", isrc: "QTE6J32630688" },
    { title: "Reflexo da Alma", isrc: "QTE6J32630689" },
    { title: "Saudoso", isrc: "QTE6J32630690" },
    { title: "Só Observo", isrc: "QTE6J32630691" }
  ],
  "Mundo Atual": [
    { title: "Sonhar Insano", isrc: "QTE6J42637729" },
    { title: "Aprendizado", isrc: "QTE6J42637730" },
    { title: "Mundo Atual", isrc: "QTE6J42637731" },
    { title: "A Natureza", isrc: "QTE6J42637732" },
    { title: "Não Sei", isrc: "QTE6J42637733" },
    { title: "Se Perdeu!", isrc: "QTE6J42637734" },
    { title: "O Que É Normal?", isrc: "QTE6J42637735" },
    { title: "Banalizaram", isrc: "QTE6J42637736" },
    { title: "Quem Matou?", isrc: "QTE6J42637737" },
    { title: "Saber Morrer", isrc: "QTE6J42637738" }
  ],
  "Tornado da Arte": [
    { title: "Arte Não Dorme", isrc: "QTE9XG2610895" },
    { title: "Arte Frenética", isrc: "QTE9XG2610896" },
    { title: "Incoerente", isrc: "QTE9XG2610897" },
    { title: "Tornado da Arte", isrc: "QTE9XG2610898" },
    { title: "Passado", isrc: "QTE9XG2610899" },
    { title: "Por Entre os Dedos", isrc: "QTE9XG2610900" },
    { title: "Presente", isrc: "QTE9XG2610901" },
    { title: "Futuro", isrc: "QTE9XG2610902" },
    { title: "História", isrc: "QTE9XG2610903" }
  ],
  "Tempo Indomável": [
    { title: "Preciso Convencer?", isrc: "QTA84Z698432" },
    { title: "Simplesmente", isrc: "QTA84Z698433" },
    { title: "Tempo Indomável", isrc: "QTA84Z698434" },
    { title: "Quem Pode?", isrc: "QTA84Z698435" },
    { title: "Quem Sou Eu", isrc: "QTA84Z698436" },
    { title: "Analfabeto do Afeto", isrc: "QTA84Z698437" },
    { title: "Solidão em Paz", isrc: "QTA84Z698438" },
    { title: "Analfabeto Emocional", isrc: "QTA84Z698439" },
    { title: "Sociedade Melindrosa", isrc: "QTA84Z698440" }
  ],
  "A Lógica da Consciência": [
    { title: "Eu Posso?", isrc: "QTA89Z600978" },
    { title: "Cadê a Razão?", isrc: "QTA89Z600974" },
    { title: "Saber Dosar", isrc: "QTA89Z600975" },
    { title: "Tempestade Humana", isrc: "QTA89Z600976" },
    { title: "Tudo Suporta", isrc: "QTA89Z600977" },
    { title: "Fé Indescritível", isrc: "QTA89Z600978" },
    { title: "A Lógica da Consciência", isrc: "QTA89Z600979" },
    { title: "Viver na Verdade", isrc: "QTA89Z600980" },
    { title: "Favela Viva", isrc: "QTA89Z600981" },
    { title: "Sociedade Vazia", isrc: "QTA89Z600982" }
  ]
};

async function corrigir() {
  console.log("🔍 Iniciando correção de ordens e ISRCs...\n");

  let totalAtualizados = 0;
  let totalErros = 0;

  for (const [albumTitle, tracks] of Object.entries(dados)) {
    console.log(`\n🎵 Álbum: ${albumTitle} (${tracks.length} faixas)`);

    // Busca o ID do álbum
    const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;
    if (!album) {
      console.log(`   ❌ Álbum não encontrado no banco. Pulando.`);
      continue;
    }

    // ETAPA 1: Move todas as faixas do álbum para números negativos (evita conflito)
    await sql`UPDATE tracks SET track_number = -track_number WHERE album_id = ${album.id}`;

    // ETAPA 2: Aplica a ordem correta e o ISRC
    for (let i = 0; i < tracks.length; i++) {
      const { title, isrc } = tracks[i];
      const novoTrackNumber = i + 1;

      try {
        const res = await sql`
          UPDATE tracks 
          SET track_number = ${novoTrackNumber}, 
              isrc = ${isrc}
          WHERE album_id = ${album.id} 
          AND title ILIKE ${`%${title}%`}
          RETURNING id, title
        `;

        if (res.length > 0) {
          console.log(`   ✅ ${novoTrackNumber}. ${title} -> ISRC: ${isrc}`);
          totalAtualizados++;
        } else {
          console.log(`   ⚠️ Não encontrada: "${title}"`);
          totalErros++;
        }
      } catch (err) {
        console.log(`   ❌ Erro em "${title}": ${err.message}`);
        totalErros++;
      }
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Músicas atualizadas: ${totalAtualizados}`);
  console.log(`⚠️ Erros/Não encontradas: ${totalErros}`);
}

corrigir().catch(console.error);