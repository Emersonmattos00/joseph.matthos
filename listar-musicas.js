const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

// Pega as credenciais do .env.local (compatível com os nomes B2_* e R2_*)
const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;
const bucket = process.env.B2_MEDIA_BUCKET || "josephmatthos";

if (!accessKey || !secretKey || !endpointUrl) {
  console.error("❌ ERRO: Credenciais não encontradas no .env.local.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

async function listarArquivos() {
  console.log(`🔍 Buscando arquivos no bucket R2: ${bucket}...\n`);
  
  let ContinuationToken;
  const arquivos = [];

  try {
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken
      }));

      if (list.Contents) {
        for (const obj of list.Contents) {
          // Ignora pastas vazias
          if (obj.Key.endsWith('/')) continue; 
          arquivos.push({
            key: obj.Key,
            sizeMB: (obj.Size / (1024 * 1024)).toFixed(2)
          });
        }
      }
      ContinuationToken = list.NextContinuationToken;
    } while (ContinuationToken);

    console.log(`✅ Total de arquivos encontrados: ${arquivos.length}\n`);

    // Separa por pastas para facilitar a leitura no terminal
    const audiosPremium = arquivos.filter(a => a.key.startsWith('premium/'));
    const audiosPreview = arquivos.filter(a => a.key.startsWith('previews/'));
    const imagens = arquivos.filter(a => a.key.startsWith('assets/img/'));
    const outros = arquivos.filter(a => !a.key.startsWith('premium/') && !a.key.startsWith('previews/') && !a.key.startsWith('assets/img/'));

    console.log(`🎵 Áudios Completos (premium/): ${audiosPremium.length}`);
    console.log(`✂️ Prévias de 30s (previews/): ${audiosPreview.length}`);
    console.log(`🖼️ Imagens (assets/img/): ${imagens.length}`);
    console.log(`📁 Outros arquivos: ${outros.length}\n`);

    // Cria o CSV
    let csv = 'Caminho no R2 (Key);Tamanho (MB);Tipo\n';
    
    arquivos.forEach(a => {
      let tipo = 'Outro';
      if (a.key.startsWith('premium/')) tipo = 'Audio Completo';
      if (a.key.startsWith('previews/')) tipo = 'Preview 30s';
      if (a.key.startsWith('assets/img/')) tipo = 'Imagem';
      
      csv += `${a.key};${a.sizeMB};${tipo}\n`;
    });

    fs.writeFileSync('lista-r2.csv', csv, 'utf-8');
    console.log('📄 Relatório salvo no arquivo "lista-r2.csv" (abra no Excel).\n');

    // Mostra no terminal os 5 primeiros de cada categoria como amostra
    console.log('--- AMOSTRA DE ÁUDIOS PREMIUM ---');
    audiosPremium.slice(0, 5).forEach(a => console.log(`- ${a.key} (${a.sizeMB} MB)`));

    console.log('\n--- AMOSTRA DE PREVIEWS ---');
    audiosPreview.slice(0, 5).forEach(a => console.log(`- ${a.key} (${a.sizeMB} MB)`));

  } catch (err) {
    console.error("❌ Erro ao listar arquivos do R2:", err.message);
  }
}

listarArquivos();