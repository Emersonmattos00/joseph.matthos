'use strict';

/* ============================================================
   API: /api/payments — Mercado Pago
   Contrato:
     POST ?type=rental        { albumId, trackIndex, planId, kind, idempotencyKey? }
     POST ?type=subscription  { plan, idempotencyKey? }
     GET  ?type=manage
     POST ?type=manage        { action: 'cancel' }
     POST ?type=webhook
   Aliases: ?action=rent|subscribe|manage|webhook
   ============================================================ */

const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const { eq, and, gt, desc, isNull, lt, or, sql } = require('drizzle-orm');
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
  users,
} = require('../src/schema.js');
const { getAuthUser, checkOrigin } = require('./_lib');
const { invalidateAccessCache } = require('./_cache');
const {
  sendRentalConfirmation,
  sendSubscriptionConfirmation,
} = require('./_email');

const MP_API = 'https://api.mercadopago.com';
const ACCESS_TOKEN = () => String(process.env.MP_ACCESS_TOKEN || '').trim();
const WEBHOOK_SECRET = () => String(process.env.MP_WEBHOOK_SECRET || '').trim();
const APP_URL = () =>
  String(process.env.APP_URL || process.env.PUBLIC_SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');

const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

// Converte os intervalos cadastrados em plans para as unidades
// aceitas pela API de assinaturas do Mercado Pago: days ou months.
function getRecurringInterval(plan) {
  const unit = String(plan?.intervalUnit || '').trim().toLowerCase();
  const count = Number(plan?.intervalCount);

  if (!Number.isSafeInteger(count) || count < 1 || count > 120) {
    const err = new Error('Periodicidade do plano inválida.');
    err.status = 400;
    throw err;
  }

  if (['day', 'days', 'dia', 'dias'].includes(unit)) {
    return { frequency: count, frequencyType: 'days', unit: 'day', count };
  }
  if (['week', 'weeks', 'semana', 'semanas'].includes(unit)) {
    return { frequency: count * 7, frequencyType: 'days', unit: 'day', count: count * 7 };
  }
  if (['month', 'months', 'mes', 'meses'].includes(unit)) {
    return { frequency: count, frequencyType: 'months', unit: 'month', count };
  }
  if (['year', 'years', 'ano', 'anos'].includes(unit)) {
    return { frequency: count * 12, frequencyType: 'months', unit: 'month', count: count * 12 };
  }

  const err = new Error('Unidade de recorrência do plano não suportada.');
  err.status = 400;
  throw err;
}

function addRecurringPeriod(startValue, plan) {
  const start = new Date(startValue);
  if (!Number.isFinite(start.getTime())) throw new Error('DATA_INICIAL_INVALIDA');

  const interval = getRecurringInterval(plan);
  const end = new Date(start);

  if (interval.unit === 'day') {
    end.setUTCDate(end.getUTCDate() + interval.count);
  } else {
    const originalDay = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + interval.count);
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(originalDay, lastDay));
  }
  return end;
}

// ─────────────────────────────────────────────────────────────
// MP HELPERS
// ─────────────────────────────────────────────────────────────
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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`MP ${path} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK: valida x-signature do Mercado Pago
// ─────────────────────────────────────────────────────────────
function verifyWebhookSignature(req) {
  const secret = WEBHOOK_SECRET();
  if (!secret) return false;

  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '').trim();
  if (!signature || !requestId) return false;

  const parts = Object.fromEntries(
    signature.split(',').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    })
  );

  if (!parts.ts || !parts.v1) return false;
  if (!/^\d+$/.test(parts.ts)) return false;
  if (!/^[a-f0-9]{64}$/i.test(parts.v1)) return false;

  const ts = Number(parts.ts);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > WEBHOOK_MAX_AGE_MS) return false;

  const dataId = String(
    (req.query && req.query['data.id']) ||
    (req.body && req.body.data && req.body.data.id) ||
    ''
  );
  if (!dataId) return false;

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
async function findOrderByIdempotencyKey(userId, key) {
  if (!userId || !key) return null;
  const [row] = await db.select().from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, key)))
    .limit(1);
  return row || null;
}

function scopedIdempotencyKey(userId, rawKey, scope) {
  const raw = rawKey == null ? '' : String(rawKey).trim();
  if (raw && (raw.length < 8 || raw.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(raw))) {
    const err = new Error('Chave de idempotência inválida.');
    err.status = 400;
    throw err;
  }
  return `${scope}:${userId}:${raw || randomUUID()}`;
}

async function createPendingOrderTx(tx, values) {
  const id = randomUUID();
  const [row] = await tx.insert(orders).values({
    id,
    userId: values.userId,
    status: 'PENDING',
    totalCents: values.totalCents,
    currency: values.currency,
    idempotencyKey: values.idempotencyKey,
  }).onConflictDoNothing({ target: orders.idempotencyKey }).returning();

  if (!row) {
    const err = new Error('Já existe uma tentativa de checkout com esta chave.');
    err.status = 409;
    err.code = 'IDEMPOTENCY_CONFLICT';
    throw err;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: RENTAL
// ─────────────────────────────────────────────────────────────
async function handleRental(req, res, user) {
  const body = req.body || {};
  const productId = String(body.planId || '').trim();
  const albumId = body.albumId ? String(body.albumId).trim() : null;
  const trackIndex = body.trackIndex ?? null;
  const kind = String(body.kind || '').trim().toLowerCase();
  const clientKey = body.idempotencyKey || null;
  const idempotencyKey = scopedIdempotencyKey(user.id, clientKey, 'rental');

  const isUuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

  if (!isUuid(productId)) {
    return res.status(400).json({ ok: false, error: 'Produto de aluguel inválido.' });
  }
  if (!isUuid(albumId)) {
    return res.status(400).json({ ok: false, error: 'Álbum inválido.' });
  }
  if (!['track', 'album'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'Tipo de aluguel inválido.' });
  }
  if (kind === 'track' && (!Number.isSafeInteger(Number(trackIndex)) || Number(trackIndex) < 1)) {
    return res.status(400).json({ ok: false, error: 'Número da faixa inválido.' });
  }
  if (kind === 'album' && trackIndex != null) {
    return res.status(400).json({ ok: false, error: 'Aluguel de álbum não pode conter faixa.' });
  }

  const base = APP_URL();
  if (!base) {
    return res.status(500).json({ ok: false, error: 'APP_URL não configurada no servidor' });
  }

  let trackId = null;
  if (kind === 'track') {
    const [track] = await db.select({ id: tracks.id }).from(tracks)
      .where(and(
        eq(tracks.albumId, albumId),
        eq(tracks.trackNumber, Number(trackIndex))
      ))
      .limit(1);

    if (!track) {
      return res.status(404).json({ ok: false, error: 'Faixa não encontrada neste álbum.' });
    }
    trackId = track.id;
  }

  // O frontend envia rental_products.id em planId.
  // O ID escolhido é respeitado; não selecionamos outro produto por aproximação.
  const targetCondition = kind === 'track'
    ? and(eq(rentalProducts.trackId, trackId), isNull(rentalProducts.albumId))
    : and(eq(rentalProducts.albumId, albumId), isNull(rentalProducts.trackId));

  const [product] = await db.select().from(rentalProducts)
    .where(and(
      eq(rentalProducts.id, productId),
      eq(rentalProducts.active, true),
      targetCondition
    ))
    .limit(1);

  if (!product) {
    return res.status(404).json({
      ok: false,
      error: 'O período selecionado não está disponível para este item.',
    });
  }

  if (!Number.isSafeInteger(Number(product.priceCents)) || Number(product.priceCents) <= 0 ||
      !Number.isSafeInteger(Number(product.durationHours)) || Number(product.durationHours) <= 0) {
    return res.status(400).json({ ok: false, error: 'Preço ou duração do aluguel inválido.' });
  }

  const existingOrder = await findOrderByIdempotencyKey(user.id, idempotencyKey);

  if (existingOrder) {
    const [existingItem] = await db.select().from(orderItems)
      .where(eq(orderItems.orderId, existingOrder.id)).limit(1);

    if (!existingItem || existingItem.productType !== 'RENTAL' || existingItem.productId !== product.id) {
      return res.status(409).json({
        ok: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'A chave de checkout já foi usada para outro produto.',
      });
    }

    if (existingOrder.status === 'PAID') {
      return res.status(409).json({
        ok: false,
        code: 'ORDER_ALREADY_PAID',
        error: 'Este pedido já foi pago.',
      });
    }

    if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(existingOrder.status)) {
      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'A tentativa anterior foi encerrada. Inicie um novo checkout.',
      });
    }

    if (existingOrder.preferenceInitPoint) {
      return res.status(200).json({
        ok: true,
        orderId: existingOrder.id,
        checkoutUrl: existingOrder.preferenceInitPoint,
        reused: true,
      });
    }

    if (Date.now() - new Date(existingOrder.createdAt).getTime() > 3 * 60 * 1000) {
      await db.update(orders).set({ status: 'FAILED' })
        .where(and(eq(orders.id, existingOrder.id), eq(orders.status, 'PENDING')));

      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'O checkout anterior expirou sem gerar um link. Inicie uma nova tentativa.',
      });
    }

    return res.status(409).json({
      ok: false,
      code: 'CHECKOUT_IN_PROGRESS',
      error: 'O checkout está sendo preparado. Aguarde alguns segundos e tente novamente.',
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

  const order = await db.transaction(async (tx) => {
    const created = await createPendingOrderTx(tx, {
      userId: user.id,
      totalCents: product.priceCents,
      currency: product.currency || 'BRL',
      idempotencyKey,
    });

    await tx.insert(orderItems).values({
      id: randomUUID(),
      orderId: created.id,
      productType: 'RENTAL',
      productId: product.id,
      quantity: 1,
      unitPriceCents: product.priceCents,
    });

    return created;
  });

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

    await db.update(orders).set({ status: 'FAILED' })
      .where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING')));

    return res.status(502).json({
      ok: false,
      error: 'Gateway indisponível. Tente novamente.',
    });
  }

  const checkoutUrl = preference?.init_point || preference?.sandbox_init_point;

  if (!preference?.id || !checkoutUrl) {
    await db.update(orders).set({ status: 'FAILED' })
      .where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING')));

    console.error('[payments][rental] preferência sem ID ou URL de checkout.');

    return res.status(502).json({
      ok: false,
      error: 'O gateway não retornou um link de pagamento válido.',
    });
  }

  await db.update(orders)
    .set({
      externalPaymentId: String(preference.id),
      preferenceId: String(preference.id),
      preferenceInitPoint: checkoutUrl,
    })
    .where(eq(orders.id, order.id));

  return res.status(200).json({
    ok: true,
    checkoutUrl,
    orderId: order.id,
  });
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: SUBSCRIPTION
// ─────────────────────────────────────────────────────────────
async function handleSubscription(req, res, user) {
  const body = req.body || {};
  const planId = body.plan || body.planId;
  const clientKey = body.idempotencyKey || null;
  const idempotencyKey = scopedIdempotencyKey(user.id, clientKey, 'subscription');

  if (!planId) {
    return res.status(400).json({ ok: false, error: 'plan obrigatório' });
  }

  const base = APP_URL();
  if (!base) {
    return res.status(500).json({ ok: false, error: 'APP_URL não configurada no servidor' });
  }

  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);

  if (!plan || !plan.active) {
    return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
  }

  if (!Number.isSafeInteger(Number(plan.priceCents)) || Number(plan.priceCents) <= 0) {
    return res.status(400).json({ ok: false, error: 'Preço do plano inválido.' });
  }

  const recurringInterval = getRecurringInterval(plan);

  const existingOrder = await findOrderByIdempotencyKey(user.id, idempotencyKey);

  if (existingOrder) {
    const [existingItem] = await db.select().from(orderItems)
      .where(eq(orderItems.orderId, existingOrder.id)).limit(1);

    const [existingSub] = await db.select().from(subscriptions)
      .where(eq(subscriptions.orderId, existingOrder.id)).limit(1);

    if (!existingItem || existingItem.productType !== 'SUBSCRIPTION' ||
        existingItem.productId !== plan.id || !existingSub) {
      return res.status(409).json({
        ok: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'A chave de checkout já foi usada para outro produto.',
      });
    }

    if (existingSub.status === 'ACTIVE' || existingOrder.status === 'PAID') {
      return res.status(409).json({
        ok: false,
        code: 'ORDER_ALREADY_PAID',
        error: 'Esta assinatura já foi confirmada.',
        subscriptionId: existingSub.id,
      });
    }

    if (['PAUSED', 'PAST_DUE'].includes(existingSub.status)) {
      return res.status(409).json({
        ok: false,
        code: 'SUBSCRIPTION_REQUIRES_ACTION',
        error: 'A assinatura está pausada ou com pagamento pendente. Regularize ou cancele antes de iniciar outra.',
      });
    }

    if (
      ['FAILED', 'CANCELLED', 'REFUNDED'].includes(existingOrder.status) ||
      ['CANCELLED', 'EXPIRED'].includes(existingSub.status)
    ) {
      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'A tentativa anterior foi encerrada. Inicie um novo checkout.',
      });
    }

    if (existingSub.initPoint) {
      return res.status(200).json({
        ok: true,
        orderId: existingOrder.id,
        subscriptionId: existingSub.id,
        checkoutUrl: existingSub.initPoint,
        reused: true,
      });
    }

    if (Date.now() - new Date(existingOrder.createdAt).getTime() > 3 * 60 * 1000) {
      await db.transaction(async (tx) => {
        await tx.update(orders).set({ status: 'FAILED' })
          .where(and(eq(orders.id, existingOrder.id), eq(orders.status, 'PENDING')));

        await tx.update(subscriptions).set({
          status: 'CANCELLED',
          updatedAt: new Date().toISOString(),
        }).where(and(
          eq(subscriptions.id, existingSub.id),
          eq(subscriptions.status, 'PENDING')
        ));
      });

      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'O checkout anterior expirou sem gerar um link. Inicie uma nova tentativa.',
      });
    }

    return res.status(409).json({
      ok: false,
      code: 'CHECKOUT_IN_PROGRESS',
      error: 'O checkout está sendo preparado. Aguarde alguns segundos e tente novamente.',
    });
  }

  const { order, sub } = await db.transaction(async (tx) => {
    // Serializa checkouts de assinatura por usuário, inclusive com chaves
    // de idempotência diferentes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'subscription:' + String(user.id)}))`);

    const userSubs = await tx.select().from(subscriptions)
      .where(eq(subscriptions.userId, user.id));

    const nowMs = Date.now();

    for (const current of userSubs) {
      if (current.status === 'ACTIVE') {
        const endMs = current.currentPeriodEnd
          ? new Date(current.currentPeriodEnd).getTime()
          : Infinity;

        if (endMs > nowMs) {
          const err = new Error('Você já tem uma assinatura ativa.');
          err.status = 409;
          err.code = 'SUBSCRIPTION_ALREADY_ACTIVE';
          throw err;
        }

        await tx.update(subscriptions).set({
          status: 'EXPIRED',
          updatedAt: new Date().toISOString(),
        }).where(eq(subscriptions.id, current.id));

      } else if (current.status === 'PENDING') {
        const err = new Error(
          'Você já tem uma assinatura em processamento. Conclua ou cancele a tentativa atual antes de iniciar outra.'
        );
        err.status = 409;
        err.code = 'SUBSCRIPTION_CHECKOUT_IN_PROGRESS';
        throw err;

      } else if (current.status === 'PAUSED' || current.status === 'PAST_DUE') {
        const err = new Error(
          'Existe uma assinatura pausada ou com pagamento pendente. Regularize ou cancele antes de contratar outra.'
        );
        err.status = 409;
        err.code = 'SUBSCRIPTION_REQUIRES_ACTION';
        throw err;
      }
    }

    const createdOrder = await createPendingOrderTx(tx, {
      userId: user.id,
      totalCents: plan.priceCents,
      currency: plan.currency || 'BRL',
      idempotencyKey,
    });

    await tx.insert(orderItems).values({
      id: randomUUID(),
      orderId: createdOrder.id,
      productType: 'SUBSCRIPTION',
      productId: plan.id,
      quantity: 1,
      unitPriceCents: plan.priceCents,
    });

    const [createdSub] = await tx.insert(subscriptions).values({
      id: randomUUID(),
      userId: user.id,
      planId: plan.id,
      orderId: createdOrder.id,
      status: 'PENDING',
      initPoint: null,
      payerEmail: user.email,
      updatedAt: new Date().toISOString(),
    }).returning();

    return { order: createdOrder, sub: createdSub };
  });

  await invalidateAccessCache(user.id);

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
          frequency: recurringInterval.frequency,
          frequency_type: recurringInterval.frequencyType,
          transaction_amount: plan.priceCents / 100,
          currency_id: plan.currency || 'BRL',
        },
        status: 'pending',
      }),
    });
  } catch (err) {
    console.error('[payments][subscription] MP preapproval falhou:', err.status, err.body);

    await db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'FAILED' })
        .where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING')));

      await tx.update(subscriptions).set({
        status: 'CANCELLED',
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(subscriptions.id, sub.id),
        eq(subscriptions.status, 'PENDING')
      ));
    });

    return res.status(502).json({
      ok: false,
      error: 'Gateway indisponível. Tente novamente.',
    });
  }

  if (!preapproval?.id || !preapproval?.init_point) {
    await db.transaction(async (tx) => {
      await tx.update(orders).set({ status: 'FAILED' })
        .where(and(eq(orders.id, order.id), eq(orders.status, 'PENDING')));

      await tx.update(subscriptions).set({
        status: 'CANCELLED',
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(subscriptions.id, sub.id),
        eq(subscriptions.status, 'PENDING')
      ));
    });

    return res.status(502).json({
      ok: false,
      error: 'O gateway não retornou um link válido para a assinatura.',
    });
  }

  await db.update(subscriptions)
    .set({
      initPoint: preapproval.init_point,
      externalSubscriptionId: String(preapproval.id),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(subscriptions.id, sub.id));

  return res.status(200).json({
    ok: true,
    checkoutUrl: preapproval.init_point,
    subscriptionId: sub.id,
  });
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: MANAGE
// ─────────────────────────────────────────────────────────────
async function handleManage(req, res, user) {
  if (req.method === 'GET') {
    const [sub] = await db.select().from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) {
      return res.status(200).json({ ok: true, subscription: null });
    }

    const [plan] = await db.select().from(plans)
      .where(eq(plans.id, sub.planId))
      .limit(1);

    let status;
    if (sub.status === 'ACTIVE') status = 'authorized';
    else if (sub.status === 'PENDING') status = 'pending';
    else if (sub.status === 'CANCELLED') status = 'canceled';
    else if (sub.status === 'EXPIRED') status = 'expired';
    else status = sub.status.toLowerCase();

    return res.status(200).json({
      ok: true,
      subscription: {
        id: sub.id,
        plan: plan ? plan.name : null,
        status,
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
      .where(and(
        eq(subscriptions.userId, user.id),
        or(
          eq(subscriptions.status, 'ACTIVE'),
          eq(subscriptions.status, 'PAUSED'),
          eq(subscriptions.status, 'PAST_DUE'),
          eq(subscriptions.status, 'PENDING')
        )
      ))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) {
      return res.status(404).json({ ok: false, error: 'Nenhuma assinatura ativa' });
    }

    if (sub.status === 'PENDING' && !sub.externalSubscriptionId) {
      return res.status(409).json({
        ok: false,
        error: 'A criação da assinatura ainda está em andamento. Aguarde alguns segundos e tente novamente.',
      });
    }

    if (sub.externalSubscriptionId) {
      if (!ACCESS_TOKEN()) {
        return res.status(503).json({
          ok: false,
          error: 'Gateway de pagamento não configurado. A assinatura não foi alterada.',
        });
      }

      try {
        const gatewayResult = await mpFetch(
          `/preapproval/${encodeURIComponent(sub.externalSubscriptionId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({ status: 'canceled' }),
          }
        );

        const gatewayStatus = String(gatewayResult?.status || '').toLowerCase();

        if (!['canceled', 'cancelled'].includes(gatewayStatus)) {
          console.error('[payments][manage] status inesperado no cancelamento:', gatewayStatus);

          return res.status(502).json({
            ok: false,
            error: 'O gateway não confirmou o cancelamento. A assinatura permanece inalterada.',
          });
        }
      } catch (err) {
        console.error('[payments][manage] MP cancel falhou:', err.status, err.body);

        return res.status(502).json({
          ok: false,
          error: 'Não foi possível cancelar a assinatura no gateway. Tente novamente.',
        });
      }
    }

    await db.transaction(async (tx) => {
      await tx.update(subscriptions)
        .set({
          status: 'CANCELLED',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(subscriptions.id, sub.id));

      if (sub.orderId) {
        await tx.update(orders).set({ status: 'CANCELLED' })
          .where(and(
            eq(orders.id, sub.orderId),
            eq(orders.status, 'PENDING')
          ));
      }
    });

    await invalidateAccessCache(user.id);

    return res.status(200).json({
      ok: true,
      message: 'Assinatura cancelada.',
    });
  }

  return res.status(405).json({ ok: false, error: 'Método não permitido' });
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────
async function handleWebhook(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true });
  }

  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({ ok: false, error: 'Assinatura inválida' });
  }

  const event = req.body || {};
  let type = String(event.type || event.topic || '');
  let dataId = String((event.data && event.data.id) || '');
  let authorizedPreapprovalId = '';

  if (!type || !dataId) {
    return res.status(400).json({ ok: false, error: 'Payload inválido' });
  }

  const provider = 'mercadopago';
  const notificationId = String(event.id || req.headers['x-request-id'] || '').trim();

  const providerEvent = `${type}:${notificationId || `${dataId}:${String(event.action || event.topic || 'notification')}`}`;

  const [insertedEvent] = await db.insert(paymentsEvents).values({
    provider,
    providerEvent,
    eventType: type,
    externalId: dataId,
    payload: event,
  }).onConflictDoNothing({
    target: [paymentsEvents.provider, paymentsEvents.providerEvent],
  }).returning();

  let eventRow = insertedEvent;

  if (!eventRow) {
    [eventRow] = await db.select().from(paymentsEvents)
      .where(and(
        eq(paymentsEvents.provider, provider),
        eq(paymentsEvents.providerEvent, providerEvent)
      ))
      .limit(1);
  }

  if (!eventRow) throw new Error('WEBHOOK_EVENT_PERSIST_FAILED');

  if (eventRow.processedAt) {
    return res.status(200).json({ ok: true, duplicated: true });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  const [claimedEvent] = await db.update(paymentsEvents)
    .set({
      processingAt: now.toISOString(),
      failureReason: null,
    })
    .where(and(
      eq(paymentsEvents.id, eventRow.id),
      isNull(paymentsEvents.processedAt),
      or(
        isNull(paymentsEvents.processingAt),
        lt(paymentsEvents.processingAt, staleBefore)
      )
    ))
    .returning();

  if (!claimedEvent) {
    return res.status(503).json({
      ok: false,
      error: 'Evento já está em processamento. Tente novamente.',
    });
  }

  eventRow = claimedEvent;

  try {
    // Faturas de assinatura usam authorized_payments.
    // Localiza o pagamento real e reaproveita a validação do evento payment.
    if (type === 'subscription_authorized_payment') {
      const authorized = await mpFetch(
        `/authorized_payments/${encodeURIComponent(dataId)}`
      );

      const paymentId = authorized?.payment?.id ||
        authorized?.payment_id ||
        authorized?.paymentId ||
        null;

      authorizedPreapprovalId = String(
        authorized?.external_reference ||
        authorized?.preapproval_id ||
        ''
      ).trim();

      if (!paymentId) {
        const authStatus = String(authorized?.status || '').toLowerCase();

        if (['pending', 'in_process', 'authorized', 'scheduled'].includes(authStatus)) {
          await db.update(paymentsEvents).set({
            processedAt: new Date().toISOString(),
            processingAt: null,
            failureReason: `Fatura ainda não possui pagamento final (${authStatus}).`,
          }).where(eq(paymentsEvents.id, eventRow.id));

          return res.status(200).json({
            ok: true,
            pending: true,
            authorizedPayment: true,
          });
        }

        throw new Error('FATURA_SEM_PAGAMENTO_ASSOCIADO');
      }

      type = 'payment';
      dataId = String(paymentId);
    }

       if (type === 'payment') {
      const pay = await mpFetch(`/v1/payments/${encodeURIComponent(dataId)}`);

      const status = String(pay.status || '').toLowerCase();

      const orderId = String(
        pay.external_reference ||
        pay.metadata?.order_id ||
        pay.metadata?.subscription_id ||
        pay.metadata?.preapproval_id ||
        authorizedPreapprovalId ||
        ''
      ).trim();

      if (!orderId) {
        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
            failureReason: 'Pagamento sem referência externa.',
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({ ok: true, ignored: true });
      }

      const isUuidReference =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId);

      const [order] = isUuidReference
        ? await db.select().from(orders)
          .where(eq(orders.id, orderId))
          .limit(1)
        : [];

      let referencedSub = null;

      if (!order) {
        const [sub] = await db.select().from(subscriptions)
          .where(
            isUuidReference
              ? or(
                eq(subscriptions.id, orderId),
                eq(subscriptions.externalSubscriptionId, orderId)
              )
              : eq(subscriptions.externalSubscriptionId, orderId)
          )
          .limit(1);

        referencedSub = sub || null;
      }

      // Cobranças recorrentes podem referenciar a assinatura,
      // e não o pedido avulso.
      if (!order && referencedSub) {
        if (['pending', 'in_process', 'authorized'].includes(status)) {
          await db.update(paymentsEvents).set({
            processingAt: null,
            failureReason: null,
          }).where(eq(paymentsEvents.id, eventRow.id));

          return res.status(200).json({
            ok: true,
            pending: true,
            subscription: true,
          });
        }

        const [plan] = await db.select().from(plans)
          .where(eq(plans.id, referencedSub.planId))
          .limit(1);

        if (!plan) throw new Error('PLANO_DA_ASSINATURA_INEXISTENTE');

        const now = new Date();

        if (status === 'approved') {
          const paidCents = Math.round(Number(pay.transaction_amount) * 100);

          if (!Number.isFinite(paidCents) || paidCents !== Number(plan.priceCents)) {
            throw new Error('VALOR_DA_ASSINATURA_DIVERGENTE');
          }

          if (pay.currency_id && plan.currency && pay.currency_id !== plan.currency) {
            throw new Error('MOEDA_DA_ASSINATURA_DIVERGENTE');
          }

          let preapproval = null;

          if (referencedSub.externalSubscriptionId) {
            try {
              preapproval = await mpFetch(
                `/preapproval/${encodeURIComponent(referencedSub.externalSubscriptionId)}`
              );
            } catch (lookupErr) {
              console.warn(
                '[payments][webhook] não foi possível consultar pré-aprovação recorrente:',
                lookupErr.status || lookupErr.message
              );
            }
          }

          const currentEnd = referencedSub.currentPeriodEnd
            ? new Date(referencedSub.currentPeriodEnd)
            : null;

          const wasActive = referencedSub.status === 'ACTIVE' &&
            currentEnd &&
            currentEnd.getTime() > now.getTime();

          const gatewayNextDate =
            preapproval?.next_payment_date ||
            preapproval?.auto_recurring?.next_payment_date;

          let nextEnd = gatewayNextDate ? new Date(gatewayNextDate) : null;

          if (!nextEnd || !Number.isFinite(nextEnd.getTime()) || nextEnd.getTime() <= now.getTime()) {
            nextEnd = addRecurringPeriod(pay.date_approved || now, plan);
          }

          await db.transaction(async (tx) => {
            await tx.update(subscriptions).set({
              status: 'ACTIVE',
              currentPeriodStart: pay.date_approved || now.toISOString(),
              currentPeriodEnd: nextEnd.toISOString(),
              updatedAt: now.toISOString(),
            }).where(eq(subscriptions.id, referencedSub.id));

            if (referencedSub.orderId) {
              await tx.update(orders).set({
                status: 'PAID',
                paidAt: pay.date_approved || now.toISOString(),
                externalPaymentId: String(pay.id),
              }).where(and(
                eq(orders.id, referencedSub.orderId),
                eq(orders.userId, referencedSub.userId),
                eq(orders.status, 'PENDING')
              ));
            }
          });

          await invalidateAccessCache(referencedSub.userId);

          if (!wasActive) {
            try {
              const [user] = await db.select({ email: users.email })
                .from(users)
                .where(eq(users.id, referencedSub.userId))
                .limit(1);

              if (user?.email) {
                await sendSubscriptionConfirmation(
                  user.email,
                  plan.name || 'Premium',
                  nextEnd.toISOString()
                );
              }
            } catch (emailErr) {
              console.warn('[payments][webhook] falha no e-mail recorrente:', emailErr.message);
            }
          }

        } else {
          const updates = {
            status: 'PAST_DUE',
            updatedAt: now.toISOString(),
          };

          if (status === 'refunded' || status === 'charged_back') {
            updates.currentPeriodEnd = now.toISOString();
          }

          await db.update(subscriptions).set(updates)
            .where(eq(subscriptions.id, referencedSub.id));

          await invalidateAccessCache(referencedSub.userId);
        }

        await db.update(paymentsEvents).set({
          processedAt: new Date().toISOString(),
          processingAt: null,
          failureReason: status === 'approved' ? null : `Pagamento recorrente ${status}.`,
        }).where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({
          ok: true,
          subscription: true,
          paymentStatus: status,
        });
      }

      if (!order) throw new Error('PEDIDO_OU_ASSINATURA_INEXISTENTE');

      if (status !== 'approved') {
        if (['pending', 'in_process', 'authorized'].includes(status)) {
          await db.update(paymentsEvents)
            .set({
              processingAt: null,
              failureReason: null,
            })
            .where(eq(paymentsEvents.id, eventRow.id));

          return res.status(200).json({ ok: true, pending: true });
        }

        const terminalOrderStatus =
          status === 'refunded' || status === 'charged_back'
            ? 'REFUNDED'
            : status === 'cancelled'
              ? 'CANCELLED'
              : 'FAILED';

        if (terminalOrderStatus === 'REFUNDED') {
          const [targetOrder] = await db.select().from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);

          if (targetOrder) {
            await db.transaction(async (tx) => {
              await tx.update(orders).set({ status: 'REFUNDED' })
                .where(eq(orders.id, targetOrder.id));

              await tx.update(rentals).set({ status: 'CANCELLED' })
                .where(and(
                  eq(rentals.orderId, targetOrder.id),
                  eq(rentals.status, 'ACTIVE')
                ));
            });

            await invalidateAccessCache(targetOrder.userId);
          }
        } else {
          await db.update(orders)
            .set({ status: terminalOrderStatus })
            .where(and(
              eq(orders.id, orderId),
              eq(orders.status, 'PENDING')
            ));
        }

        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
            failureReason:
              terminalOrderStatus === 'FAILED' || terminalOrderStatus === 'CANCELLED'
                ? `Pagamento ${status}.`
                : null,
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({
          ok: true,
          ignored: true,
          paymentStatus: status,
        });
      }

      const paidAmount = Number(pay.transaction_amount) * 100;

      if (Number(order.totalCents) !== Math.round(paidAmount)) {
        console.error('[payments][webhook] valor divergente:', {
          orderId,
          esperado: order.totalCents,
          pago: paidAmount,
        });
        throw new Error('VALOR_DIVERGENTE');
      }

      if (pay.currency_id && order.currency && pay.currency_id !== order.currency) {
        console.error('[payments][webhook] moeda divergente:', {
          orderId,
          esperado: order.currency,
          pago: pay.currency_id,
        });
        throw new Error('MOEDA_DIVERGENTE');
      }

      if (order.status === 'PAID') {
        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({ ok: true, alreadyPaid: true });
      }

      // Transição PENDING -> PAID e concessão do aluguel na mesma transação.
      const fulfillment = await db.transaction(async (tx) => {
        const [paidOrder] = await tx.update(orders)
          .set({
            status: 'PAID',
            paidAt: new Date().toISOString(),
            externalPaymentId: String(pay.id),
          })
          .where(and(
            eq(orders.id, order.id),
            eq(orders.status, 'PENDING')
          ))
          .returning({ id: orders.id });

        if (!paidOrder) {
          return { alreadyProcessed: true, rental: null, product: null };
        }

        const [orderItem] = await tx.select().from(orderItems)
          .where(eq(orderItems.orderId, order.id))
          .limit(1);

        if (!orderItem) throw new Error('ITEM_PEDIDO_INEXISTENTE');

        if (orderItem.productType !== 'RENTAL') {
          return { alreadyProcessed: false, rental: null, product: null };
        }

        const [prod] = await tx.select().from(rentalProducts)
          .where(eq(rentalProducts.id, orderItem.productId))
          .limit(1);

        if (!prod || !Number.isInteger(prod.durationHours) || prod.durationHours <= 0) {
          throw new Error('PRODUTO_INEXISTENTE_OU_INVALIDO');
        }

        const startedAt = new Date();
        const expiresAt = new Date(
          startedAt.getTime() + prod.durationHours * 3600 * 1000
        );

        const [rental] = await tx.insert(rentals).values({
          id: randomUUID(),
          rentalCode: `RENT-${randomUUID().slice(0, 8).toUpperCase()}`,
          userId: order.userId,
          trackId: prod.trackId,
          albumId: prod.albumId,
          orderId: order.id,
          status: 'ACTIVE',
          startsAt: startedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        }).returning();

        return { alreadyProcessed: false, rental, product: prod };
      });

      if (fulfillment.alreadyProcessed) {
        await db.update(paymentsEvents).set({
          processedAt: new Date().toISOString(),
          processingAt: null,
        }).where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({ ok: true, alreadyPaid: true });
      }

      await invalidateAccessCache(order.userId);

      if (fulfillment.rental && fulfillment.product) {
        try {
          const [user] = await db.select({ email: users.email })
            .from(users)
            .where(eq(users.id, order.userId))
            .limit(1);

          if (user?.email) {
            await sendRentalConfirmation(
              user.email,
              fulfillment.product.name,
              fulfillment.rental.expiresAt
            );
          }
        } catch (emailErr) {
          console.warn('[payments][webhook] falha no e-mail:', emailErr.message);
        }
      }

    } else if (type === 'subscription_preapproval' || type === 'preapproval') {
      const pre = await mpFetch(`/preapproval/${encodeURIComponent(dataId)}`);
      const subId = pre.external_reference;

      if (subId) {
        if (pre.status === 'authorized') {
          // Autorização do contrato não comprova a liquidação da primeira cobrança.
          // O acesso só é liberado após o evento de pagamento aprovado.
          const [sub] = await db.select().from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(subscriptions.externalSubscriptionId, String(pre.id))
            ))
            .limit(1);

          if (!sub) throw new Error('ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY');

        } else if (pre.status === 'paused') {
          const [sub] = await db.select().from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(subscriptions.externalSubscriptionId, String(pre.id))
            ))
            .limit(1);

          if (!sub) throw new Error('ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY');

          await db.update(subscriptions).set({
            status: 'PAUSED',
            updatedAt: new Date().toISOString(),
          }).where(eq(subscriptions.id, subId));

          await invalidateAccessCache(sub.userId);

        } else if (pre.status === 'cancelled' || pre.status === 'canceled') {
          const [sub] = await db.select().from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(subscriptions.externalSubscriptionId, String(pre.id))
            ))
            .limit(1);

          if (!sub) throw new Error('ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY');

          await db.transaction(async (tx) => {
            await tx.update(subscriptions).set({
              status: 'CANCELLED',
              updatedAt: new Date().toISOString(),
            }).where(eq(subscriptions.id, subId));

            if (sub.orderId) {
              await tx.update(orders).set({ status: 'CANCELLED' })
                .where(and(
                  eq(orders.id, sub.orderId),
                  eq(orders.status, 'PENDING')
                ));
            }
          });

          if (sub.userId) await invalidateAccessCache(sub.userId);
        }
      }
    }

    await db.update(paymentsEvents)
      .set({
        processedAt: new Date().toISOString(),
        processingAt: null,
        failureReason: null,
      })
      .where(eq(paymentsEvents.id, eventRow.id));

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('[payments][webhook] erro:', err.message, err.body || '');

    await db.update(paymentsEvents)
      .set({
        failureReason: String(err.message || 'WEBHOOK_ERROR').slice(0, 500),
        processingAt: null,
      })
      .where(eq(paymentsEvents.id, eventRow.id));

    return res.status(500).json({ ok: false });
  }
}

// ─────────────────────────────────────────────────────────────
// ROTEADOR
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  const allowedOrigin = APP_URL();

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-signature, x-request-id');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const type = String(req.query.type || '');
  const action = String(req.query.action || '');
  const op = type || action;

  if (op === 'webhook') return handleWebhook(req, res);

  let user = null;
  try {
    user = await getAuthUser(req);
  } catch {
    user = null;
  }

  if (!user) {
    return res.status(401).json({ ok: false, error: 'Não autenticado' });
  }

  if (req.method !== 'GET' && !checkOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origem não permitida.' });
  }

  try {
    if (op === 'rental' || op === 'rent') {
      return await handleRental(req, res, user);
    }
    if (op === 'subscription' || op === 'subscribe') {
      return await handleSubscription(req, res, user);
    }
    if (op === 'manage') {
      return await handleManage(req, res, user);
    }

    return res.status(400).json({ ok: false, error: 'Ação inválida' });

  } catch (err) {
    if (err?.status && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({
        ok: false,
        error: err.message || 'Requisição inválida.',
        code: err.code || null,
      });
    }

    console.error('[payments] erro:', err.message);

    return res.status(500).json({
      ok: false,
      error: 'Erro interno',
    });
  }
};
