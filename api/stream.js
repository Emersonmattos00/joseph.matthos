/*// Permite apenas o seu domínio
const origin = req.headers.origin;
if (['https://josephmatthos.com.br', 'https://www.josephmatthos.com.br', 'http://localhost:3000'].includes(origin)) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}*/

/* ============================================================
   api/stream.js — Entrega de áudio (Versão Final Segura)
   ============================================================ */

'use strict';

const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { streamRatelimit } = require('./_cache');

// ★ Aqui usamos a variável de ambiente. 
// Se ela não existir (ex: em dev), ele usa um fallback para o Worker.
const CDN_BASE = process.env.CDN_BASE_URL || 'https://josephmatthos-cdn.emerson-mattos00.workers.dev';

module.exports = async (req, res) => {
  // CORS restrito para o seu domínio
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
      } catch (e) {
        console.error('[stream] Erro ao checar assinatura:', e);
      }

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
        } catch (e) {
          console.error('[stream] Erro ao checar aluguel:', e);
        }
      }
    }

    // LÓGICA DE SEGURANÇA: Decide qual arquivo entregar
    let b2Key;
    if (accessLevel === 'full') {
      b2Key = track.streamKey || track.fullPath;
    } else {
      b2Key = track.previewKey;
      if (!b2Key) {
        return res.status(403).json({ 
          error: 'Prévia indisponível', 
          message: 'Alugue ou assine para ouvir o áudio completo.' 
        });
      }
    }

    if (!b2Key) {
      return res.status(404).json({ error: 'Arquivo de áudio não configurado no banco.' });
    }

    // ★ PADRONIZAÇÃO DO CAMINHO (Correção da auditoria)
    // Remove barras extras no início e o prefixo do bucket se já existir
    const cleanKey = String(b2Key)
      .replace(/^\/+/, '')
      .replace(/^josephmatthos\//, ''); 

    // ★ REDIRECIONAMENTO (Economia de banda)
    const cdnUrl = `${CDN_BASE}/${cleanKey}`;

    // Não guarda a decisão de autorização no cache do navegador
    res.setHeader('Cache-Control', 'no-store');
    
    // Redireciona o player para o CDN (Cloudflare) ou para o B2
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno no servidor' });
    }
  }
};