const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
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

    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return res.status(404).json({ error: 'Faixa não encontrada' });

    let user = null;
    try {
      user = await getAuthUser(req);
    } catch (e) {
      console.warn('[stream] getAuthUser falhou:', e.message);
    }

    let accessLevel = 'preview';

    if (user) {
      const now = new Date().toISOString();

      // 1) Assinatura ativa vigente
      try {
        const [sub] = await db.select().from(subscriptions)
          .where(and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.status, 'ACTIVE'),
            gt(subscriptions.currentPeriodEnd, now)
          ))
          .limit(1);
        if (sub) accessLevel = 'full';
      } catch (e) {
        console.warn('[stream] checagem de assinatura falhou:', e.message);
      }

      // 2) Aluguel ativo cobrindo a faixa ou o álbum da faixa
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
            ))
            .limit(1);
          if (rent) accessLevel = 'full';
        } catch (e) {
          console.warn('[stream] checagem de aluguel falhou:', e.message);
        }
      }
    }

    // O banco já tem o caminho completo: "josephmatthos/pesodacaneta/..."
    const b2Key = track.streamKey || track.fullPath;
    if (!b2Key) return res.status(404).json({ error: 'Arquivo de áudio não configurado' });

    const audioUrl = await getPlaybackUrl(b2Key, accessLevel === 'full');

    const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();

    return res.status(200).json({
      accessLevel,
      previewDuration: accessLevel === 'preview' ? 30 : null,
      audioUrl,
      expiresAt,
      requiresPayment: accessLevel !== 'full',
      track: {
        id: track.id,
        title: track.title,
        albumId: track.albumId,
        durationSeconds: track.durationSeconds,
      },
    });
  } catch (error) {
    console.error('[stream] erro detalhado:', {
      message: error.message,
      name: error.name,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 8)
    });
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