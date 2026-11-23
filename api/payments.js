
'use strict';

/* ============================================================
   API: /api/payments — Mercado Pago
   Versão revisada
   ============================================================ */

const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const { eq, and, gt, desc, isNull, lt, or } = require('drizzle-orm');
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

// ─────────────────────────────────────────────────────────────
// MERCADO PAGO — HELPERS
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
// WEBHOOK — VALIDAÇÃO DA ASSINATURA
// ─────────────────────────────────────────────────────────────

function verifyWebhookSignature(req) {
  const secret = WEBHOOK_SECRET();

  if (!secret) return false;

  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '').trim();

  if (!signature || !requestId) return false;

  const parts = Object.fromEntries(
    signature.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  if (!parts.ts || !parts.v1) return false;
  if (!/^\d+$/.test(parts.ts)) return false;
  if (!/^[a-f0-9]{64}$/i.test(parts.v1)) return false;

  const timestamp = Number(parts.ts);

  if (!Number.isFinite(timestamp)) return false;

  if (Math.abs(Date.now() - timestamp) > WEBHOOK_MAX_AGE_MS) {
    return false;
  }

  const dataId = String(
    (req.query && req.query['data.id']) ||
    (req.body && req.body.data && req.body.data.id) ||
    ''
  );

  if (!dataId) return false;

  const manifest =
    `id:${dataId};request-id:${requestId};ts:${parts.ts};`;

  const expected = createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(parts.v1, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

// ─────────────────────────────────────────────────────────────
// HELPERS DE PEDIDOS
// ─────────────────────────────────────────────────────────────

async function findOrderByIdempotencyKey(userId, key) {
  if (!userId || !key) return null;

  const [row] = await db.select()
    .from(orders)
    .where(and(
      eq(orders.userId, userId),
      eq(orders.idempotencyKey, key)
    ))
    .limit(1);

  return row || null;
}

function scopedIdempotencyKey(userId, rawKey, scope) {
  const raw = rawKey == null ? '' : String(rawKey).trim();

  if (
    raw &&
    (
      raw.length < 8 ||
      raw.length > 128 ||
      !/^[a-zA-Z0-9._:-]+$/.test(raw)
    )
  ) {
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
  })
    .onConflictDoNothing({
      target: orders.idempotencyKey,
    })
    .returning();

  if (!row) {
    const err = new Error(
      'Já existe uma tentativa de checkout com esta chave.'
    );
    err.status = 409;
    err.code = 'IDEMPOTENCY_CONFLICT';
    throw err;
  }

  return row;
}

// ─────────────────────────────────────────────────────────────
// AÇÃO: ALUGUEL
// ─────────────────────────────────────────────────────────────

async function handleRental(req, res, user) {
  const body = req.body || {};

  const planId = body.planId;
  const albumId = body.albumId || null;
  const trackIndex = body.trackIndex ?? null;
  const clientKey = body.idempotencyKey || null;

  const idempotencyKey = scopedIdempotencyKey(
    user.id,
    clientKey,
    'rental'
  );

  if (!planId) {
    return res.status(400).json({
      ok: false,
      error: 'planId obrigatório',
    });
  }

  const base = APP_URL();

  if (!base) {
    return res.status(500).json({
      ok: false,
      error: 'APP_URL não configurada no servidor',
    });
  }

  const [plan] = await db.select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);

  if (!plan || !plan.active) {
    return res.status(404).json({
      ok: false,
      error: 'Plano não encontrado',
    });
  }

  let trackId = null;

  if (albumId && trackIndex != null) {
    const [track] = await db.select({
      id: tracks.id,
    })
      .from(tracks)
      .where(and(
        eq(tracks.albumId, albumId),
        eq(tracks.trackNumber, trackIndex)
      ))
      .limit(1);

    if (!track) {
      return res.status(404).json({
        ok: false,
        error: 'Faixa não encontrada',
      });
    }

    trackId = track.id;
  }

  const [product] = await db.select()
    .from(rentalProducts)
    .where(and(
      eq(rentalProducts.active, true),
      trackId
        ? eq(rentalProducts.trackId, trackId)
        : eq(rentalProducts.albumId, albumId)
    ))
    .limit(1);

  if (!product) {
    return res.status(404).json({
      ok: false,
      error: 'Produto de aluguel não encontrado para este item',
    });
  }

  const existingOrder = await findOrderByIdempotencyKey(
    user.id,
    idempotencyKey
  );

  if (existingOrder) {
    const [existingItem] = await db.select()
      .from(orderItems)
      .where(eq(orderItems.orderId, existingOrder.id))
      .limit(1);

    if (
      !existingItem ||
      existingItem.productType !== 'RENTAL' ||
      existingItem.productId !== product.id
    ) {
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

    if (existingOrder.preferenceInitPoint) {
      return res.status(200).json({
        ok: true,
        orderId: existingOrder.id,
        checkoutUrl: existingOrder.preferenceInitPoint,
        reused: true,
      });
    }

    if (
      existingOrder.status === 'FAILED' ||
      existingOrder.status === 'CANCELLED'
    ) {
      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'A tentativa anterior falhou. Inicie um novo checkout.',
      });
    }

    if (
      Date.now() -
      new Date(existingOrder.createdAt).getTime() >
      3 * 60 * 1000
    ) {
      await db.update(orders)
        .set({ status: 'FAILED' })
        .where(and(
          eq(orders.id, existingOrder.id),
          eq(orders.status, 'PENDING')
        ));

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

  const conditions = [
    eq(rentals.userId, user.id),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, now.toISOString()),
  ];

  if (product.trackId) {
    conditions.push(eq(rentals.trackId, product.trackId));
  }

  if (product.albumId) {
    conditions.push(eq(rentals.albumId, product.albumId));
  }

  const [existingRental] = await db.select()
    .from(rentals)
    .where(and(...conditions))
    .limit(1);

  if (existingRental) {
    return res.status(409).json({
      ok: false,
      error: 'Você já tem um aluguel ativo deste item',
      expiresAt: existingRental.expiresAt,
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
          description: trackId
            ? 'Aluguel de faixa'
            : 'Aluguel de álbum',
          quantity: 1,
          currency_id: product.currency || 'BRL',
          unit_price: product.priceCents / 100,
        }],

        payer: {
          email: user.email,
        },

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
    console.error(
      '[payments][rental] MP preference falhou:',
      err.status,
      err.body
    );

    await db.update(orders)
      .set({ status: 'FAILED' })
      .where(and(
        eq(orders.id, order.id),
        eq(orders.status, 'PENDING')
      ));

    return res.status(502).json({
      ok: false,
      error: 'Gateway indisponível. Tente novamente.',
    });
  }

  const checkoutUrl =
    preference.init_point ||
    preference.sandbox_init_point ||
    null;

  if (!preference.id || !checkoutUrl) {
    await db.update(orders)
      .set({ status: 'FAILED' })
      .where(and(
        eq(orders.id, order.id),
        eq(orders.status, 'PENDING')
      ));

    return res.status(502).json({
      ok: false,
      error: 'O Mercado Pago não retornou um link de pagamento válido.',
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
// AÇÃO: ASSINATURA
// ─────────────────────────────────────────────────────────────

async function handleSubscription(req, res, user) {
  const body = req.body || {};

  const planId = body.plan || body.planId;
  const clientKey = body.idempotencyKey || null;

  const idempotencyKey = scopedIdempotencyKey(
    user.id,
    clientKey,
    'subscription'
  );

  if (!planId) {
    return res.status(400).json({
      ok: false,
      error: 'plan obrigatório',
    });
  }

  const base = APP_URL();

  if (!base) {
    return res.status(500).json({
      ok: false,
      error: 'APP_URL não configurada no servidor',
    });
  }

  const [plan] = await db.select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);

  if (!plan || !plan.active) {
    return res.status(404).json({
      ok: false,
      error: 'Plano não encontrado',
    });
  }

  const existingOrder = await findOrderByIdempotencyKey(
    user.id,
    idempotencyKey
  );

  if (existingOrder) {
    const [existingItem] = await db.select()
      .from(orderItems)
      .where(eq(orderItems.orderId, existingOrder.id))
      .limit(1);

    const [existingSub] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.orderId, existingOrder.id))
      .limit(1);

    if (
      !existingItem ||
      existingItem.productType !== 'SUBSCRIPTION' ||
      existingItem.productId !== plan.id ||
      !existingSub
    ) {
      return res.status(409).json({
        ok: false,
        code: 'IDEMPOTENCY_KEY_REUSED',
        error: 'A chave de checkout já foi usada para outro produto.',
      });
    }

    if (
      existingSub.status === 'ACTIVE' ||
      existingOrder.status === 'PAID'
    ) {
      return res.status(409).json({
        ok: false,
        code: 'ORDER_ALREADY_PAID',
        error: 'Esta assinatura já foi confirmada.',
        subscriptionId: existingSub.id,
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

    if (
      existingOrder.status === 'FAILED' ||
      existingOrder.status === 'CANCELLED' ||
      existingSub.status === 'CANCELLED'
    ) {
      return res.status(409).json({
        ok: false,
        code: 'CHECKOUT_FAILED',
        error: 'A tentativa anterior falhou. Inicie um novo checkout.',
      });
    }

    if (
      Date.now() -
      new Date(existingOrder.createdAt).getTime() >
      3 * 60 * 1000
    ) {
      await db.transaction(async (tx) => {
        await tx.update(orders)
          .set({ status: 'FAILED' })
          .where(and(
            eq(orders.id, existingOrder.id),
            eq(orders.status, 'PENDING')
          ));

        await tx.update(subscriptions)
          .set({
            status: 'CANCELLED',
            updatedAt: new Date().toISOString(),
          })
          .where(and(
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

  const [active] = await db.select()
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, user.id),
      eq(subscriptions.status, 'ACTIVE')
    ))
    .limit(1);

  if (active) {
    return res.status(409).json({
      ok: false,
      error: 'Você já tem uma assinatura ativa',
      subscriptionId: active.id,
    });
  }

  const { order, sub } = await db.transaction(async (tx) => {
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

    return {
      order: createdOrder,
      sub: createdSub,
    };
  });

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
          frequency_type:
            plan.intervalUnit === 'YEAR'
              ? 'years'
              : plan.intervalUnit === 'MONTH'
                ? 'months'
                : 'days',
          transaction_amount: plan.priceCents / 100,
          currency_id: plan.currency || 'BRL',
        },

        status: 'pending',
      }),
    });
  } catch (err) {
    console.error(
      '[payments][subscription] MP preapproval falhou:',
      err.status,
      err.body
    );

    await db.transaction(async (tx) => {
      await tx.update(orders)
        .set({ status: 'FAILED' })
        .where(and(
          eq(orders.id, order.id),
          eq(orders.status, 'PENDING')
        ));

      await tx.update(subscriptions)
        .set({
          status: 'CANCELLED',
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, 'PENDING')
        ));
    });

    return res.status(502).json({
      ok: false,
      error: 'Gateway indisponível. Tente novamente.',
    });
  }

  if (!preapproval.id || !preapproval.init_point) {
    await db.transaction(async (tx) => {
      await tx.update(orders)
        .set({ status: 'FAILED' })
        .where(and(
          eq(orders.id, order.id),
          eq(orders.status, 'PENDING')
        ));

      await tx.update(subscriptions)
        .set({
          status: 'CANCELLED',
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(subscriptions.id, sub.id),
          eq(subscriptions.status, 'PENDING')
        ));
    });

    return res.status(502).json({
      ok: false,
      error: 'O Mercado Pago não retornou uma assinatura válida.',
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
// AÇÃO: GERENCIAR ASSINATURA
// ─────────────────────────────────────────────────────────────

async function handleManage(req, res, user) {
  if (req.method === 'GET') {
    const [sub] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (!sub) {
      return res.status(200).json({
        ok: true,
        subscription: null,
      });
    }

    const [plan] = await db.select()
      .from(plans)
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
        canceledAt:
          sub.status === 'CANCELLED'
            ? sub.updatedAt
            : null,
      },
    });
  }

  if (req.method === 'POST') {
    const body = req.body || {};

    if (body.action !== 'cancel') {
      return res.status(400).json({
        ok: false,
        error: 'Ação inválida',
      });
    }

    const [sub] = await db.select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.status, 'ACTIVE')
      ))
      .limit(1);

    if (!sub) {
      return res.status(404).json({
        ok: false,
        error: 'Nenhuma assinatura ativa',
      });
    }

    if (sub.externalSubscriptionId && ACCESS_TOKEN()) {
      try {
        await mpFetch(
          `/preapproval/${encodeURIComponent(sub.externalSubscriptionId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              status: 'cancelled',
            }),
          }
        );
      } catch (err) {
        console.error(
          '[payments][manage] MP cancel falhou:',
          err.status,
          err.body
        );

        return res.status(502).json({
          ok: false,
          error: 'Não foi possível cancelar a assinatura no gateway. Tente novamente.',
        });
      }
    }

    await db.update(subscriptions)
      .set({
        status: 'CANCELLED',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(subscriptions.id, sub.id));

    await invalidateAccessCache(user.id);

    return res.status(200).json({
      ok: true,
      message: 'Assinatura cancelada.',
    });
  }

  return res.status(405).json({
    ok: false,
    error: 'Método não permitido',
  });
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK — MERCADO PAGO
// ─────────────────────────────────────────────────────────────

async function handleWebhook(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true });
  }

  if (!verifyWebhookSignature(req)) {
    return res.status(401).json({
      ok: false,
      error: 'Assinatura inválida',
    });
  }

  const event = req.body || {};
  const type = String(event.type || event.topic || '');
  const dataId = String(
    (event.data && event.data.id) ||
    (req.query && req.query['data.id']) ||
    ''
  );

  if (!type || !dataId) {
    return res.status(400).json({
      ok: false,
      error: 'Payload inválido',
    });
  }

  const provider = 'mercadopago';

  const notificationId = String(
    event.id ||
    req.headers['x-request-id'] ||
    ''
  ).trim();

  const providerEvent =
    `${type}:${notificationId || `${dataId}:${String(event.action || event.topic || 'notification')}`}`;

  const [insertedEvent] = await db.insert(paymentsEvents)
    .values({
      provider,
      providerEvent,
      eventType: type,
      externalId: dataId,
      payload: event,
    })
    .onConflictDoNothing({
      target: [
        paymentsEvents.provider,
        paymentsEvents.providerEvent,
      ],
    })
    .returning();

  let eventRow = insertedEvent;

  if (!eventRow) {
    [eventRow] = await db.select()
      .from(paymentsEvents)
      .where(and(
        eq(paymentsEvents.provider, provider),
        eq(paymentsEvents.providerEvent, providerEvent)
      ))
      .limit(1);
  }

  if (!eventRow) {
    throw new Error('WEBHOOK_EVENT_PERSIST_FAILED');
  }

  if (eventRow.processedAt) {
    return res.status(200).json({
      ok: true,
      duplicated: true,
    });
  }

  const now = new Date();

  const staleBefore = new Date(
    now.getTime() - 10 * 60 * 1000
  ).toISOString();

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
    if (type === 'payment') {
      const pay = await mpFetch(
        `/v1/payments/${encodeURIComponent(dataId)}`
      );

      const status = String(pay.status || '').toLowerCase();

      const orderId = String(
        pay.external_reference ||
        pay.metadata?.order_id ||
        pay.metadata?.subscription_id ||
        pay.metadata?.preapproval_id ||
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

        return res.status(200).json({
          ok: true,
          ignored: true,
        });
      }

      const isUuidReference =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(orderId);

      const [order] = isUuidReference
        ? await db.select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1)
        : [];

      let referencedSub = null;

      if (!order) {
        const [sub] = await db.select()
          .from(subscriptions)
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

      // ─────────────────────────────────────────────────────
      // PAGAMENTO RECORRENTE DE ASSINATURA
      // ─────────────────────────────────────────────────────

      if (!order && referencedSub) {
        if (
          ['pending', 'in_process', 'authorized'].includes(status)
        ) {
          await db.update(paymentsEvents)
            .set({
              processingAt: null,
              failureReason: null,
            })
            .where(eq(paymentsEvents.id, eventRow.id));

          return res.status(200).json({
            ok: true,
            pending: true,
            subscription: true,
          });
        }

        const [plan] = await db.select()
          .from(plans)
          .where(eq(plans.id, referencedSub.planId))
          .limit(1);

        if (!plan) {
          throw new Error('PLANO_DA_ASSINATURA_INEXISTENTE');
        }

        const paymentNow = new Date();

        if (status === 'approved') {
          const paidCents = Math.round(
            Number(pay.transaction_amount) * 100
          );

          if (
            !Number.isFinite(paidCents) ||
            paidCents !== Number(plan.priceCents)
          ) {
            throw new Error('VALOR_DA_ASSINATURA_DIVERGENTE');
          }

          if (
            pay.currency_id &&
            plan.currency &&
            pay.currency_id !== plan.currency
          ) {
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

          const approvedAt = new Date(
            pay.date_approved || paymentNow.toISOString()
          );

          if (!Number.isFinite(approvedAt.getTime())) {
            throw new Error(
              'DATA_DE_APROVACAO_DA_ASSINATURA_INVALIDA'
            );
          }

          const approvedAtIso = approvedAt.toISOString();

          const previousStart = referencedSub.currentPeriodStart
            ? new Date(referencedSub.currentPeriodStart)
            : null;

          // Impede reaplicar uma cobrança já processada.
          const isNewPayment =
            !previousStart ||
            approvedAt.getTime() > previousStart.getTime();

          let nextEnd = referencedSub.currentPeriodEnd
            ? new Date(referencedSub.currentPeriodEnd)
            : null;

          if (isNewPayment) {
            const gatewayNextDate =
              preapproval?.next_payment_date ||
              preapproval?.auto_recurring?.next_payment_date;

            const candidate = gatewayNextDate
              ? new Date(gatewayNextDate)
              : null;

            if (
              candidate &&
              Number.isFinite(candidate.getTime()) &&
              candidate.getTime() > approvedAt.getTime()
            ) {
              nextEnd = candidate;
            } else {
              const baseDate =
                nextEnd &&
                nextEnd.getTime() > approvedAt.getTime()
                  ? new Date(nextEnd)
                  : new Date(approvedAt);

              const unit = String(
                plan.intervalUnit || ''
              ).toUpperCase();

              const count = Math.max(
                1,
                Number(plan.intervalCount) || 1
              );

              if (unit === 'MONTH') {
                baseDate.setMonth(
                  baseDate.getMonth() + count
                );
              } else if (unit === 'YEAR') {
                baseDate.setFullYear(
                  baseDate.getFullYear() + count
                );
              } else {
                baseDate.setDate(
                  baseDate.getDate() + count
                );
              }

              nextEnd = baseDate;
            }
          }

          let updatedSubscription = null;

          await db.transaction(async (tx) => {
            if (isNewPayment) {
              const [updated] = await tx.update(subscriptions)
                .set({
                  status: 'ACTIVE',
                  currentPeriodStart: approvedAtIso,
                  currentPeriodEnd: nextEnd.toISOString(),
                  updatedAt: paymentNow.toISOString(),
                })
                .where(and(
                  eq(subscriptions.id, referencedSub.id),
                  or(
                    isNull(subscriptions.currentPeriodStart),
                    lt(
                      subscriptions.currentPeriodStart,
                      approvedAtIso
                    )
                  )
                ))
                .returning({
                  id: subscriptions.id,
                });

              updatedSubscription = updated || null;
            }

            // Liquida o pedido original somente com pagamento aprovado.
            if (referencedSub.orderId) {
              const [originOrder] = await tx.select()
                .from(orders)
                .where(and(
                  eq(orders.id, referencedSub.orderId),
                  eq(orders.userId, referencedSub.userId)
                ))
                .limit(1);

              if (originOrder) {
                if (
                  originOrder.totalCents !== Number(plan.priceCents) ||
                  (
                    originOrder.currency &&
                    plan.currency &&
                    originOrder.currency !== plan.currency
                  )
                ) {
                  throw new Error(
                    'PEDIDO_ORIGINAL_DA_ASSINATURA_DIVERGENTE'
                  );
                }

                if (originOrder.status === 'PENDING') {
                  await tx.update(orders)
                    .set({
                      status: 'PAID',
                      paidAt: approvedAtIso,
                      externalPaymentId: String(pay.id),
                    })
                    .where(and(
                      eq(orders.id, originOrder.id),
                      eq(orders.status, 'PENDING')
                    ));
                } else if (originOrder.status !== 'PAID') {
                  throw new Error(
                    'PEDIDO_ORIGINAL_NAO_PODE_SER_LIQUIDADO'
                  );
                }
              }
            }
          });

          if (updatedSubscription) {
            await invalidateAccessCache(referencedSub.userId);

            try {
              const [userRow] = await db.select({
                email: users.email,
              })
                .from(users)
                .where(eq(users.id, referencedSub.userId))
                .limit(1);

              if (userRow?.email) {
                await sendSubscriptionConfirmation(
                  userRow.email,
                  plan.name || 'Premium',
                  nextEnd.toISOString()
                );
              }
            } catch (emailErr) {
              console.warn(
                '[payments][webhook] falha no e-mail recorrente:',
                emailErr.message
              );
            }
          }
        } else {
          const updates = {
            status: 'PAST_DUE',
            updatedAt: paymentNow.toISOString(),
          };

          if (
            status === 'refunded' ||
            status === 'charged_back'
          ) {
            updates.currentPeriodEnd =
              paymentNow.toISOString();
          }

          await db.update(subscriptions)
            .set(updates)
            .where(eq(subscriptions.id, referencedSub.id));

          await invalidateAccessCache(referencedSub.userId);
        }

        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
            failureReason:
              status === 'approved'
                ? null
                : `Pagamento recorrente ${status}.`,
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({
          ok: true,
          subscription: true,
          paymentStatus: status,
        });
      }

      if (!order) {
        throw new Error('PEDIDO_OU_ASSINATURA_INEXISTENTE');
      }

      // ─────────────────────────────────────────────────────
      // PAGAMENTO DE ALUGUEL
      // ─────────────────────────────────────────────────────

      if (status !== 'approved') {
        if (
          ['pending', 'in_process', 'authorized'].includes(status)
        ) {
          await db.update(paymentsEvents)
            .set({
              processingAt: null,
              failureReason: null,
            })
            .where(eq(paymentsEvents.id, eventRow.id));

          return res.status(200).json({
            ok: true,
            pending: true,
          });
        }

        const terminalOrderStatus =
          status === 'refunded' || status === 'charged_back'
            ? 'REFUNDED'
            : status === 'cancelled'
              ? 'CANCELLED'
              : 'FAILED';

        if (terminalOrderStatus === 'REFUNDED') {
          const [targetOrder] = await db.select()
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1);

          if (targetOrder) {
            await db.transaction(async (tx) => {
              await tx.update(orders)
                .set({ status: 'REFUNDED' })
                .where(eq(orders.id, targetOrder.id));

              await tx.update(rentals)
                .set({ status: 'CANCELLED' })
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
              terminalOrderStatus === 'FAILED' ||
              terminalOrderStatus === 'CANCELLED'
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

      const paidAmount =
        Number(pay.transaction_amount) * 100;

      if (
        Number(order.totalCents) !==
        Math.round(paidAmount)
      ) {
        console.error(
          '[payments][webhook] valor divergente:',
          {
            orderId,
            esperado: order.totalCents,
            pago: paidAmount,
          }
        );

        throw new Error('VALOR_DIVERGENTE');
      }

      if (
        pay.currency_id &&
        order.currency &&
        pay.currency_id !== order.currency
      ) {
        console.error(
          '[payments][webhook] moeda divergente:',
          {
            orderId,
            esperado: order.currency,
            pago: pay.currency_id,
          }
        );

        throw new Error('MOEDA_DIVERGENTE');
      }

      if (order.status === 'PAID') {
        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({
          ok: true,
          alreadyPaid: true,
        });
      }

      // A transição PENDING -> PAID e a criação do aluguel
      // ocorrem na mesma transação.
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
          .returning({
            id: orders.id,
          });

        if (!paidOrder) {
          return {
            alreadyProcessed: true,
            rental: null,
            product: null,
          };
        }

        const [orderItem] = await tx.select()
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id))
          .limit(1);

        if (!orderItem) {
          throw new Error('ITEM_PEDIDO_INEXISTENTE');
        }

        if (orderItem.productType !== 'RENTAL') {
          return {
            alreadyProcessed: false,
            rental: null,
            product: null,
          };
        }

        const [prod] = await tx.select()
          .from(rentalProducts)
          .where(eq(rentalProducts.id, orderItem.productId))
          .limit(1);

        if (
          !prod ||
          !prod.active ||
          !Number.isInteger(prod.durationHours) ||
          prod.durationHours <= 0
        ) {
          throw new Error(
            'PRODUTO_INEXISTENTE_OU_INVALIDO'
          );
        }

        const startedAt = new Date();

        const expiresAt = new Date(
          startedAt.getTime() +
          prod.durationHours * 3600 * 1000
        );

        const [rental] = await tx.insert(rentals)
          .values({
            id: randomUUID(),
            rentalCode:
              `RENT-${randomUUID().slice(0, 8).toUpperCase()}`,
            userId: order.userId,
            trackId: prod.trackId,
            albumId: prod.albumId,
            orderId: order.id,
            status: 'ACTIVE',
            startsAt: startedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          })
          .returning();

        return {
          alreadyProcessed: false,
          rental,
          product: prod,
        };
      });

      if (fulfillment.alreadyProcessed) {
        await db.update(paymentsEvents)
          .set({
            processedAt: new Date().toISOString(),
            processingAt: null,
          })
          .where(eq(paymentsEvents.id, eventRow.id));

        return res.status(200).json({
          ok: true,
          alreadyPaid: true,
        });
      }

      await invalidateAccessCache(order.userId);

      if (fulfillment.rental && fulfillment.product) {
        try {
          const [userRow] = await db.select({
            email: users.email,
          })
            .from(users)
            .where(eq(users.id, order.userId))
            .limit(1);

          if (userRow?.email) {
            await sendRentalConfirmation(
              userRow.email,
              fulfillment.product.name,
              fulfillment.rental.expiresAt
            );
          }
        } catch (emailErr) {
          console.warn(
            '[payments][webhook] falha no e-mail:',
            emailErr.message
          );
        }
      }

    } else if (
      type === 'subscription_preapproval' ||
      type === 'preapproval'
    ) {
      const pre = await mpFetch(
        `/preapproval/${encodeURIComponent(dataId)}`
      );

      const subId = pre.external_reference;

      if (subId) {
        if (pre.status === 'authorized') {
          // Autorização da pré-aprovação não significa pagamento.
          // Não ativa a assinatura e não marca o pedido como pago.
          const [sub] = await db.select()
            .from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(
                subscriptions.externalSubscriptionId,
                String(pre.id)
              )
            ))
            .limit(1);

          if (!sub) {
            throw new Error(
              'ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY'
            );
          }

          // A assinatura continua PENDING até o pagamento aprovado.
        } else if (pre.status === 'paused') {
          const [sub] = await db.select()
            .from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(
                subscriptions.externalSubscriptionId,
                String(pre.id)
              )
            ))
            .limit(1);

          if (!sub) {
            throw new Error(
              'ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY'
            );
          }

          await db.update(subscriptions)
            .set({
              status: 'PAUSED',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(subscriptions.id, subId));

          await invalidateAccessCache(sub.userId);

        } else if (
          pre.status === 'cancelled' ||
          pre.status === 'canceled'
        ) {
          const [sub] = await db.select()
            .from(subscriptions)
            .where(and(
              eq(subscriptions.id, subId),
              eq(
                subscriptions.externalSubscriptionId,
                String(pre.id)
              )
            ))
            .limit(1);

          if (!sub) {
            throw new Error(
              'ASSINATURA_NAO_CORRESPONDE_AO_GATEWAY'
            );
          }

          await db.transaction(async (tx) => {
            await tx.update(subscriptions)
              .set({
                status: 'CANCELLED',
                updatedAt: new Date().toISOString(),
              })
              .where(eq(subscriptions.id, subId));

            if (sub.orderId) {
              await tx.update(orders)
                .set({ status: 'CANCELLED' })
                .where(and(
                  eq(orders.id, sub.orderId),
                  eq(orders.status, 'PENDING')
                ));
            }
          });

          if (sub.userId) {
            await invalidateAccessCache(sub.userId);
          }
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
    console.error(
      '[payments][webhook] erro:',
      err.message,
      err.body || ''
    );

    await db.update(paymentsEvents)
      .set({
        failureReason: String(
          err.message || 'WEBHOOK_ERROR'
        ).slice(0, 500),
        processingAt: null,
      })
      .where(eq(paymentsEvents.id, eventRow.id));

    return res.status(500).json({ ok: false });
  }
}

// ─────────────────────────────────────────────────────────────
// ROTEADOR PRINCIPAL
// ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const allowedOrigin = APP_URL();

  if (allowedOrigin) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      allowedOrigin
    );

    res.setHeader(
      'Access-Control-Allow-Credentials',
      'true'
    );
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, x-signature, x-request-id'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const type = String(req.query.type || '');
  const action = String(req.query.action || '');
  const op = type || action;

  if (op === 'webhook') {
    return handleWebhook(req, res);
  }

  let user = null;

  try {
    user = await getAuthUser(req);
  } catch {
    user = null;
  }

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Não autenticado',
    });
  }

  if (
    req.method !== 'GET' &&
    !checkOrigin(req)
  ) {
    return res.status(403).json({
      ok: false,
      error: 'Origem não permitida.',
    });
  }

  try {
    if (op === 'rental' || op === 'rent') {
      return await handleRental(req, res, user);
    }

    if (
      op === 'subscription' ||
      op === 'subscribe'
    ) {
      return await handleSubscription(req, res, user);
    }

    if (op === 'manage') {
      return await handleManage(req, res, user);
    }

    return res.status(400).json({
      ok: false,
      error: 'Ação inválida',
    });

  } catch (err) {
    if (
      err?.status &&
      err.status >= 400 &&
      err.status < 500
    ) {
      return res.status(err.status).json({
        ok: false,
        error: err.message || 'Requisição inválida.',
        code: err.code || null,
      });
    }

    console.error(
      '[payments] erro:',
      err.message
    );

    return res.status(500).json({
      ok: false,
      error: 'Erro interno',
    });
  }
};
