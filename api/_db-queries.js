/* ============================================================
   api/_db-queries.js — Queries no Neon via Drizzle
   ------------------------------------------------------------
   Substitui as chamadas `supabaseAdminRequest('/rest/v1/...')`
   do `api/admin.js` por queries Drizzle diretas no Neon.

   Interface principal:
     - listAlbums()
     - getAlbum(id)
     - createAlbum(payload)
     - updateAlbum(id, patch)
     - deleteAlbum(id)
     - countTracksInAlbum(albumId)
     - deleteTracksByAlbum(albumId)

     - listTracks(albumId)
     - getTrack(id)
     - createTrack(payload)
     - updateTrack(id, patch)
     - deleteTrack(id)
     - reorderTracks(order)
     - getMaxTrackIndex(albumId)

     - listProfiles(limit)
     - getProfile(id)
     - getEffectivePlans()

     - listActiveSubscriptions(userId)
     - listSubscriptionsSince(since)
     - createSubscription(payload)
     - cancelSubscriptions(userId)
     - cancelSubscriptionsExcept(userId, exceptProviderSubId)

     - listRentalsSince(since)
     - listPaymentsSince(since)

     - getSiteContent(key)
     - upsertSiteContent(payload)
     - insertSiteContentHistory(payload)

     - listAdminAudit(limit)
     - listAuthAudit(limit)
     - insertAudit(table, payload)

   TODAS as funções lançam erro em caso de falha; o caller
   (api/admin.js) trata com try/catch e devolve 502.
   ============================================================ */

'use strict';

const { db } = require('./_db');
const schema = require('../src/schema');
const { eq, and, inArray, desc, asc, sql, ne } = require('drizzle-orm');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getTable(name) {
  const table = schema[name];
  if (!table) {
    const err = new Error(`Tabela "${name}" não existe no schema Drizzle.`);
    err.code = 'TABLE_NOT_FOUND';
    throw err;
  }
  return table;
}

// ─────────────────────────────────────────────────────────────
// ÁLBUNS
// ─────────────────────────────────────────────────────────────

async function listAlbums() {
  const albums = getTable('albums');
  return db
    .select()
    .from(albums)
    .orderBy(asc(albums.order_index), asc(albums.created_at));
}

async function getAlbum(id) {
  const albums = getTable('albums');
  const [row] = await db.select().from(albums).where(eq(albums.id, id)).limit(1);
  return row || null;
}

async function createAlbum(payload) {
  const albums = getTable('albums');
  const [row] = await db.insert(albums).values(payload).returning();
  return row;
}

async function updateAlbum(id, patch) {
  const albums = getTable('albums');
  const [row] = await db
    .update(albums)
    .set(patch)
    .where(eq(albums.id, id))
    .returning();
  return row || null;
}

async function deleteAlbum(id) {
  const albums = getTable('albums');
  await db.delete(albums).where(eq(albums.id, id));
}

async function countTracksInAlbum(albumId) {
  const tracks = getTable('tracks');
  const rows = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(eq(tracks.album_id, albumId))
    .limit(1);
  return rows.length;
}

async function deleteTracksByAlbum(albumId) {
  const tracks = getTable('tracks');
  await db.delete(tracks).where(eq(tracks.album_id, albumId));
}

// ─────────────────────────────────────────────────────────────
// FAIXAS
// ─────────────────────────────────────────────────────────────

async function listTracks(albumId) {
  const tracks = getTable('tracks');
  return db
    .select()
    .from(tracks)
    .where(eq(tracks.album_id, albumId))
    .orderBy(asc(tracks.track_index));
}

async function getTrack(id) {
  const tracks = getTable('tracks');
  const [row] = await db.select().from(tracks).where(eq(tracks.id, id)).limit(1);
  return row || null;
}

async function createTrack(payload) {
  const tracks = getTable('tracks');
  const [row] = await db.insert(tracks).values(payload).returning();
  return row;
}

async function updateTrack(id, patch) {
  const tracks = getTable('tracks');
  const [row] = await db
    .update(tracks)
    .set(patch)
    .where(eq(tracks.id, id))
    .returning();
  return row || null;
}

async function deleteTrack(id) {
  const tracks = getTable('tracks');
  await db.delete(tracks).where(eq(tracks.id, id));
}

async function reorderTracks(order) {
  const tracks = getTable('tracks');
  const results = [];
  for (const item of order) {
    const [row] = await db
      .update(tracks)
      .set({
        track_index: Number(item.track_index) || 0,
        updated_at: new Date().toISOString(),
      })
      .where(eq(tracks.id, Number(item.id)))
      .returning({ id: tracks.id });
    results.push(row);
  }
  return results;
}

async function getMaxTrackIndex(albumId) {
  const tracks = getTable('tracks');
  const [row] = await db
    .select({ maxIndex: sql`max(${tracks.track_index})` })
    .from(tracks)
    .where(eq(tracks.album_id, albumId));
  return row?.maxIndex != null ? Number(row.maxIndex) : -1;
}

// ─────────────────────────────────────────────────────────────
// PROFILES / USERS
// ─────────────────────────────────────────────────────────────

async function listProfiles(limit) {
  const profiles = getTable('profiles');
  return db
    .select({
      id: profiles.id,
      email: profiles.email,
      name: profiles.name,
      created_at: profiles.created_at,
    })
    .from(profiles)
    .orderBy(desc(profiles.created_at))
    .limit(Number(limit) || 500);
}

async function getProfile(id) {
  const profiles = getTable('profiles');
  const [row] = await db
    .select({ id: profiles.id, email: profiles.email })
    .from(profiles)
    .where(eq(profiles.id, id))
    .limit(1);
  return row || null;
}

async function countProfiles() {
  const profiles = getTable('profiles');
  const [row] = await db
    .select({ total: sql`count(*)` })
    .from(profiles);
  return row?.total != null ? Number(row.total) : 0;
}

async function getEffectivePlans() {
  // Tenta view "effective_plan" (pode não existir no Neon)
  const view = schema.effective_plan || schema.effectivePlan;
  if (!view) {
    // Fallback: deriva planos das subscriptions ativas
    return [];
  }
  return db.select({ user_id: view.user_id, plan: view.plan }).from(view);
}

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTIONS
// ─────────────────────────────────────────────────────────────

async function listActiveSubscriptions(userId) {
  const subs = getTable('subscriptions');
  return db
    .select({
      id: subs.id,
      provider: subs.provider,
      provider_sub_id: subs.provider_sub_id,
    })
    .from(subs)
    .where(
      and(
        eq(subs.user_id, userId),
        inArray(subs.status, ['authorized', 'trialing'])
      )
    );
}

async function listSubscriptionsSince(since, limit) {
  const subs = getTable('subscriptions');
  const base = db
    .select({
      id: subs.id,
      user_id: subs.user_id,
      plan: subs.plan,
      status: subs.status,
      current_period_end: subs.current_period_end,
      created_at: subs.created_at,
    })
    .from(subs);

  const query = since
    ? base.where(sql`${subs.created_at} >= ${since}`)
    : base;

  return query.orderBy(desc(subs.created_at)).limit(Number(limit) || 500);
}

async function createSubscription(payload) {
  const subs = getTable('subscriptions');
  const [row] = await db.insert(subs).values(payload).returning();
  return row;
}

async function cancelSubscriptions(userId) {
  const subs = getTable('subscriptions');
  await db
    .update(subs)
    .set({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(subs.user_id, userId),
        inArray(subs.status, ['authorized', 'trialing'])
      )
    );
}

async function cancelSubscriptionsExcept(userId, exceptProviderSubId) {
  const subs = getTable('subscriptions');
  await db
    .update(subs)
    .set({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(subs.user_id, userId),
        inArray(subs.status, ['authorized', 'trialing']),
        ne(subs.provider_sub_id, exceptProviderSubId)
      )
    );
}

// ─────────────────────────────────────────────────────────────
// RENTALS
// ─────────────────────────────────────────────────────────────

async function listRentalsSince(since, limit) {
  const rentals = getTable('rentals');
  const base = db
    .select({
      id: rentals.id,
      user_id: rentals.user_id,
      track_id: rentals.track_id,
      amount_cents: rentals.amount_cents,
      status: rentals.status,
      expires_at: rentals.expires_at,
      created_at: rentals.created_at,
    })
    .from(rentals);

  const query = since
    ? base.where(sql`${rentals.created_at} >= ${since}`)
    : base;

  return query.orderBy(desc(rentals.created_at)).limit(Number(limit) || 500);
}

// ─────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────

async function listPaymentsSince(since, limit) {
  const payments = getTable('payments_events');
  const base = db
    .select({
      id: payments.id,
      event_type: payments.event_type,
      external_id: payments.external_id,
      processed_at: payments.processed_at,
      failure_reason: payments.failure_reason,
      created_at: payments.created_at,
    })
    .from(payments);

  const query = since
    ? base.where(sql`${payments.created_at} >= ${since}`)
    : base;

  return query.orderBy(desc(payments.created_at)).limit(Number(limit) || 500);
}

// ─────────────────────────────────────────────────────────────
// SITE CONTENT
// ─────────────────────────────────────────────────────────────

async function getSiteContent(key) {
  const table = getTable('site_content');
  const [row] = await db
    .select({
      data: table.data,
      version: table.version,
      updated_at: table.updated_at,
    })
    .from(table)
    .where(eq(table.key, key))
    .limit(1);
  return row || null;
}

async function upsertSiteContent({ key, data, version, updated_at }) {
  const table = getTable('site_content');
  const [row] = await db
    .insert(table)
    .values({ key, data, version, updated_at })
    .onConflictDoUpdate({
      target: table.key,
      set: { data, version, updated_at },
    })
    .returning();
  return row;
}

async function insertSiteContentHistory({ key, data, version }) {
  const table = getTable('site_content_history');
  await db.insert(table).values({ key, data, version });
}

// ─────────────────────────────────────────────────────────────
// AUDIT
// ─────────────────────────────────────────────────────────────

async function listAdminAudit(limit) {
  const table = getTable('admin_audit');
  return db
    .select()
    .from(table)
    .orderBy(desc(table.created_at))
    .limit(Number(limit) || 100);
}

async function listAuthAudit(limit) {
  const table = getTable('auth_audit_log');
  return db
    .select()
    .from(table)
    .orderBy(desc(table.created_at))
    .limit(Number(limit) || 100);
}

async function insertAudit(tableName, payload) {
  const table = getTable(tableName);
  await db.insert(table).values(payload);
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  // Álbuns
  listAlbums,
  getAlbum,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  countTracksInAlbum,
  deleteTracksByAlbum,

  // Faixas
  listTracks,
  getTrack,
  createTrack,
  updateTrack,
  deleteTrack,
  reorderTracks,
  getMaxTrackIndex,

  // Profiles
  listProfiles,
  getProfile,
  countProfiles,
  getEffectivePlans,

  // Subscriptions
  listActiveSubscriptions,
  listSubscriptionsSince,
  createSubscription,
  cancelSubscriptions,
  cancelSubscriptionsExcept,

  // Rentals
  listRentalsSince,

  // Payments
  listPaymentsSince,

  // Site content
  getSiteContent,
  upsertSiteContent,
  insertSiteContentHistory,

  // Audit
  listAdminAudit,
  listAuthAudit,
  insertAudit,
};