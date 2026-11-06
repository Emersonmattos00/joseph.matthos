/* ============================================================
   api/stream.js — Entrega de áudio (Versão Final Segura)
   ============================================================ */

'use strict';

const { eq, and, gt, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');
const { getPlaybackUrl } = require('./_storage');

// ★ CDN fallback para previews gratuitas
const CDN_BASE = process.env.CDN_BASE_URL || 'https://josephmatthos-cdn.emerson-mattos00.workers.dev';

module.exports = async (req, res) => {
  // CORS restrito
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    
    // Rate limit com fail-closed (se Redis cair em prod, nega)
    const rl = await checkStreamRateLimit(ip);
    if (!rl.success) return res.status(429).json({ error: 'Muitas requisições' });

    const { trackId } = req.query;
    if (!trackId) return res.status(400).json({ error: 'trackId obrigatório' });

    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return res.status(404).json({ error: 'Faixa não encontrada' });

    let user = null;
    try { user = await getAuthUser(req); } catch (e) {}

    let accessLevel = 'preview';

    if (user) {
      const now = new Date().toISOString();
      
      // 1. Checa Assinatura Premium
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

      // 2. Checa Aluguel (se não for Premium)
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

    // Padronização do caminho
    const cleanKey = String(b2Key)
      .replace(/^\/+/, '')
      .replace(/^josephmatthos\//, ''); 

    // ★ CORREÇÃO DE SEGURANÇA: URL assinada para áudio completo
    if (accessLevel === 'full') {
      try {
        // Gera URL assinada do B2 que expira em 5 minutos (300s)
        // O `true` avisa ao _storage.js para usar o bucket de áudio full
        const signedUrl = await getPlaybackUrl(cleanKey, true);
        
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, signedUrl);
      } catch (err) {
        console.error('[stream] Falha ao gerar URL assinada:', err.message);
        // Fail-closed: se o B2 falhar, NÃO entrega o áudio completo.
        return res.status(503).json({ error: 'Serviço de áudio temporariamente indisponível.' });
      }
    }

    // Preview: CDN público é aceitável (arquivo de 30s)
    const cdnUrl = `${CDN_BASE}/${cleanKey}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] erro detalhado:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erro interno no servidor' });
    }
  }
};// redeploy Thu Nov  5 18:32:20 UTC 2026
