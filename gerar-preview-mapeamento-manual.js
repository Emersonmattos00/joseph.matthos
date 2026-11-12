const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
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

function slugify(text) {
  return text.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// MAPEAMENTO MANUAL: Título no banco -> Arquivo real no R2
const mapeamento = {
  "Acordado No Escuro": "premium/abismodocoracao/desperto-no-escuro.mp3",
  "Encarcerado": "premium/abismodocoracao/prisao-da-razao.mp3", // ou carcere.mp3
  "Sentimento Sepultado": "premium/abismodocoracao/peleja.mp3", // estimativa
  "Inversodevalores": "premium/mentalidadedeourov2/inversao-de-valores.mp3",
  "Meu Lugar No Mundo": "premium/nadaacabou/meu-mugar-no-mundo.mp3", // erro de digitação no R2
  "Gritos Silenciosos": "premium/mardeinquiricoes/gritos-gritados.mp3",
  "Ser Inocência": "premium/mardeinquiricoes/ser-crianca.mp3",
  "A Questão É! Full": "premium/mentalidadedeourov5/a-questao-e.mp3",
  "Pressas Da Vida": "premium/mentalidadedeourov5/pressoes-da-vida.mp3"
};

async function gerar() {
  console.log("🎵 Gerando previews com mapeamento manual...\n");

  const tracks = await sql`SELECT id, title, preview_key FROM tracks`;
  
  let gerados = 0;
  let falhas = [];

  for (const [tituloBanco, arquivoR2] of Object.entries(mapeamento)) {
    const track = tracks.find(t => t.title === tituloBanco);
    
    if (!track) {
      console.log(`❌ Música "${tituloBanco}" não encontrada no banco.`);
      falhas.push(tituloBanco);
      continue;
    }

    const slug = slugify(track.title);
    const caminhoPreviewFinal = `previews/${slug}.mp3`;

    console.log(`\n🎵 Processando: "${track.title}"`);
    console.log(`   ℹ️  Arquivo R2: ${arquivoR2}`);

    try {
      // 1. Baixar áudio completo
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: arquivoR2 });
      const response = await s3.send(getCmd);
      const bodyContents = await response.Body.transformToByteArray();
      
      const extensao = path.extname(arquivoR2) || '.mp3';
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
      falhas.push(tituloBanco);
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído! ${gerados} previews gerados.`);
  
  if (falhas.length > 0) {
    console.log(`\n⚠️ ${falhas.length} músicas falharam:`);
    falhas.forEach(t => console.log(`   - ${t}`));
  }
}

gerar().catch(console.error);