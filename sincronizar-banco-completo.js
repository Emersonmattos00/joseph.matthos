const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;
const bucket = process.env.B2_MEDIA_BUCKET || "josephmatthos";

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

// Função para normalizar texto (remover acentos, pontuação, etc.)
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sincronizar() {
  console.log("🔍 Listando arquivos no R2 (premium/ e previews/)...");
  
  const arquivosPremium = new Map(); // Map<nomeNormalizado, caminhoReal>
  const arquivosPreviews = new Map();

  let ContinuationToken;
  // Lista tudo para separar depois
  const todosArquivos = [];
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken
    }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) todosArquivos.push(obj.Key);
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  // Popula os mapas
  for (const key of todosArquivos) {
    const nomeArquivo = path.basename(key, path.extname(key));
    const nomeNormalizado = normalizar(nomeArquivo);
    
    if (key.startsWith('premium/')) {
      arquivosPremium.set(nomeNormalizado, key);
    } else if (key.startsWith('previews/')) {
      arquivosPreviews.set(nomeNormalizado, key);
    }
  }

  console.log(`✅ Áudios completos encontrados: ${arquivosPremium.size}`);
  console.log(`✅ Previews encontrados: ${arquivosPreviews.size}\n`);

  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`✅ Músicas no banco: ${tracks.length}\n`);

  let atualizados = 0;
  let naoEncontrados = [];

  for (const track of tracks) {
    const tituloNormalizado = normalizar(track.title);
    
    // Tenta achar o arquivo premium correspondente
    let caminhoPremium = null;
    let caminhoPreview = null;

    // Estratégia 1: Busca exata pelo título normalizado
    if (arquivosPremium.has(tituloNormalizado)) {
      caminhoPremium = arquivosPremium.get(tituloNormalizado);
    } else {
      // Estratégia 2: Busca por conter as palavras do título
      const palavrasTitulo = tituloNormalizado.split(' ').filter(p => p.length > 2);
      for (const [nomeNorm, caminhoReal] of arquivosPremium.entries()) {
        if (palavrasTitulo.every(p => nomeNorm.includes(p))) {
          caminhoPremium = caminhoReal;
          break;
        }
      }
    }

    // Tenta achar o preview correspondente
    if (arquivosPreviews.has(tituloNormalizado)) {
      caminhoPreview = arquivosPreviews.get(tituloNormalizado);
    } else {
      const palavrasTitulo = tituloNormalizado.split(' ').filter(p => p.length > 2);
      for (const [nomeNorm, caminhoReal] of arquivosPreviews.entries()) {
        if (palavrasTitulo.every(p => nomeNorm.includes(p))) {
          caminhoPreview = caminhoReal;
          break;
        }
      }
    }

    // Se achou o áudio completo, atualiza o stream_key e o full_path
    if (caminhoPremium) {
      await sql`
        UPDATE tracks 
        SET stream_key = ${caminhoPremium}, full_path = ${caminhoPremium}
        WHERE id = ${track.id}
      `;
    }

    // Se achou o preview, atualiza o preview_key e o preview_path
    if (caminhoPreview) {
      await sql`
        UPDATE tracks 
        SET preview_key = ${caminhoPreview}, preview_path = ${caminhoPreview}
        WHERE id = ${track.id}
      `;
    }

    if (caminhoPremium && caminhoPreview) {
      atualizados++;
    } else {
      naoEncontrados.push({
        titulo: track.title,
        temPremium: !!caminhoPremium,
        temPreview: !!caminhoPreview
      });
    }
  }

  console.log(`\n🎉 Sincronização concluída!`);
  console.log(`✅ Músicas atualizadas com sucesso: ${atualizados}`);
  
  if (naoEncontrados.length > 0) {
    console.log(`\n⚠️ ${naoEncontrados.length} músicas não encontraram áudio/preview:`);
    naoEncontrados.forEach(t => {
      console.log(`   - ${t.titulo} (Áudio: ${t.temPremium ? 'OK' : 'FALTA'} | Preview: ${t.temPreview ? 'OK' : 'FALTA'})`);
    });
  }
}

sincronizar().catch(console.error);