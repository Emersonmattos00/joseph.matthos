const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { streamRatelimit } = require('./_cache');

const s3Client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  },
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 15000
  })
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');

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
    const keyToFetch = b2Key.startsWith('josephmatthos/') ? b2Key : `josephmatthos/${b2Key}`;

    console.log(`[stream] Buscando ${keyToFetch} no bucket ${bucket}...`);

    // Prepara a requisição para o B2
    const rangeHeader = req.headers.range;
    const commandParams = { Bucket: bucket, Key: keyToFetch };
    
    // Se o navegador pedir um pedaço (Range), repassa para o B2
    if (rangeHeader) {
      commandParams.Range = rangeHeader;
    }

    const command = new GetObjectCommand(commandParams);
    
    let s3Response;
    try {
      s3Response = await s3Client.send(command);
    } catch (s3Err) {
      console.error('[stream] Erro no S3:', s3Err.name, s3Err.message);
      return res.status(404).json({ 
        error: 'Arquivo não encontrado no Backblaze B2', 
        details: s3Err.message,
        code: s3Err.name
      });
    }

    // Configura os cabeçalhos baseados na resposta do B2
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (s3Response.ContentRange) {
      res.setHeader('Content-Range', s3Response.ContentRange);
    }
    if (s3Response.ContentLength) {
      res.setHeader('Content-Length', s3Response.ContentLength);
    }

    // Se o B2 retornou um status de Range (206), retorna 206 para o navegador
    if (s3Response.$metadata && s3Response.$metadata.httpStatusCode === 206) {
      res.status(206);
    }

    const body = s3Response.Body;
    
    if (!body) {
      return res.status(500).json({ error: 'Corpo do arquivo vazio no B2' });
    }

    if (typeof body.pipe === 'function') {
      body.pipe(res);
    } 
    else if (typeof body.getReader === 'function') {
      const { Readable } = require('stream');
      Readable.fromWeb(body).pipe(res);
    }
    else if (typeof body.arrayBuffer === 'function') {
      const buffer = Buffer.from(await body.arrayBuffer());
      res.end(buffer);
    } 
    else {
      return res.status(500).json({ error: 'Formato de stream do S3 desconhecido', type: typeof body });
    }

  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno no servidor', message: error.message });
    }
  }
};