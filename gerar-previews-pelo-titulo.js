const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
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

const TMP_DIR = path.join(__dirname, 'tmp_previews');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// Função para normalizar palavras (remove acentos, pontuação, etc)
function normalizar(texto) {
  return texto.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text) {
  return normalizar(text).replace(/\s+/g, '-');
}

async function gerar() {
  console.log("🔍 Listando todos os arquivos da pasta 'premium/' no R2...");
  let ContinuationToken;
  const arquivosPremium = [];

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "premium/",
      ContinuationToken
    }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) arquivosPremium.push(obj.Key);
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Encontrados ${arquivosPremium.length} arquivos na pasta premium/.\n`);

  // Músicas que ainda não têm preview gerado (as que falharam)
  const titulosFalhos = [
    "Fé Indestrutível", "Acordado No Escuro", "Encarcerado", 
    "Sentimento Sepultado", "Família Ingrata", "Inversodevalores", 
    "A Vida Bela", "Meu Lugar No Mundo", "Anonimato Fama", 
    "Razão do Coração", "Gritos Silenciosos", "Ser Inocência", 
    "A Questão É! Full", "Pressas Da Vida"
  ];

  const tracks = await sql`SELECT id, title, preview_key FROM tracks`;
  const tracksFalhas = tracks.filter(t => titulosFalhos.includes(t.title));

  let gerados = 0;
  let naoEncontrados = [];

  for (const track of tracksFalhas) {
    const tituloNormalizado = normalizar(track.title);
    const slug = slugify(track.title);
    const caminhoPreviewFinal = `previews/${slug}.mp3`;

    console.log(`\n🎵 Processando: "${track.title}"`);

    // Procura na pasta premium/ um arquivo que tenha as palavras do título
    // Ex: "Fé Indestrutível" -> procura arquivos que tenham "fe" e "indestrutivel" (ou "indescritivel")
    const palavrasTitulo = tituloNormalizado.split(' ').filter(p => p.length > 2); // ignora palavras curtas como "a", "de"

    let arquivoOriginal = arquivosPremium.find(key => {
      const nomeArquivo = normalizar(path.basename(key, path.extname(key)));
      
      // Verifica se TODAS as palavras principais do título estão no nome do arquivo
      return palavrasTitulo.every(palavra => {
        // Trata pequenas variações (ex: "indestrutivel" vs "indescritivel")
        if (palavra === 'indestrutivel') return nomeArquivo.includes('indescritivel') || nomeArquivo.includes('indestrutivel');
        if (palavra === 'familia') return nomeArquivo.includes('familia') || nomeArquivo.includes('famlia');
        if (palavra === 'questao') return nomeArquivo.includes('questao') || nomeArquivo.includes('questaoe');
        if (palavra === 'inocencia') return nomeArquivo.includes('inocencia') || nomeArquivo.includes('ser-inocencia');
        
        return nomeArquivo.includes(palavra);
      });
    });

    if (!arquivoOriginal) {
      console.log(`   ❌ Nenhum arquivo em premium/ corresponde ao título.`);
      naoEncontrados.push(track.title);
      continue;
    }

    console.log(`   ℹ️  Arquivo encontrado: ${arquivoOriginal}`);

    try {
      // 1. Baixar áudio completo
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: arquivoOriginal });
      const response = await s3.send(getCmd);
      const bodyContents = await response.Body.transformToByteArray();
      
      const extensao = path.extname(arquivoOriginal) || '.mp3';
      const localPath = path.join(TMP_DIR, `${slug}${extensao}`);
      fs.writeFileSync(localPath, bodyContents);

      // 2. Cortar 30 segundos
      const tempPreviewPath = path.join(TMP_DIR, `${slug}_preview.mp3`);
      execSync(`ffmpeg -y -i "${localPath}" -ss 0 -t 30 -acodec copy "${tempPreviewPath}"`, { stdio: 'ignore' });

      // 3. Upload do preview
      const fileStream = fs.createReadStream(tempPreviewPath);
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: caminhoPreviewFinal,
        Body: fileStream,
        ContentType: "audio/mpeg",
      });
      await s3.send(putCmd);

      // 4. Atualizar banco
      await sql`UPDATE tracks SET preview_key = ${caminhoPreviewFinal} WHERE id = ${track.id}`;

      // Limpar temporários
      fs.unlinkSync(localPath);
      fs.unlinkSync(tempPreviewPath);

      gerados++;
      console.log(`   ✅ Preview gerado e banco atualizado!`);

    } catch (err) {
      console.error(`   ❌ Falha: ${err.message}`);
      naoEncontrados.push(track.title);
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído! ${gerados} previews gerados.`);
  
  if (naoEncontrados.length > 0) {
    console.log(`\n⚠️ ${naoEncontrados.length} músicas ainda não encontradas:`);
    naoEncontrados.forEach(t => console.log(`   - ${t}`));
    console.log("\n💡 Dica: Verifique se esses arquivos existem na pasta premium/ do R2 com nomes muito diferentes.");
  }
}

gerar().catch(console.error);