/* ============================================================
   api/payments.js — Pagamentos consolidado
   ------------------------------------------------------------
   POST /api/payments?type=subscription → cria preapproval MP
   POST /api/payments?type=rental       → cria preferência MP
   POST /api/payments?type=webhook      → processa notificação MP

   - Assinatura: preapproval (cobrança recorrente)
   - Rental: preference (pagamento único, 48h de acesso)
   - Webhook: valida HMAC + idempotência via payments_events
   - Preços SEMPRE do servidor (envs + tracks.price_cents)
   - Webhook duplicado NÃO processado → reprocessa (retry_count)
   ============================================================ */

'use strict';

const crypto = require('crypto');

const {
  sendJson,
  supabaseAdminRequest,
  getAuthUser,
  checkAndIncrement,
  audit,
  parseBody,
  clientIp
} = require('./_lib');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MP_API_URL = 'https://api.mercadopago.com';
const MP_TIMEOUT_MS = 10000;

const VALID_PLANS = new Set(['premium', 'anual']);
const ACTIVE_STATUSES = new Set(['authorized', 'trialing']);
const REUSABLE_WINDOW_MS = 30 * 60 * 1000;

const MAX_ATTEMPTS_PER_USER = 10;
const MAX_ATTEMPTS_PER_IP = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const RENTAL_DURATION_HOURS = 48;
const MAX_TRACK_INDEX = 10000;
const MAX_ALBUM_ID_LENGTH = 64;

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_RETRY_COUNT = 10;

const GENERIC_ERROR = 'Não foi possível iniciar o pagamento.';
const GENERIC_RATE = 'Muitas tentativas. Tente novamente mais tarde.';

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Allow', 'POST');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const type = parseType(req.query);
  if (!type) {
    return sendJson(res, 400, { ok: false, error: 'Tipo inválido.' });
  }

  if ((req.method || '').toUpperCase() !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
  }

  switch (type) {
    case 'subscription': return handleSubscription(req, res);
    case 'rental': return handleRental(req, res);
    case 'webhook': return handleWebhook(req, res);
    default: return sendJson(res, 400, { ok: false, error: 'Tipo inválido.' });
  }
};

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTION
// ─────────────────────────────────────────────────────────────
async function handleSubscription(req, res) {
  const cfg = loadSubscriptionConfig();
  if (!cfg.ok) {
    console.error('[payments/subscription] Config ausente:', cfg.missing);
    return sendJson(res, 503, { ok: false, error: 'Pagamento indisponível.' });
  }

  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  let user;
  try {
    user = await getAuthUser(req);
  } catch (error) {
    console.error('[payments/subscription] getAuthUser:', error.code || error.message);
    return sendJson(res, 502, { ok: false, error: 'Autenticação indisponível.' });
  }

  if (!user || !user.id) {
    return sendJson(res, 401, { ok: false, error: 'Faça login para continuar.' });
  }

  if (!user.email || !user.email_confirmed_at) {
    return sendJson(res, 403, { ok: false, error: 'Confirme seu e-mail antes de assinar.' });
  }

  const [userRate, ipRate] = await Promise.all([
    checkAndIncrement(`pay-sub:user:${user.id}`, MAX_ATTEMPTS_PER_USER, RATE_WINDOW_MS),
    checkAndIncrement(`pay-sub:ip:${ip}`, MAX_ATTEMPTS_PER_IP, RATE_WINDOW_MS)
  ]);

  if (userRate.limited || ipRate.limited) {
    const retryAfter = Math.max(userRate.retryAfter, ipRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await audit('payment_subscription', { userId: user.id, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE });
  }

  const body = parseBody(req);
  const plan = typeof body.plan === 'string' ? body.plan.trim().toLowerCase() : '';

  if (!VALID_PLANS.has(plan)) {
    await audit('payment_subscription', { userId: user.id, ip, userAgent, success: false, reason: 'invalid_plan' });
    return sendJson(res, 400, { ok: false, error: 'Plano inválido.' });
  }

  const planConfig = cfg.plans[plan];
  if (!planConfig) {
    return sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  try {
    const activeSub = await getActiveSubscription(user.id);
    if (activeSub) {
      await audit('payment_subscription', { userId: user.id, ip, userAgent, success: false, reason: 'already_active' });
      return sendJson(res, 409, { ok: false, error: 'Você já possui uma assinatura ativa.' });
    }
  } catch (error) {
    console.warn('[payments/subscription] check active:', error.message);
  }

  try {
    const pending = await getPendingSubscriptionAttempt(user.id, plan);
    if (pending?.checkout_url) {
      const ageMs = Date.now() - new Date(pending.created_at).getTime();
      if (ageMs < REUSABLE_WINDOW_MS) {
        await audit('payment_subscription', { userId: user.id, ip, userAgent, success: true, reason: 'reused_pending' });
        return sendJson(res, 200, {
          ok: true,
          checkoutUrl: pending.checkout_url,
          preapprovalId: pending.preapproval_id,
          reused: true
        });
      }
    }
  } catch (error) {
    console.warn('[payments/subscription] check pending:', error.message);
  }

  const externalRef = generateExternalRef('chk');
  let attemptId = null;

  try {
    const insert = await supabaseAdminRequest('/rest/v1/payments_attempts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        kind: 'subscription',
        plan,
        amount: planConfig.amount,
        currency: 'BRL',
        status: 'creating',
        external_reference: externalRef,
        ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null
      })
    });

    if (!insert.response.ok || !Array.isArray(insert.body) || !insert.body[0]) {
      return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
    }
    attemptId = insert.body[0].id;
  } catch (error) {
    console.error('[payments/subscription] insert attempt:', error.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }

  let mp;
  try {
    mp = await createMercadoPagoPreapproval({ cfg, planConfig, externalRef, user });
  } catch (error) {
    await markAttemptFailed(attemptId, error.code || 'mp_error');
    await audit('payment_subscription', { userId: user.id, ip, userAgent, success: false, reason: error.code || 'mp_error' });

    if (error.code === 'TIMEOUT') {
      return sendJson(res, 504, { ok: false, error: 'Tempo esgotado. Tente novamente.' });
    }
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }

  try {
    await supabaseAdminRequest(
      `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attemptId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending',
          preapproval_id: mp.id,
          checkout_url: mp.checkoutUrl,
          updated_at: new Date().toISOString()
        })
      }
    );
  } catch (error) {
    console.error('[payments/subscription] PATCH attempt:', error.message);
  }

  await audit('payment_subscription', { userId: user.id, ip, userAgent, success: true, reason: 'created' });

  return sendJson(res, 200, { ok: true, checkoutUrl: mp.checkoutUrl, preapprovalId: mp.id });
}

function loadSubscriptionConfig() {
  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  const backUrl = String(process.env.MP_BACK_URL || '').trim();
  const env = String(process.env.MP_ENV || 'production').trim();

  const monthlyPrice = parsePrice(process.env.MP_PREMIUM_MONTHLY_PRICE);
  const annualPrice = parsePrice(process.env.MP_PREMIUM_ANNUAL_PRICE);

  const missing = [];
  if (!token) missing.push('MP_ACCESS_TOKEN');
  if (!backUrl) missing.push('MP_BACK_URL');
  if (!monthlyPrice) missing.push('MP_PREMIUM_MONTHLY_PRICE');
  if (!annualPrice) missing.push('MP_PREMIUM_ANNUAL_PRICE');
  if (!backUrl.startsWith('https://')) missing.push('MP_BACK_URL(https)');

  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    token,
    backUrl,
    env,
    webhookUrl: process.env.MP_WEBHOOK_URL || null,
    plans: {
      premium: {
        amount: monthlyPrice,
        frequency: 1,
        frequencyType: 'months',
        reason: 'Assinatura Premium mensal',
        planId: process.env.MP_PREMIUM_MONTHLY_PLAN_ID || null
      },
      anual: {
        amount: annualPrice,
        frequency: 12,
        frequencyType: 'months',
        reason: 'Assinatura Premium anual',
        planId: process.env.MP_PREMIUM_ANNUAL_PLAN_ID || null
      }
    }
  };
}

async function createMercadoPagoPreapproval({ cfg, planConfig, externalRef, user }) {
  const mpBody = {
    reason: planConfig.reason,
    external_reference: externalRef,
    payer_email: user.email,
    back_url: cfg.backUrl,
    status: 'pending',
    ...(cfg.webhookUrl ? { notification_url: cfg.webhookUrl } : {})
  };

  if (planConfig.planId) {
    mpBody.preapproval_plan_id = planConfig.planId;
  } else {
    mpBody.auto_recurring = {
      frequency: planConfig.frequency,
      frequency_type: planConfig.frequencyType,
      transaction_amount: planConfig.amount,
      currency_id: 'BRL'
    };
  }

  const response = await fetchMP(`${MP_API_URL}/preapproval`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': externalRef
    },
    body: JSON.stringify(mpBody)
  });

  if (!response.ok || !response.body || !response.body.id) {
    const reason = response.body?.message || response.body?.error || `http_${response.status}`;
    const err = new Error('MP error: ' + reason);
    err.code = 'MP_ERROR';
    throw err;
  }

  const checkoutUrl =
    cfg.env === 'sandbox'
      ? response.body.sandbox_init_point || response.body.init_point
      : response.body.init_point;

  if (!checkoutUrl) {
    const err = new Error('MP sem init_point');
    err.code = 'MP_NO_INIT_POINT';
    throw err;
  }

  return { id: String(response.body.id), checkoutUrl };
}

// ─────────────────────────────────────────────────────────────
// RENTAL
// ─────────────────────────────────────────────────────────────
async function handleRental(req, res) {
  const cfg = loadRentalConfig();
  if (!cfg.ok) {
    console.error('[payments/rental] Config ausente:', cfg.missing);
    return sendJson(res, 503, { ok: false, error: 'Pagamento indisponível.' });
  }

  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  let user;
  try {
    user = await getAuthUser(req);
  } catch (error) {
    console.error('[payments/rental] getAuthUser:', error.code || error.message);
    return sendJson(res, 502, { ok: false, error: 'Autenticação indisponível.' });
  }

  if (!user || !user.id) {
    return sendJson(res, 401, { ok: false, error: 'Faça login para continuar.' });
  }

  if (!user.email || !user.email_confirmed_at) {
    return sendJson(res, 403, { ok: false, error: 'Confirme seu e-mail antes de alugar.' });
  }

  const [userRate, ipRate] = await Promise.all([
    checkAndIncrement(`pay-rent:user:${user.id}`, MAX_ATTEMPTS_PER_USER, RATE_WINDOW_MS),
    checkAndIncrement(`pay-rent:ip:${ip}`, MAX_ATTEMPTS_PER_IP, RATE_WINDOW_MS)
  ]);

  if (userRate.limited || ipRate.limited) {
    const retryAfter = Math.max(userRate.retryAfter, ipRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await audit('payment_rental', { userId: user.id, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE });
  }

  const body = parseBody(req);
  const albumId = typeof body.albumId === 'string'
    ? body.albumId.trim().slice(0, MAX_ALBUM_ID_LENGTH)
    : '';
  const trackIndex = Number(body.trackIndex);

  if (
    !albumId ||
    !/^[A-Za-z0-9_-]+$/.test(albumId) ||
    !Number.isInteger(trackIndex) ||
    trackIndex < 0 ||
    trackIndex > MAX_TRACK_INDEX
  ) {
    await audit('payment_rental', { userId: user.id, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: 'Faixa inválida.' });
  }

  let track;
  try {
    track = await getTrackFromDB(albumId, trackIndex);
  } catch (error) {
    console.error('[payments/rental] getTrackFromDB:', error.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }

  if (!track) {
    return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
  }

  const priceCents = Number(track.price_cents);
  if (!Number.isInteger(priceCents) || priceCents <= 0 || priceCents > 1_000_000) {
    console.error('[payments/rental] preço inválido:', track.id, track.price_cents);
    return sendJson(res, 500, { ok: false, error: 'Preço indisponível.' });
  }

  const unitPrice = Number((priceCents / 100).toFixed(2));

  try {
    const activeRental = await getActiveRental(user.id, track.id);
    if (activeRental) {
      await audit('payment_rental', { userId: user.id, ip, userAgent, success: false, reason: 'already_rented' });
      return sendJson(res, 409, {
        ok: false,
        error: 'Você já possui acesso a esta faixa.',
        expiresAt: activeRental.expires_at
      });
    }
  } catch (error) {
    console.warn('[payments/rental] check active:', error.message);
  }

  try {
    const pending = await getPendingRentalAttempt(user.id, track.id);
    if (pending?.checkout_url) {
      const ageMs = Date.now() - new Date(pending.created_at).getTime();
      if (ageMs < REUSABLE_WINDOW_MS) {
        await audit('payment_rental', { userId: user.id, ip, userAgent, success: true, reason: 'reused_pending' });
        return sendJson(res, 200, {
          ok: true,
          checkoutUrl: pending.checkout_url,
          preferenceId: pending.preference_id,
          reused: true
        });
      }
    }
  } catch (error) {
    console.warn('[payments/rental] check pending:', error.message);
  }

  const externalRef = generateExternalRef('rnt');
  let attemptId = null;

  try {
    const insert = await supabaseAdminRequest('/rest/v1/payments_attempts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        kind: 'rental',
        plan: null,
        track_id: track.id,
        album_id: albumId,
        track_index: trackIndex,
        amount: unitPrice,
        currency: 'BRL',
        status: 'creating',
        external_reference: externalRef,
        ip,
        user_agent: userAgent ? userAgent.slice(0, 512) : null
      })
    });

    if (!insert.response.ok || !Array.isArray(insert.body) || !insert.body[0]) {
      return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
    }
    attemptId = insert.body[0].id;
  } catch (error) {
    console.error('[payments/rental] insert attempt:', error.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }

  let preference;
  try {
    preference = await createMercadoPagoPreference({
      cfg, user, track, albumId, trackIndex, unitPrice, externalRef
    });
  } catch (error) {
    await markAttemptFailed(attemptId, error.code || 'mp_error');
    await audit('payment_rental', { userId: user.id, ip, userAgent, success: false, reason: error.code || 'mp_error' });

    if (error.code === 'TIMEOUT') {
      return sendJson(res, 504, { ok: false, error: 'Tempo esgotado. Tente novamente.' });
    }
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }

  try {
    await supabaseAdminRequest(
      `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attemptId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending',
          preference_id: preference.id,
          checkout_url: preference.checkoutUrl,
          updated_at: new Date().toISOString()
        })
      }
    );
  } catch (error) {
    console.error('[payments/rental] PATCH attempt:', error.message);
  }

  await audit('payment_rental', { userId: user.id, ip, userAgent, success: true, reason: 'created' });

  return sendJson(res, 200, { ok: true, checkoutUrl: preference.checkoutUrl, preferenceId: preference.id });
}

function loadRentalConfig() {
  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  const backUrl = String(process.env.MP_BACK_URL || '').trim();
  const env = String(process.env.MP_ENV || 'production').trim();

  const missing = [];
  if (!token) missing.push('MP_ACCESS_TOKEN');
  if (!backUrl) missing.push('MP_BACK_URL');
  if (!backUrl.startsWith('https://')) missing.push('MP_BACK_URL(https)');

  if (missing.length) return { ok: false, missing };

  return {
    ok: true,
    token,
    backUrl,
    env,
    webhookUrl: process.env.MP_WEBHOOK_URL || null
  };
}

async function createMercadoPagoPreference({ cfg, user, track, albumId, trackIndex, unitPrice, externalRef }) {
  const body = {
    items: [{
      id: String(track.id),
      title: `Aluguel 48h: ${String(track.title || 'Faixa').slice(0, 200)}`,
      description: `Acesso por ${RENTAL_DURATION_HOURS}h`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: unitPrice
    }],
    payer: { email: user.email },
    external_reference: externalRef,
    back_urls: {
      success: cfg.backUrl,
      failure: cfg.backUrl,
      pending: cfg.backUrl
    },
    auto_return: 'approved',
    ...(cfg.webhookUrl ? { notification_url: cfg.webhookUrl } : {}),
    metadata: {
      kind: 'rental',
      album_id: albumId,
      track_index: trackIndex
    }
  };

  const response = await fetchMP(`${MP_API_URL}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': externalRef
    },
    body: JSON.stringify(body)
  });

  if (!response.ok || !response.body || !response.body.id) {
    const reason = response.body?.message || response.body?.error || `http_${response.status}`;
    const err = new Error('MP error: ' + reason);
    err.code = 'MP_ERROR';
    throw err;
  }

  const checkoutUrl = cfg.env === 'sandbox'
    ? response.body.sandbox_init_point || response.body.init_point
    : response.body.init_point;

  if (!checkoutUrl) {
    const err = new Error('MP sem init_point');
    err.code = 'MP_NO_INIT_POINT';
    throw err;
  }

  return { id: String(response.body.id), checkoutUrl };
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ------------------------------------------------------------
// Fluxo:
//   1. Valida assinatura HMAC
//   2. Insere evento em payments_events (idempotência)
//   3. Se duplicado:
//       - se processed_at preenchido → ignora
//       - se NÃO processado → REPROCESSA (retry_count até 10)
//   4. Processa (preapproval ou payment)
//   5. Marca processed_at
// ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const sig = validateMPSignature(req);
  if (!sig.ok) {
    console.warn('[payments/webhook] Assinatura inválida:', sig.reason);
    await audit('payment_webhook', { success: false, reason: 'invalid_signature' });
    return sendJson(res, 401, { ok: false, error: 'Assinatura inválida.' });
  }

  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.error('[payments/webhook] MP_ACCESS_TOKEN ausente.');
    return sendJson(res, 503, { ok: false, error: 'Pagamento não configurado.' });
  }

  const event = extractEvent(req);
  if (!event) {
    await audit('payment_webhook', { success: false, reason: 'malformed_event' });
    return sendJson(res, 200, { ok: true, ignored: 'malformed' });
  }

  const { type, resourceId } = event;
  const providerEvent = `${type}:${resourceId}`;

  let eventRow = null;
  try {
    const inserted = await supabaseAdminRequest('/rest/v1/payments_events', {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
      body: JSON.stringify({
        provider: 'mercadopago',
        provider_event: providerEvent,
        event_type: type,
        external_id: resourceId,
        payload: sanitizeForLog(req.body)
      })
    });

    if (!inserted.response.ok) {
      return sendJson(res, 502, { ok: false });
    }

    // ── Evento já existia (duplicata do MP)
    // Verificar se foi REALMENTE processado.
    // Se não, reprocessar (evita perder pagamento em queda no meio).
    if (!Array.isArray(inserted.body) || inserted.body.length === 0) {
      let existing = null;
      try {
        const check = await supabaseAdminRequest(
          `/rest/v1/payments_events?provider=eq.mercadopago` +
            `&provider_event=eq.${encodeURIComponent(providerEvent)}` +
            `&select=id,processed_at,failure_reason,retry_count` +
            `&limit=1`,
          { method: 'GET' }
        );
        existing = Array.isArray(check.body) ? check.body[0] : null;
      } catch (err) {
        console.error('[payments/webhook] check duplicate:', err.message);
        return sendJson(res, 502, { ok: false });
      }

      if (existing && existing.processed_at) {
        // Já processado com sucesso — não reprocessar
        await audit('payment_webhook', {
          success: true,
          reason: 'duplicated_processed',
          externalId: resourceId
        });
        return sendJson(res, 200, { ok: true, duplicated: true });
      }

      if (existing && !existing.processed_at) {
        // Existe mas NÃO foi processado → reprocessar
        const retryCount = Number(existing.retry_count) || 0;
        if (retryCount >= MAX_RETRY_COUNT) {
          console.error('[payments/webhook] retry limit atingido:', providerEvent);
          await audit('payment_webhook', {
            success: false,
            reason: 'retry_limit',
            externalId: resourceId
          });
          return sendJson(res, 200, { ok: true, ignored: 'retry_limit' });
        }

        // Incrementa contador de retry
        await supabaseAdminRequest(
          `/rest/v1/payments_events?id=eq.${encodeURIComponent(existing.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ retry_count: retryCount + 1 })
          }
        ).catch(() => {});

        eventRow = existing;
        console.warn(
          '[payments/webhook] reprocessando evento não processado:',
          providerEvent,
          'retry:',
          retryCount + 1
        );
        // segue o fluxo normal (não retorna)
      } else {
        // Não encontrado (corrida) — fail-safe
        console.error('[payments/webhook] evento duplicado sem registro:', providerEvent);
        return sendJson(res, 502, { ok: false });
      }
    } else {
      eventRow = inserted.body[0];
    }
  } catch (error) {
    console.error('[payments/webhook] insert event:', error.message);
    return sendJson(res, 502, { ok: false });
  }

  try {
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      await applyPreapproval({ resourceId, token });
    } else if (type === 'payment') {
      await applyPayment({ resourceId, token });
    } else {
      await markEventProcessed(eventRow.id);
      return sendJson(res, 200, { ok: true, ignored: `type:${type}` });
    }

    await markEventProcessed(eventRow.id);
    await audit('payment_webhook', { success: true, reason: 'processed', externalId: resourceId, eventType: type });
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    await markEventFailed(eventRow.id, error.code || error.message);
    await audit('payment_webhook', { success: false, reason: error.code || 'error', externalId: resourceId, eventType: type });

    if (error.code === 'TIMEOUT') {
      res.setHeader('Retry-After', '30');
      return sendJson(res, 504, { ok: false });
    }
    if (error.code === 'MP_5XX') {
      res.setHeader('Retry-After', '60');
      return sendJson(res, 502, { ok: false });
    }

    return sendJson(res, 200, { ok: true, ignored: 'business_error' });
  }
}

async function applyPreapproval({ resourceId, token }) {
  const preapproval = await fetchMP(`${MP_API_URL}/preapproval/${encodeURIComponent(resourceId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!preapproval.ok) {
    if (preapproval.status === 404) return;
    throw Object.assign(new Error('mp_error'), { code: 'MP_ERROR' });
  }

  const data = preapproval.body;
  if (!data || !data.id) return;

  const ref = parseRef(data.external_reference);
  if (!ref || ref.kind !== 'subscription') {
    console.warn('[payments/webhook] ref inválida (preapproval):', data.external_reference);
    return;
  }

  const attempt = await getAttemptByRef(ref.ref);
  if (!attempt || attempt.kind !== 'subscription') return;

  const plan = attempt.plan;
  if (plan !== 'premium' && plan !== 'anual') return;

  const mpStatus = String(data.status || '').toLowerCase();
  const isActive = mpStatus === 'authorized';

  const row = {
    user_id: attempt.user_id,
    plan,
    status: normalizePreapprovalStatus(mpStatus),
    provider: 'mercadopago',
    provider_sub_id: String(data.id),
    external_reference: ref.ref,
    current_period_end: data.next_payment_date || null,
    started_at: data.date_created || null,
    canceled_at: mpStatus === 'cancelled' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  const upsert = await supabaseAdminRequest(
    '/rest/v1/subscriptions?on_conflict=provider,provider_sub_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row)
    }
  );

  if (!upsert.response.ok) {
    throw Object.assign(new Error('upsert_failed'), { code: 'DB_ERROR' });
  }

  if (isActive) {
    await supabaseAdminRequest(
      `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attempt.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'completed', updated_at: new Date().toISOString() })
      }
    ).catch(() => {});
  }
}

function normalizePreapprovalStatus(mpStatus) {
  if (mpStatus === 'authorized') return 'authorized';
  if (mpStatus === 'cancelled') return 'canceled';
  if (mpStatus === 'paused') return 'paused';
  return 'pending';
}

async function applyPayment({ resourceId, token }) {
  const payment = await fetchMP(`${MP_API_URL}/v1/payments/${encodeURIComponent(resourceId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!payment.ok) {
    if (payment.status === 404) return;
    throw Object.assign(new Error('mp_error'), { code: 'MP_ERROR' });
  }

  const data = payment.body;
  if (!data || !data.id) return;

  const ref = parseRef(data.external_reference);
  if (!ref || ref.kind !== 'rental') return;

  const attempt = await getAttemptByRef(ref.ref);
  if (!attempt || attempt.kind !== 'rental' || !attempt.track_id) return;

  const status = String(data.status || '').toLowerCase();

  if (status !== 'approved') {
    if (status === 'rejected' || status === 'cancelled') {
      await supabaseAdminRequest(
        `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attempt.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: status === 'rejected' ? 'failed' : 'expired',
            failure_reason: `mp_${status}`,
            updated_at: new Date().toISOString()
          })
        }
      ).catch(() => {});
    }
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + RENTAL_DURATION_HOURS * 3600 * 1000);

  const insert = await supabaseAdminRequest(
    '/rest/v1/rentals?on_conflict=user_id,track_id,payment_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        user_id: attempt.user_id,
        track_id: attempt.track_id,
        payment_id: String(data.id),
        external_reference: ref.ref,
        amount_cents: Math.round(Number(data.transaction_amount) * 100),
        status: 'active',
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString()
      })
    }
  );

  if (!insert.response.ok) {
    throw Object.assign(new Error('rental_insert_failed'), { code: 'DB_ERROR' });
  }

  await supabaseAdminRequest(
    `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attempt.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'completed', updated_at: new Date().toISOString() })
    }
  ).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Banco — helpers
// ─────────────────────────────────────────────────────────────
async function getActiveSubscription(userId) {
  const r = await supabaseAdminRequest(
    `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=in.(authorized,trialing)&select=id,plan,status,current_period_end&limit=1`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function getPendingSubscriptionAttempt(userId, plan) {
  const r = await supabaseAdminRequest(
    `/rest/v1/payments_attempts?user_id=eq.${encodeURIComponent(userId)}&plan=eq.${plan}&kind=eq.subscription&status=eq.pending&order=created_at.desc&limit=1&select=id,preapproval_id,checkout_url,created_at`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function getPendingRentalAttempt(userId, trackId) {
  const r = await supabaseAdminRequest(
    `/rest/v1/payments_attempts?user_id=eq.${encodeURIComponent(userId)}&track_id=eq.${trackId}&kind=eq.rental&status=eq.pending&order=created_at.desc&limit=1&select=id,preference_id,checkout_url,created_at`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function getTrackFromDB(albumId, trackIndex) {
  const r = await supabaseAdminRequest(
    `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}&track_index=eq.${trackIndex}&published=eq.true&select=id,title,price_cents,album_id,track_index&limit=1`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function getActiveRental(userId, trackId) {
  const nowIso = new Date().toISOString();
  const r = await supabaseAdminRequest(
    `/rest/v1/rentals?user_id=eq.${encodeURIComponent(userId)}&track_id=eq.${encodeURIComponent(trackId)}&expires_at=gt.${encodeURIComponent(nowIso)}&select=id,expires_at&order=expires_at.desc&limit=1`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function getAttemptByRef(externalRef) {
  if (!externalRef || typeof externalRef !== 'string') return null;
  const r = await supabaseAdminRequest(
    `/rest/v1/payments_attempts?external_reference=eq.${encodeURIComponent(externalRef)}&select=id,user_id,kind,plan,track_id,status&limit=1`,
    { method: 'GET' }
  );
  if (!r.response.ok || !Array.isArray(r.body)) return null;
  return r.body[0] || null;
}

async function markAttemptFailed(attemptId, reason) {
  if (!attemptId) return;
  try {
    await supabaseAdminRequest(
      `/rest/v1/payments_attempts?id=eq.${encodeURIComponent(attemptId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          failure_reason: String(reason).slice(0, 200),
          updated_at: new Date().toISOString()
        })
      }
    );
  } catch {}
}

async function markEventProcessed(eventId) {
  if (!eventId) return;
  await supabaseAdminRequest(
    `/rest/v1/payments_events?id=eq.${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ processed_at: new Date().toISOString() })
    }
  ).catch(() => {});
}

async function markEventFailed(eventId, reason) {
  if (!eventId) return;
  await supabaseAdminRequest(
    `/rest/v1/payments_events?id=eq.${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ failure_reason: String(reason || '').slice(0, 200) })
    }
  ).catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// Mercado Pago — fetch
// ─────────────────────────────────────────────────────────────
async function fetchMP(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MP_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    const text = await response.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('mp_timeout'), { code: 'TIMEOUT' });
    }
    throw Object.assign(new Error('mp_network'), { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────
// Webhook — validação HMAC
// ─────────────────────────────────────────────────────────────
function validateMPSignature(req) {
  const secret = String(process.env.MP_WEBHOOK_SECRET || '').trim();
  if (!secret) return { ok: false, reason: 'secret_missing' };

  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  const dataId = extractQueryDataId(req);

  if (!signature || !requestId || !dataId) return { ok: false, reason: 'headers_missing' };

  const parts = String(signature).split(',');
  const tsPart = parts.find((p) => p.startsWith('ts='));
  const v1Part = parts.find((p) => p.startsWith('v1='));
  if (!tsPart || !v1Part) return { ok: false, reason: 'signature_malformed' };

  const ts = tsPart.slice(3);
  const v1 = v1Part.slice(3);

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'ts_invalid' };
  const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1000;
  if (Math.abs(Date.now() - tsMs) > SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: 'ts_expired' };
  }

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(v1, 'hex');

  if (expectedBuf.length !== providedBuf.length) return { ok: false, reason: 'signature_length' };

  try {
    const equal = crypto.timingSafeEqual(expectedBuf, providedBuf);
    return equal ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
  } catch {
    return { ok: false, reason: 'signature_compare_error' };
  }
}

function extractQueryDataId(req) {
  const q = req.query || {};
  const v = q['data.id'];
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function extractEvent(req) {
  const body = parseBody(req);
  const q = req.query || {};

  let type = String(body.type || body.action || '').trim().toLowerCase();
  if (!type) return null;
  if (type.startsWith('payment.')) type = 'payment';

  const rawId = (body.data && body.data.id) || body.id || q['data.id'];
  if (rawId === undefined || rawId === null) return null;

  const resourceId = String(rawId).trim();
  if (!resourceId) return null;

  const knownTypes = new Set(['payment', 'subscription_preapproval', 'preapproval']);
  if (!knownTypes.has(type)) return null;

  return { type, resourceId };
}

// ─────────────────────────────────────────────────────────────
// Ref opaca
// ─────────────────────────────────────────────────────────────
function parseRef(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.startsWith('chk_')) return { ref: raw, kind: 'subscription' };
  if (raw.startsWith('rnt_')) return { ref: raw, kind: 'rental' };
  return null;
}

// ─────────────────────────────────────────────────────────────
// Helpers gerais
// ─────────────────────────────────────────────────────────────
function parseType(query) {
  if (!query) return null;
  const raw = String(query.type || '').trim().toLowerCase();
  if (!['subscription', 'rental', 'webhook'].includes(raw)) return null;
  return raw;
}

function generateExternalRef(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function parsePrice(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sanitizeForLog(body) {
  try {
    const clone = JSON.parse(JSON.stringify(body || {}));
    if (clone.payer) {
      if (clone.payer.email) clone.payer.email = maskEmail(clone.payer.email);
      delete clone.payer.identification;
    }
    return clone;
  } catch {
    return { _unserializable: true };
  }
}

function maskEmail(email) {
  const s = String(email);
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return s[0] + '***' + s.slice(at);
}
