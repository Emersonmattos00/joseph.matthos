/*// Permite apenas o seu domínio
const origin = req.headers.origin;
if (['https://josephmatthos.com.br', 'https://www.josephmatthos.com.br', 'http://localhost:3000'].includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}*/

// api/stream.js
const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { streamRatelimit } = require('./_cache');

// ★ Base do Worker Cloudflare (CDN do B2)
const CDN_BASE = process.env.CDN_BASE_URL || 'https://josephmatthos-cdn.emerson-mattos.workers.dev';

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

    // LÓGICA DE SEGURANÇA: NUNCA entrega o full para quem não tem permissão
    let b2Key;
    if (accessLevel === 'full') {
      b2Key = track.streamKey || track.fullPath;
    } else {
      b2Key = track.previewKey;
      if (!b2Key) {
        return res.status(403).json({
          error: 'Prévia não disponível',
          message: 'Esta faixa não tem preview configurada. Alugue ou assine para ouvir o áudio completo.'
        });
      }
    }

    if (!b2Key) {
      return res.status(404).json({ error: 'Arquivo de áudio não configurado no banco.' });
    }

    // ★ Normaliza o caminho do arquivo no B2
    const cleanKey = String(b2Key)
      .replace(/^\/+/, '')
      .replace(/^josephmatthos\//, ''); // remove prefixo do bucket se já existir

    const cdnUrl = `${CDN_BASE}/${cleanKey}`;

    // ★ Redireciona o player para o Cloudflare Worker (CDN)
    // O Cloudflare busca no B2, cacheia e serve. Egress do B2 = zero após o primeiro hit.
    res.setHeader('Cache-Control', 'no-store'); // não cacheia a decisão de autorização
    res.setHeader('X-Access-Level', accessLevel);
    res.setHeader('X-CDN-URL', cdnUrl);
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno no servidor', message: error.message });
    }
  }
};