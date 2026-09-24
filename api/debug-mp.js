/* ============================================================
   api/debug-mp.js — Diagnóstico do Mercado Pago
   ------------------------------------------------------------
   ⚠️ APAGAR após resolver o problema.
   ============================================================ */

'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  const backUrl = String(process.env.MP_BACK_URL || '').trim();
  const env = String(process.env.MP_ENV || 'production').trim();
  const monthlyPrice = String(process.env.MP_PREMIUM_MONTHLY_PRICE || '').trim();

  const tokenPrefix = token.slice(0, 10);
  const tokenLength = token.length;
  const tokenHasWhitespace = /\s/.test(token);

  const result = {
    ok: true,
    config: {
      tokenPrefix,
      tokenLength,
      tokenHasWhitespace,
      backUrl,
      env,
      monthlyPrice,
      backUrlIsHttps: backUrl.startsWith('https://'),
      tokenIsProduction: token.startsWith('APP_USR-'),
      tokenIsTest: token.startsWith('TEST-'),
      envIsProduction: env === 'production',
      envIsSandbox: env === 'sandbox'
    }
  };

  if (!token) {
    result.error = 'MP_ACCESS_TOKEN ausente';
    return res.status(200).json(result);
  }

  // ── Teste 1: buscar o user do MP (GET /users/me)
  try {
    const meRes = await fetch('https://api.mercadopago.com/users/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });

    const meBody = await meRes.text();

    result.test1_getMe = {
      status: meRes.status,
      ok: meRes.ok,
      body: meBody.slice(0, 500)
    };
  } catch (err) {
    result.test1_getMe = {
      error: err.message
    };
  }

  // ── Teste 2: tentar criar um preapproval
  if (backUrl && monthlyPrice) {
    try {
      const payload = {
        reason: 'Teste de diagnóstico',
        external_reference: 'diag_' + Date.now(),
        payer_email: 'emerson.mattos01@gmail.com',
        back_url: backUrl,
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: Number(monthlyPrice),
          currency_id: 'BRL'
        }
      };

      const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const mpBody = await mpRes.text();

      result.test2_preapproval = {
        status: mpRes.status,
        ok: mpRes.ok,
        payloadSent: payload,
        body: mpBody.slice(0, 800)
      };
    } catch (err) {
      result.test2_preapproval = {
        error: err.message
      };
    }
  } else {
    result.test2_preapproval = {
      skipped: true,
      reason: !backUrl ? 'MP_BACK_URL ausente' : 'MP_PREMIUM_MONTHLY_PRICE ausente'
    };
  }

  return res.status(200).json(result);
};
