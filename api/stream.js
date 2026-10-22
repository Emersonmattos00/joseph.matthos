const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { streamRatelimit } = require('./_cache');
const { Readable } = require('stream');

const s3Client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const { success } = await streamRatelimit.limit(ip);
    if (!success) return res.status(429).json({ error: 'Muitas requisições' });

    const { trackId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'trackId obrigatório' });

    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return res.status(404).json({ error: 'Faixa não encontrada' });

    let user = null;
    try { user = await getAuthUser(req); } catch (e) {}

    let accessLevel = 'preview';

    if (user) {
      const now = new Date().toISOString();
      try {
        const [sub] = await db.select().from(subscriptions)
          .where(and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.status, 'ACTIVE'),
            gt(subscriptions.currentPeriodEnd, now)
          )).limit(1);
        if (sub) accessLevel = 'full';
      } catch (e) {}

      if (accessLevel !== 'full') {
        try {
          const rentalCond = or(
            eq(rentals.trackId, track.id),
            track.albumId ? eq(rentals.albumId, track.albumId) : eq(rentals.trackId, track.id)
          );
          const [rent] = await db.select().from(rentals)
            .where(and(
              eq(rentals.userId, user.id),
              eq(rentals.status, 'ACTIVE'),
              gt(rentals.expiresAt, now),
              rentalCond
            )).limit(1);
          if (rent) accessLevel = 'full';
        } catch (e) {}
      }
    }

    const b2Key = accessLevel === 'full' 
      ? (track.streamKey || track.fullPath) 
      : (track.previewKey || track.streamKey || track.fullPath);
    
    if (!b2Key) {
      return res.status(404).json({ error: 'Arquivo de áudio não configurado no banco.' });
    }

    const bucket = process.env.B2_AUDIO_BUCKET || 'josephmatthos';
    
    // Garante que a chave tenha o prefixo correto. 
    // Se a chave salva já tem o nome da pasta (ex: pesodacaneta/...), adicionamos o bucket se necessário.
    // A lógica do seu `_storage.js` adicionava 'josephmatthos/'. Vamos manter a mesma lógica.
    const keyToFetch = b2Key.startsWith('josephmatthos/') ? b2Key : `josephmatthos/${b2Key}`;

    console.log(`[stream] Buscando ${keyToFetch} no bucket ${bucket}...`);

    const command = new GetObjectCommand({ Bucket: bucket, Key: keyToFetch });
    
    let s3Response;
    try {
      s3Response = await s3Client.send(command);
    } catch (s3Err) {
      console.error('[stream] Erro no S3:', s3Err.message);
      return res.status(404).json({ error: 'Arquivo não encontrado no Backblaze B2', details: s3Err.message });
    }

    // Define os cabeçalhos para o navegador entender que é um áudio
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Converte o fluxo do S3 (WebStream) para Node Stream
    const stream = Readable.fromWeb(s3Response.Body);
    
    // Se o cliente fechar a conexão, encerra o download do S3 para economizar recursos
    req.on('close', () => {
      stream.destroy();
    });

    // Transmite o áudio para o navegador
    stream.pipe(res);

  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno no servidor', message: error.message });
    }
  }
};