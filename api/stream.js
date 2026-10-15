const { eq } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks } = require('../src/schema.js');
const { verifyUser, getUserAccessCached } = require('./_lib');
const { getPlaybackUrl } = require('./_storage');
const { streamRatelimit } = require('./_cache');

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

    // Buscar faixa no Neon
    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return res.status(404).json({ error: 'Faixa não encontrada' });

    // Verificar acesso
    const user = await verifyUser(req);
    let accessLevel = 'preview';
    let expiresAt = null;

    if (user) {
      const access = await getUserAccessCached(user.id, trackId);
      if (access.hasSubscription || access.hasRental) {
        accessLevel = 'full';
        expiresAt = access.expiresAt;
      }
    }

    // Escolher a chave do B2
    const b2Key = accessLevel === 'full' ? track.streamKey : track.previewKey;
    if (!b2Key) return res.status(404).json({ error: 'Arquivo de áudio não configurado' });

    const audioUrl = await getPlaybackUrl(b2Key, accessLevel === 'full');

    return res.status(200).json({
      accessLevel,
      previewDuration: accessLevel === 'preview' ? 30 : null,
      audioUrl,
      expiresAt,
      requiresPayment: accessLevel === 'preview',
      track: {
        id: track.id,
        title: track.title,
        albumId: track.albumId,
        durationSeconds: track.durationSeconds,
      },
    });
  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    const isDev = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      error: 'Erro interno do servidor',
      ...(isDev && {
        message: error.message,
        name: error.name,
        stack: error.stack?.split('\n').slice(0, 5),
      }),
    });
  }
};