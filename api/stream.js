const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
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
    requestTimeout: 10000
  })
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { trackId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'trackId obrigatório' });

    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return res.status(404).json({ error: 'Faixa não encontrada' });

    const b2Key = track.streamKey || track.fullPath;
    const bucket = process.env.B2_AUDIO_BUCKET || 'josephmatthos';
    const keyToFetch = b2Key.startsWith('josephmatthos/') ? b2Key : `josephmatthos/${b2Key}`;

    console.log(`[diagnostico] Testando conexao S3: ${keyToFetch}`);

    // Faz um HEAD request rápido para ver se o arquivo existe e se as credenciais funcionam
    const command = new HeadObjectCommand({ Bucket: bucket, Key: keyToFetch });
    
    try {
      const head = await s3Client.send(command);
      return res.status(200).json({ 
        ok: true, 
        message: 'Conexão com B2 OK',
        bucket: bucket,
        key: keyToFetch,
        size: head.ContentLength,
        contentType: head.ContentType
      });
    } catch (s3Err) {
      console.error('[diagnostico] Erro S3:', s3Err.name, s3Err.message);
      return res.status(500).json({ 
        ok: false, 
        error: s3Err.name, 
        message: s3Err.message,
        bucket: bucket,
        key: keyToFetch
      });
    }
  } catch (error) {
    console.error('[diagnostico] Erro geral:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};