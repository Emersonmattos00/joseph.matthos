/**
 * Módulo de e-mails transacionais — Resend
 */
const { Resend } = require('resend');

let resendClient = null;
function getClient() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'Joseph Matthos <onboarding@resend.dev>';

async function sendRentalConfirmation(userEmail, albumName, expiresAt) {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY não configurada');
    return null;
  }

  const data = expiresAt
    ? new Date(expiresAt).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric',
      })
    : '—';

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: 'Aluguel confirmado — ' + albumName,
    html: [
      '<h2>Aluguel confirmado!</h2>',
      '<p>Você tem acesso completo ao álbum <strong>' + albumName + '</strong>.</p>',
      '<p>Válido até: <strong>' + data + '</strong></p>',
      '<p><a href="https://josephmatthos.vercel.app">Ouvir agora</a></p>',
    ].join(''),
  });
}

async function sendSubscriptionConfirmation(userEmail, planName, expiresAt) {
  const client = getClient();
  if (!client) {
    console.warn('[email] RESEND_API_KEY não configurada');
    return null;
  }

  const data = expiresAt
    ? new Date(expiresAt).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric',
      })
    : '—';

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: 'Assinatura ativada — ' + planName,
    html: [
      '<h2>Bem-vindo ao Premium!</h2>',
      '<p>Sua assinatura <strong>' + planName + '</strong> está ativa.</p>',
      '<p>Válida até: <strong>' + data + '</strong></p>',
      '<p><a href="https://josephmatthos.vercel.app">Aproveitar agora</a></p>',
    ].join(''),
  });
}

async function sendExpirationWarning(userEmail, daysLeft) {
  const client = getClient();
  if (!client) return null;

  return client.emails.send({
    from: FROM,
    to: userEmail,
    subject: 'Sua assinatura expira em ' + daysLeft + ' dias',
    html: [
      '<h2>Não perca o acesso!</h2>',
      '<p>Sua assinatura expira em <strong>' + daysLeft + ' dias</strong>.</p>',
      '<p><a href="https://josephmatthos.vercel.app">Renovar agora</a></p>',
    ].join(''),
  });
}

module.exports = {
  sendRentalConfirmation,
  sendSubscriptionConfirmation,
  sendExpirationWarning,
};
