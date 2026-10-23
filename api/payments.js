'use strict';

/* ============================================================
   API: /api/payments — Mercado Pago
   Contrato (compatível com js/site.js):
     POST ?type=rental        { albumId, trackIndex, planId, kind }
     POST ?type=subscription  { plan }
     GET  ?type=manage        → { ok, subscription|null }
     POST ?type=manage        { action: 'cancel' }
     POST ?type=webhook       (MP envia; GET p/ debug)
   Aliases: ?action=rent|subscribe|manage|webhook
   ⚠️  Nenhum pedido é marcado PAID sem confirmação do MP.
   ============================================================ */

const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const { eq, and, gt, desc } = require('drizzle-orm');
const { db } = require('./_db');
const {
  plans,
  rentalProducts,
  orders,
  orderItems,
  rentals,
  subscriptions,
  paymentsEvents,
  tracks,
} = require('../src/schema.js');
const { getAuthUser } = require('./_lib');
const { invalidateAccessCache } = require('./_cache');
const { sendRentalConfirmation, sendSubscriptionConfirmation } = require('./_email');

const MP_API = 'https://api.mercadopago.com';
const ACCESS_TOKEN = () => String(process.env.MP_ACCESS_TOKEN || '').trim();
const WEBHOOK_SECRET = () => String(process.env.MP_WEBHOOK_SECRET || '').trim();
const APP_URL = () =>
  String(process.env.APP_URL || process.env.PUBLIC_SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');

function mpHeaders(extra = {}) {
  const token = ACCESS_TOKEN();
  if (!token) {
    const err = new Error('MP_ACCESS_TOKEN não configurado.');
    err.code = 'MP_NOT_CONFIGURED';
    throw err;
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function mpFetch(path, options = {}) {
  const res = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: mpHeaders(options.headers),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`MP ${path} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK: valida x-signature do MP
// ─────────────────────────────────────────────────────────────
function verifyWebhookSignature(req) {
  const secret = WEBHOOK_SECRET();
  if (!secret) return false;

  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  if (!signature) return false;

  const parts = Object.fromEntries(
    signature.split(',').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  if (!parts.ts || !parts.v1) return false;

  const dataId = String(
    (req.query && req.query['data.id']) ||
    (req.body && req.body.data && req.body.data.id) ||
    ''
  );
  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─────────────────────────────────────────────────────────────
// HELPERS DE PEDIDO
// ─────────────────────────────────────────────────────────────
async function createPendingOrder({ userId, totalCents, currency, idempotencyKey }) {
  const id = randomUUID();
  const [row] = await db.insert(orders).values({
    id,
    userId,
    status: 'PENDING',
    totalCents,
    currency,
    idempotencyKey: idempotencyKey || null,
  }).returning();
  return row;
}

async function markOrderPaid(orderId, externalPaymentId) {
  const now = new Date().toISOString();
  await db.update(orders)
    .set({ status: 'PAID', paidAt: now, externalPaymentId })
    .where(eq(orders.id, orderId));
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: rental
// ─────────────────────────────────────────────────────────────
async function handleRental(req, res, user) {
  const body = req.body || {};
  const planId = body.planId;
  const albumId = body.albumId || null;
  const trackIndex = body.trackIndex ?? null;

  if (!planId) return res.status(400).json({ ok: false, error: 'planId obrigatório' });

  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan || !plan.active) {
    return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
  }

  let trackId = null;
  if (albumId && trackIndex != null) {
    const [t] = await db.select({ id: tracks.id }).from(tracks)
      .where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex)))
      .limit(1);
    if (t) trackId = t.id;
  }

  const [product] = await db.select().from(rentalProducts)
    .where(and(
      eq(rentalProducts.active, true),
      trackId ? eq(rentalProducts.trackId, trackId) : eq(rentalProducts.albumId, albumId)
    ))
    .limit(1);

  if (!product) {
    return res.status(404).json({
      ok: false,
      error: 'Produto de aluguel não encontrado para este item',
    });
  }

  const now = new Date();
  const conds = [
    eq(rentals.userId, user.id),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, now.toISOString()),
  ];
  if (product.trackId) conds.push(eq(rentals.trackId, product.trackId));
  if (product.albumId) conds.push(eq(rentals.albumId, product.albumId));
  const [existing] = await db.select().from(rentals).where(and(...conds)).limit(1);
  if (existing) {
    return res.status(409).json({
      ok: false,
      error: 'Você já tem um aluguel ativo deste item',
      expiresAt: existing.expiresAt,
    });
  }

  const order = await createPendingOrder({
    userId: user.id,
    totalCents: product.priceCents,
    currency: product.currency || 'BRL',
    idempotencyKey: `rental:${user.id}:${product.id}:${Math.floor(Date.now() / 60000)}`,
  });

  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId: order.id,
    productType: 'RENTAL',
    productId: product.id,
    quantity: 1,
    unitPriceCents: product.priceCents,
  });

  const base = APP_URL();
  if (!base) {
    return res.status(500).json({ ok: false, error: 'APP_URL não configurada no servidor' });
  }

  let preference;
  try {
    preference = await mpFetch('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        external_reference: order.id,
        items: [{
          id: product.id,
          title: product.name,
          description: trackId ? 'Aluguel de faixa' : 'Aluguel de álbum',
          quantity: 1,
          currency_id: product.currency || 'BRL',
          unit_price: product.priceCents / 100,
        }],
        payer: { email: user.email },
        back_urls: {
          success: `${base}/?payment=success&order=${order.id}`,
          failure: `${base}/?payment=failure&order=${order.id}`,
          pending: `${base}/?payment=pending&order=${order.id}`,
        },
        auto_return: 'approved',
        notification_url: `${base}/api/payments?type=webhook`,
        metadata: {
          order_id: order.id,
          user_id: user.id,
          kind: trackId ? 'track' : 'album',
          product_id: product.id,
        },
      }),
    });
  } catch (err) {
    console.error('[payments][rental] MP preference falhou:', err.status, err.body);
    return res.status(502).json({ ok: false, error: 'Gateway indisponível. Tente novamente.' });
  }

  await db.update(orders)
    .set({ externalPaymentId: String(preference.id) })
    .where(eq(orders.id, order.id));

  return res.status(200).json({
    ok: true,
    checkoutUrl: preference.init_point || preference.sandbox_init_point,
    orderId: order.id,
  });
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: subscription
// ─────────────────────────────────────────────────────────────
async function handleSubscription(req, res, user) {
  const body = req.body || {};
  const planId = body.plan || body.planId;
  if (!planId) return res.status(400).json({ ok: false, error: 'plan obrigatório' });

  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan || !plan.active) {
    return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
  }

  const [active] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.userId, user.id), eq(subscriptions.status, 'ACTIVE')))
    .limit(1);
  if (active) {
    return res.status(409).json({
      ok: false,
      error: 'Você já tem uma assinatura ativa',
      subscriptionId: active.id,
    });
  }

  const order = await createPendingOrder({
    userId: user.id,
    totalCents: plan.priceCents,
    currency: plan.currency || 'BRL',
    idempotencyKey: `sub:${user.id}:${plan.id}:${Math.floor(Date.now() / 60000)}`,
  });

  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId: order.id,
    productType: 'SUBSCRIPTION',
    productId: plan.id,
    quantity: 1,
    unitPriceCents: plan.priceCents,
  });

  const [sub] = await db.insert(subscriptions).values({
    id: randomUUID(),
    userId: user.id,
    planId: plan.id,
    status: 'PENDING',
    initPoint: null,
    payerEmail: user.email,
  }).returning();

  const base = APP_URL();
  if (!base) {
    return res.status(500).json({ ok: false, error: 'APP_URL não configurada no servidor' });
  }

  let preapproval;
  try {
    preapproval = await mpFetch('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `Assinatura ${plan.name}`,
        external_reference: sub.id,
        payer_email: user.email,
        back_url: `${base}/?subscription=success&sub=${sub.id}`,
        auto_recurring: {
          frequency: plan.intervalCount,
          frequency_type: plan.intervalUnit === 'YEAR' ? 'years'
                        : plan.intervalUnit === 'MONTH' ? 'months'
                        : 'days',
          transaction_amount: plan.priceCents / 100,
          currency_id: plan.currency || 'BRL',
        },
        status: 'pending',
      }),
    });
  } catch (err) {
    console.error('[payments][subscription] MP preapproval falhou:', err.status, err.body);
    return res.status(502).json({ ok: false, error: 'Gateway indisponível. Tente novamente.' });
  }

  await db.update(subscriptions)
    .set({ initPoint: preapproval.init_point, externalSubscriptionId: String(preapproval.id) })
    .where(eq(subscriptions.id, sub.id));

  return res.status(200).json({
    ok: true,
    checkoutUrl: preapproval.init_point,
    subscriptionId: sub.id,
  });
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: manage (GET lista / POST cancelar)
// ─────────────────────────────────────────────────────────────
async function handleManage(req, res, user) {
  if (req.method === 'GET') {
    const [sub] = await db.select().from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) return res.status(200).json({ ok: true, subscription: null });

    const [plan] = await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1);
    return res.status(200).json({
      ok: true,
      subscription: {
        id: sub.id,
        plan: plan ? plan.name : null,
        status: sub.status === 'ACTIVE' ? 'authorized'
              : sub.status === 'PENDING' ? 'pending'
              : sub.status === 'CANCELLED' ? 'canceled'
              : sub.status.toLowerCase(),
        startedAt: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        canceledAt: sub.status === 'CANCELLED' ? sub.updatedAt : null,
      },
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    if (body.action !== 'cancel') {
      return res.status(400).json({ ok: false, error: 'Ação inválida' });
    }
    const [sub] = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.userId, user.id), eq(subscriptions.status, 'ACTIVE')))
      .limit(1);
    if (!sub) return res.status(404).json({ ok: false, error: 'Nenhuma assinatura ativa' });

    if (sub.externalSubscriptionId && ACCESS_TOKEN()) {
      try {
        await mpFetch(`/preapproval/${encodeURIComponent(sub.externalSubscriptionId)}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'cancelled' }),
        });
      } catch (err) {
        console.warn('[payments][manage] MP cancel falhou, cancelando só localmente:', err.status);
      }
    }

    await db.update(subscriptions)
      .set({ status: 'CANCELLED', updatedAt: new Date().toISOString() })
      .where(eq(subscriptions.id, sub.id));

    await invalidateAccessCache(user.id);
    return res.status(200).json({ ok: true, message: 'Assinatura cancelada.' });
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' });
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true });

  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ ok: false, error: 'Assinatura inválida' });
  }

  const event = req.body || {};
  const type = String(event.type || event.topic || '');
  const dataId = String((event.data && event.data.id) || '');
  if (!type || !dataId) return res.status(400).json({ ok: false, error: 'Payload inválido' });

  // Idempotência: unique(provider, providerEvent)
  const [existing] = await db.select().from(paymentsEvents)
    .where(eq(paymentsEvents.providerEvent, `${type}:${dataId}`))
    .limit(1);
  if (existing) return res.status(200).json({ ok: true, duplicated: true });

  const [eventRow] = await db.insert(paymentsEvents).values({
    provider: 'mercadopago',
    providerEvent: `${type}:${dataId}`,
    eventType: type,
    externalId: dataId,
    payload: event,
  }).returning();

  try {
    if (type === 'payment') {
      const pay = await mpFetch(`/v1/payments/${encodeURIComponent(dataId)}`);
      const status = pay.status;
      const orderId = pay.external_reference;
      if (orderId && status === 'approved') {
        await markOrderPaid(orderId, String(pay.id));

        const [item] = await db.select().from(orderItems)
          .where(eq(orderItems.orderId, orderId)).limit(1);
        if (item && item.productType === 'RENTAL') {
          const [prod] = await db.select().from(rentalProducts)
            .where(eq(rentalProducts.id, item.productId)).limit(1);
          if (prod) {
            const now = new Date();
            const expires = new Date(now.getTime() + (prod.durationHours || 24) * 3600 * 1000);
            const [ord] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
            await db.insert(rentals).values({
              id: randomUUID(),
              rentalCode: `RENT-${randomUUID().slice(0, 8).toUpperCase()}`,
              userId: ord.userId,
              trackId: prod.trackId,
              albumId: prod.albumId,
              orderId,
              status: 'ACTIVE',
              startsAt: now.toISOString(),
              expiresAt: expires.toISOString(),
            });
            await invalidateAccessCache(ord.userId);
          }
        }
      }
    } else if (type === 'subscription_preapproval' || type === 'preapproval') {
      const pre = await mpFetch(`/preapproval/${encodeURIComponent(dataId)}`);
      const subId = pre.external_reference;
      if (subId) {
        if (pre.status === 'authorized') {
          const now = new Date();
          const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1);
          const [plan] = sub ? await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1) : [];
          const end = new Date(now);
          if (plan && plan.intervalUnit === 'MONTH') end.setMonth(end.getMonth() + plan.intervalCount);
          else if (plan && plan.intervalUnit === 'YEAR') end.setFullYear(end.getFullYear() + plan.intervalCount);
          else end.setDate(end.getDate() + (plan ? plan.intervalCount : 30));

          await db.update(subscriptions).set({
            status: 'ACTIVE',
            currentPeriodStart: now.toISOString(),
            currentPeriodEnd: end.toISOString(),
            updatedAt: now.toISOString(),
          }).where(eq(subscriptions.id, subId));
          await invalidateAccessCache(sub.userId);
        } else if (pre.status === 'cancelled') {
          await db.update(subscriptions).set({
            status: 'CANCELLED',
            updatedAt: new Date().toISOString(),
          }).where(eq(subscriptions.id, subId));
        }
      }
    }

    await db.update(paymentsEvents)
      .set({ processedAt: new Date().toISOString() })
      .where(eq(paymentsEvents.id, eventRow.id));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[payments][webhook] erro:', err.message, err.body || '');
    await db.update(paymentsEvents)
      .set({ failureReason: err.message })
      .where(eq(paymentsEvents.id, eventRow.id));
    return res.status(500).json({ ok: false });
  }
}

// ─────────────────────────────────────────────────────────────
// ROTEADOR (Versão Final Corrigida)
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const allowedOrigin = APP_URL();

  // CORS Seguro: Só envia credenciais se a origem for exata
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // Fallback seguro: sem credenciais se não houver APP_URL
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-signature, x-request-id');
  
  if (req.method === 'OPTIONS') return res.status(204).end();

  const type = String(req.query.type || '');
  const action = String(req.query.action || '');
  const op = type || action;

  if (op === 'webhook') return handleWebhook(req, res);

  let user = null;
  try { user = await getAuthUser(req); } catch (e) { user = null; }
  if (!user) return res.status(401).json({ ok: false, error: 'Não autenticado' });

  try {
    if (op === 'rental' || op === 'rent') return await handleRental(req, res, user);
    if (op === 'subscription' || op === 'subscribe') return await handleSubscription(req, res, user);
    if (op === 'manage') return await handleManage(req, res, user);
    return res.status(400).json({ ok: false, error: 'Ação inválida' });
  } catch (err) {
    console.error('[payments] erro:', err.message);
    return res.status(500).json({ ok: false, error: 'Erro interno' });
  }
};