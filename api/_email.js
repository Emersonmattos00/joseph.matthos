/**
 * Módulo de e-mails transacionais — Resend
 * 
 * CORREÇÕES APLICADAS:
 * - URL dinâmica baseada em APP_URL (não mais fixa no Vercel)
 * - Escape de HTML para evitar injeção de conteúdo nos e-mails
 */

'use strict';

const { Resend } = require('resend');

let resendClient = null;

function getClient() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'Joseph Matthos <onboarding@resend.dev>';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Retorna a URL base do site (APP_URL ou PUBLIC_SITE_URL).
 * Lança erro se não estiver configurada.
 */
function getAppUrl() {
  const url = String(process.env.APP_URL || process.env.PUBLIC_SITE_URL || '').trim();
  if (!url) {
    throw new Error('[email] APP_URL não configurada. E-mails não podem ser enviados sem ela.');
  }
  return url.replace(/\/+$/, '');
}

/**
 * Escapa caracteres HTML para evitar injeção de conteúdo.
 */
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]
  );
}

function formatDate(isoDate) {
  if (!isoDate) return '—';
  try {
    return new Date(isoDate).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

// ─────────────────────────────────────────────────────────────
// Envio de e-mails
// ─────────────────────────────────────────────────────────────

async function sendRentalConfirmation(userEmail, albumName, expiresAt) {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY não configurada');
    return null;
  }

  const base = getAppUrl();
  const data = formatDate(expiresAt);
  const safeAlbum = escapeHtml(albumName);

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: `Aluguel confirmado — ${safeAlbum}`,
    html: [
      '<h2>Aluguel confirmado!</h2>',
      `<p>Você tem acesso completo ao álbum <strong>${safeAlbum}</strong>.</p>`,
      `<p>Válido até: <strong>${data}</strong></p>`,
      `<p><a href="${base}/">Ouvir agora</a></p>`,
    ].join(''),
  });
}

async function sendSubscriptionConfirmation(userEmail, planName, expiresAt) {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY não configurada');
    return null;
  }

  const base = getAppUrl();
  const data = formatDate(expiresAt);
  const safePlan = escapeHtml(planName);

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: `Assinatura ativada — ${safePlan}`,
    html: [
      '<h2>Bem-vindo ao Premium!</h2>',
      `<p>Sua assinatura <strong>${safePlan}</strong> está ativa.</p>`,
      `<p>Válida até: <strong>${data}</strong></p>`,
      `<p><a href="${base}/">Aproveitar agora</a></p>`,
    ].join(''),
  });
}

async function sendExpirationWarning(userEmail, daysLeft) {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY não configurada');
    return null;
  }

  const base = getAppUrl();
  const safeDays = escapeHtml(String(daysLeft));

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: `Sua assinatura expira em ${safeDays} dias`,
    html: [
      '<h2>Não perca o acesso!</h2>',
      `<p>Sua assinatura expira em <strong>${safeDays} dias</strong>.</p>`,
      `<p><a href="${base}/">Renovar agora</a></p>`,
    ].join(''),
  });
}

module.exports = {
  sendRentalConfirmation,
  sendSubscriptionConfirmation,
  sendExpirationWarning,
};