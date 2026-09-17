/* ============================================================
   api/public.js — TEMPORÁRIO COM DIAGNÓSTICO
   ------------------------------------------------------------
   ⚠️ Esta é uma versão de DEBUG. Depois de descobrir o erro,
      restaura a versão normal.
   ============================================================ */

'use strict';

module.exports = async function handler(req, res) {
  const report = {
    ok: false,
    stage: 'start',
    checks: {}
  };

  // 1) Node version
  try {
    report.node = process.version;
    report.checks.node = 'OK';
  } catch (e) {
    report.checks.node = 'ERRO: ' + e.message;
  }

  // 2) Módulo _lib
  report.stage = 'require _lib';
  let lib;
  try {
    lib = require('./_lib');
    report.checks._lib = 'OK — exports: ' + Object.keys(lib).join(', ');
  } catch (e) {
    report.checks._lib = 'ERRO: ' + (e.message || String(e));
    report.stage = '_lib falhou';
    res.status(500).setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(report, null, 2));
  }

  // 3) Env vars
  report.stage = 'check env';
  const envs = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN'
  ];
  report.checks.env = {};
  for (const name of envs) {
    report.checks.env[name] = process.env[name] ? 'OK' : 'AUSENTE';
  }

  // 4) Testa supabaseAdminRequest
  report.stage = 'supabase query';
  try {
    const result = await lib.supabaseAdminRequest(
      '/rest/v1/site_content?key=eq.default&select=data,version&limit=1',
      { method: 'GET' }
    );
    report.checks.supabase = {
      ok: result.response.ok,
      status: result.response.status,
      body: result.body
    };
  } catch (e) {
    report.checks.supabase = 'ERRO: ' + (e.message || String(e));
    report.stage = 'supabase falhou';
    res.status(500).setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(report, null, 2));
  }

  // 5) Tudo OK — retorna sucesso
  report.ok = true;
  report.stage = 'done';
  res.status(200).setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(report, null, 2));
};
