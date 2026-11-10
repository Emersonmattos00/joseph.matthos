'use strict';

/* ============================================================
   api/_email.js — E-mails transacionais (Resend)
   ------------------------------------------------------------
   - Escape de HTML em todos os campos dinâmicos
   - Validação de destinatário, remetente, datas e URLs
   - APP_URL configurável (não hardcoded)
   - Remetente obrigatório em produção
   - Tratamento unificado de erros do SDK Resend
   ============================================================ */

const { Resend } = require('resend');

const IS_PROD = process.env.NODE_ENV === 'production';

let resendClient = null;

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
function getAppUrl() {
  const value = String(process.env.APP_URL || '').trim();

  if (!value) {
    if (IS_PROD) throw new Error('APP_URL não configurada.');
    return 'http://localhost:3000';
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('APP_URL inválida.');
  }

  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (IS_PROD && parsed.protocol !== 'https:')
  ) {
    throw new Error('APP_URL não é segura.');
  }

  return parsed.origin;
}

function getFromEmail() {
  const from = String(process.env.RESEND_FROM_EMAIL || '').trim();

  if (!from) {
    if (IS_PROD) throw new Error('RESEND_FROM_EMAIL não configurado.');
    return 'Joseph Matthos <onboarding@resend.dev>';
  }

  if (/[\r\n]/.test(from)) {
    throw new Error('Remetente de e-mail inválido.');
  }

  return from;
}

// ─────────────────────────────────────────────────────────────
// CLIENTE RESEND
// ─────────────────────────────────────────────────────────────
function getClient() {
  if (resendClient) return resendClient;

  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) throw new Error('RESEND_API_KEY não configurada.');

  resendClient = new Resend(apiKey);
  return resendClient;
}

// ─────────────────────────────────────────────────────────────
// VALIDAÇÕES
// ─────────────────────────────────────────────────────────────
function validateEmail(email) {
  if (typeof email !== 'string' || email.length > 254) {
    throw new TypeError('Destinatário inválido.');
  }
  const normalized = email.trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) {
    throw new TypeError('Endereço de e-mail inválido.');
  }
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatDate(value) {
  if (!value) return 'Não informada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Não informada';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  }).format(date);
}

function validateText(value, field, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new TypeError(`${field} inválido.`);
  }
  return value.trim();
}

function validateDays(daysLeft) {
  if (!Number.isSafeInteger(daysLeft) || daysLeft < 0 || daysLeft > 365) {
    throw new TypeError('Quantidade de dias inválida.');
  }
  return daysLeft;
}

// ─────────────────────────────────────────────────────────────
// ENVIO CENTRALIZADO
// ─────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const recipient = validateEmail(to);
  const client = getClient();

  const result = await client.emails.send({
    from: getFromEmail(),
    to: recipient,
    subject,
    html
  });

  if (result?.error) {
    console.error(
      '[email] Erro retornado pelo Resend:',
      result.error.name || 'SEND_ERROR',
      result.error.message || ''
    );
    throw new Error('Não foi possível enviar o e-mail.');
  }

  if (!result?.data?.id) {
    throw new Error('O Resend não confirmou o envio.');
  }

  return { ok: true, id: result.data.id };
}

// ─────────────────────────────────────────────────────────────
// TEMPLATE VISUAL
// ─────────────────────────────────────────────────────────────
function emailTemplate(title, content) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:30px 15px;background:#101010;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
         style="max-width:600px;margin:auto;background:#1b1b1b;border-radius:12px;">
    <tr>
      <td style="padding:35px 25px;text-align:center;">
        <h1 style="color:#d4af37;font-size:25px;margin:0;">JOSEPH MATTHOS</h1>
        <div style="height:1px;background:#393939;margin:25px 0;"></div>
        <h2 style="color:#ffffff;font-size:21px;">${escapeHtml(title)}</h2>
        <div style="color:#dddddd;font-size:15px;line-height:1.8;text-align:left;">
          ${content}
        </div>
        <p style="margin-top:35px;">
          <a href="${escapeHtml(getAppUrl())}"
             style="display:inline-block;padding:14px 25px;background:#d4af37;color:#111111;
                    text-decoration:none;border-radius:6px;font-weight:bold;">
            Acessar minha conta
          </a>
        </p>
        <p style="color:#888888;font-size:12px;margin-top:30px;">
          Joseph Matthos — Música, arte e expressão.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// CONFIRMAÇÃO DE ALUGUEL
// ─────────────────────────────────────────────────────────────
async function sendRentalConfirmation(userEmail, albumName, expiresAt) {
  const album = escapeHtml(validateText(albumName, 'Nome do álbum'));
  const expiration = escapeHtml(formatDate(expiresAt));

  return sendEmail({
    to: userEmail,
    subject: 'Aluguel confirmado — Joseph Matthos',
    html: emailTemplate('Aluguel confirmado!', `
      <p>Seu aluguel foi confirmado com sucesso.</p>
      <p>Você tem acesso completo ao álbum <strong>${album}</strong>.</p>
      <p>Validade do acesso: <strong>${expiration}</strong></p>
      <p>Aproveite sua experiência musical!</p>
    `)
  });
}

// ─────────────────────────────────────────────────────────────
// CONFIRMAÇÃO DE ASSINATURA
// ─────────────────────────────────────────────────────────────
async function sendSubscriptionConfirmation(userEmail, planName, expiresAt) {
  const plan = escapeHtml(validateText(planName, 'Nome do plano'));
  const expiration = escapeHtml(formatDate(expiresAt));

  return sendEmail({
    to: userEmail,
    subject: 'Assinatura ativada — Joseph Matthos',
    html: emailTemplate('Bem-vindo ao Premium!', `
      <p>Sua assinatura foi ativada com sucesso.</p>
      <p>Plano contratado: <strong>${plan}</strong></p>
      <p>Validade: <strong>${expiration}</strong></p>
      <p>Obrigado por apoiar o trabalho musical de Joseph Matthos.</p>
    `)
  });
}

// ─────────────────────────────────────────────────────────────
// AVISO DE EXPIRAÇÃO
// ─────────────────────────────────────────────────────────────
async function sendExpirationWarning(userEmail, daysLeft) {
  const days = validateDays(daysLeft);
  const dayText = days === 1 ? 'dia' : 'dias';

  return sendEmail({
    to: userEmail,
    subject: 'Aviso sobre sua assinatura — Joseph Matthos',
    html: emailTemplate('Sua assinatura está próxima do vencimento', `
      <p>Sua assinatura expira em <strong>${days} ${dayText}</strong>.</p>
      <p>Renove sua assinatura para continuar aproveitando os benefícios Premium.</p>
    `)
  });
}

// ─────────────────────────────────────────────────────────────
// EXPORTAÇÕES
// ─────────────────────────────────────────────────────────────
module.exports = {
  sendRentalConfirmation,
  sendSubscriptionConfirmation,
  sendExpirationWarning
};