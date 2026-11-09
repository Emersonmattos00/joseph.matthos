'use strict';

/* ============================================================
   api/_email.js — E-mails transacionais (Resend)
   ------------------------------------------------------------
   - Escape de HTML nos campos dinâmicos
   - APP_URL configurável (não fixo no código)
   - Tratamento centralizado de falhas do Resend
   - Remetente obrigatório em produção
   - Validação de datas
   ============================================================ */

const { Resend } = require('resend');

let resendClient = null;

const APP_URL = String(
  process.env.APP_URL || 'https://josephmatthos.vercel.app'
).trim().replace(/\/+$/, '');

const FROM = String(process.env.RESEND_FROM_EMAIL || '').trim();

function getClient() {
  if (resendClient) return resendClient;

  if (!process.env.RESEND_API_KEY || !FROM) {
    return null;
  }

  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function formatDate(value) {
  if (!value) return 'Não informado';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Não informado';

  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

async function sendEmail(payload) {
  const client = getClient();

  if (!client) {
    console.warn('[email] RESEND_API_KEY ou RESEND_FROM_EMAIL não configurados');
    return { ok: false, skipped: true };
  }

  try {
    const result = await client.emails.send({
      from: FROM,
      ...payload,
    });

    if (result?.error) {
      console.error('[email] Falha no Resend:', result.error);
      return { ok: false, error: result.error };
    }

    return {
      ok: true,
      id: result?.data?.id || null,
    };
  } catch (error) {
    console.error('[email] Erro no envio:', error.message);
    return { ok: false, error: 'EMAIL_SEND_FAILED' };
  }
}

async function sendRentalConfirmation({ userEmail, albumName, trackTitle, expiresAt }) {
  if (!userEmail) {
    return { ok: false, skipped: true };
  }

  const safeAlbum = escapeHtml(albumName);
  const safeTrack = escapeHtml(trackTitle || '');
  const safeDate = escapeHtml(formatDate(expiresAt));

  return sendEmail({
    to: userEmail,
    subject: `Aluguel confirmado — ${safeAlbum}`,
    html: `
      <h2>Seu aluguel está ativo!</h2>
      <p>Você tem acesso completo ao álbum <strong>${safeAlbum}</strong>${safeTrack ? ` — faixa <strong>${safeTrack}</strong>` : ''}.</p>
      <p>Válido até: <strong>${safeDate}</strong></p>
      <p><a href="${APP_URL}">Ouvir agora</a></p>
    `,
  });
}

async function sendSubscriptionConfirmation({ userEmail, planName, currentPeriodEnd }) {
  if (!userEmail) {
    return { ok: false, skipped: true };
  }

  const safePlan = escapeHtml(planName || 'Premium');
  const safeDate = escapeHtml(formatDate(currentPeriodEnd));

  return sendEmail({
    to: userEmail,
    subject: `Assinatura ativada — ${safePlan}`,
    html: `
      <h2>Sua assinatura está ativa!</h2>
      <p>Você agora tem acesso completo à discografia com o plano <strong>${safePlan}</strong>.</p>
      <p>Próxima renovação: <strong>${safeDate}</strong></p>
      <p><a href="${APP_URL}">Ouvir agora</a></p>
    `,
  });
}

async function sendExpirationWarning({ userEmail, planName, currentPeriodEnd }) {
  if (!userEmail) {
    return { ok: false, skipped: true };
  }

  const safePlan = escapeHtml(planName || 'Premium');
  const safeDate = escapeHtml(formatDate(currentPeriodEnd));

  return sendEmail({
    to: userEmail,
    subject: `Sua assinatura ${safePlan} vence em breve`,
    html: `
      <h2>Atenção: sua assinatura vence em breve</h2>
      <p>Plano: <strong>${safePlan}</strong></p>
      <p>Vencimento: <strong>${safeDate}</strong></p>
      <p>Para continuar com acesso completo, <a href="${APP_URL}/#planos">renove agora</a>.</p>
    `,
  });
}

module.exports = {
  sendRentalConfirmation,
  sendSubscriptionConfirmation,
  sendExpirationWarning,
};