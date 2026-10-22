// src/schema.js
// Versão CJS pura — sem bundling do drizzle-kit
'use strict';

const { pgTable, text, uuid, timestamp, integer, boolean, jsonb, pgEnum, date, char, bigserial, index, uniqueIndex, foreignKey } = require('drizzle-orm/pg-core');
const { sql } = require('drizzle-orm');

// ─── Enums ──────────────────────────────────────────
const orderStatus = pgEnum('OrderStatus', ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED']);
const productType = pgEnum('ProductType', ['RENTAL', 'SUBSCRIPTION']);
const rentalStatus = pgEnum('RentalStatus', ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED']);
const subscriptionStatus = pgEnum('SubscriptionStatus', ['PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'PAST_DUE']);
const trackStatus = pgEnum('TrackStatus', ['DRAFT', 'PUBLISHED', 'ARCHIVED']);
const userRole = pgEnum('UserRole', ['CUSTOMER', 'ADMIN']);

// ─── Users ──────────────────────────────────────────
const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull(),
  passwordHash: text('password_hash'),
  name: text().notNull(),
  role: userRole().default('CUSTOMER').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'string' })
}, (t) => [uniqueIndex('users_email_key').on(t.email)]);

// ─── Artists ──────────────────────────────────────────
const artists = pgTable('artists', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  bio: text(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  imageUrl: text('image_url'),
  slug: text()
}, (t) => [
  uniqueIndex('artists_name_key').on(t.name),
  uniqueIndex('artists_slug_key').on(t.slug)
]);

// ─── Albums ──────────────────────────────────────────
const albums = pgTable('albums', {
  id: uuid().primaryKey().defaultRandom(),
  title: text().notNull(),
  slug: text().notNull(),
  releaseDate: date('release_date'),
  artistId: uuid('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  coverUrl: text('cover_url'),
  sortOrder: integer('sort_order').default(0).notNull(),
  upc: text(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  artist: text(),
  year: integer(),
  type: text().default('album'),
  description: text(),
  published: boolean().default(false),
  coverInitials: text('cover_initials'),
  orderIndex: integer('order_index').default(0)
}, (t) => [
  index('albums_artist_id_idx').on(t.artistId),
  uniqueIndex('albums_slug_key').on(t.slug),
  index('albums_sort_order_idx').on(t.sortOrder)
]);

// ─── Tracks ──────────────────────────────────────────
const tracks = pgTable('tracks', {
  id: uuid().primaryKey().defaultRandom(),
  albumId: uuid('album_id').references(() => albums.id, { onDelete: 'set null' }),
  artistId: uuid('artist_id').notNull().references(() => artists.id, { onDelete: 'restrict' }),
  title: text().notNull(),
  slug: text().notNull(),
  isrc: text(),
  upc: text(),
  genre: text(),
  mood: text(),
  durationSeconds: integer('duration_seconds'),
  status: trackStatus().default('DRAFT').notNull(),
  previewKey: text('preview_key'),
  streamKey: text('stream_key'),
  masterKey: text('master_key'),
  lyrics: jsonb().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  trackNumber: integer('track_number'),
  fullPath: text('full_path'),
  previewPath: text('preview_path')
}, (t) => [
  index('tracks_album_id_idx').on(t.albumId),
  index('tracks_album_id_track_number_idx').on(t.albumId, t.trackNumber),
  index('tracks_artist_id_idx').on(t.artistId),
  uniqueIndex('tracks_slug_key').on(t.slug),
  index('tracks_status_idx').on(t.status)
]);

// ─── Plans ──────────────────────────────────────────
const plans = pgTable('plans', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char({ length: 3 }).default('BRL').notNull(),
  intervalUnit: text('interval_unit').notNull(),
  intervalCount: integer('interval_count').default(1).notNull(),
  active: boolean().default(true).notNull(),
  externalPlanId: text('external_plan_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull()
}, (t) => [uniqueIndex('plans_name_key').on(t.name)]);

// ─── Subscriptions ──────────────────────────────────
const subscriptions = pgTable('subscriptions', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  planId: uuid('plan_id').notNull().references(() => plans.id, { onDelete: 'restrict' }),
  externalSubscriptionId: text('external_subscription_id'),
  status: subscriptionStatus().default('PENDING').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true, mode: 'string' }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true, mode: 'string' }),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  initPoint: text('init_point'),
  payerEmail: text('payer_email')
}, (t) => [
  index('idx_subscriptions_status').on(t.status),
  index('idx_subscriptions_user').on(t.userId),
  index('idx_subscriptions_user_status').on(t.userId, t.status),
  uniqueIndex('subscriptions_external_subscription_id_key').on(t.externalSubscriptionId)
]);

// ─── Rentals ──────────────────────────────────────────
const rentals = pgTable('rentals', {
  id: uuid().primaryKey().defaultRandom(),
  rentalCode: text('rental_code').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
  albumId: uuid('album_id').references(() => albums.id, { onDelete: 'set null' }),
  orderId: uuid('order_id'),
  status: rentalStatus().default('PENDING').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true, mode: 'string' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull()
}, (t) => [
  index('idx_rentals_user_track').on(t.userId, t.trackId),
  index('rentals_album_id_idx').on(t.albumId),
  uniqueIndex('rentals_rental_code_key').on(t.rentalCode),
  index('rentals_track_id_idx').on(t.trackId),
  index('rentals_user_id_idx').on(t.userId)
]);

// ─── Rental Products ──────────────────────────────────
const rentalProducts = pgTable('rental_products', {
  id: uuid().primaryKey().defaultRandom(),
  trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'cascade' }),
  albumId: uuid('album_id').references(() => albums.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  durationHours: integer('duration_hours').notNull(),
  priceCents: integer('price_cents').notNull(),
  currency: char({ length: 3 }).default('BRL').notNull(),
  active: boolean().default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull()
}, (t) => [
  index('rental_products_album_id_idx').on(t.albumId),
  index('rental_products_track_id_idx').on(t.trackId)
]);

// ─── Site Content ──────────────────────────────────
const siteContent = pgTable('site_content', {
  key: text().primaryKey().notNull(),
  data: jsonb().default({}).notNull(),
  version: integer().default(0).notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
});

const siteContentHistory = pgTable('site_content_history', {
  id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
  key: text().notNull(),
  data: jsonb().notNull(),
  version: integer().notNull(),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
}, (t) => [index('idx_content_history_key').on(t.key, t.createdAt)]);

// ─── Audit ──────────────────────────────────────────
const adminAudit = pgTable('admin_audit', {
  id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
  actor: text(),
  action: text().notNull(),
  target: text(),
  metadata: jsonb(),
  ip: text(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
});

const authAuditLog = pgTable('auth_audit_log', {
  id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
  event: text().notNull(),
  emailHash: text('email_hash'),
  userId: uuid('user_id'),
  ip: text(),
  userAgent: text('user_agent'),
  success: boolean().notNull(),
  reason: text(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
});

// ─── Payments ──────────────────────────────────────
const paymentsEvents = pgTable('payments_events', {
  id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
  provider: text().default('mercadopago').notNull(),
  providerEvent: text('provider_event').notNull(),
  eventType: text('event_type').notNull(),
  externalId: text('external_id'),
  payload: jsonb().notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull()
});

// ─── Orders ──────────────────────────────────────────
const orders = pgTable('orders', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: orderStatus().default('PENDING').notNull(),
  totalCents: integer('total_cents').notNull(),
  currency: char({ length: 3 }).default('BRL').notNull(),
  externalPaymentId: text('external_payment_id'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true, mode: 'string' })
}, (t) => [uniqueIndex('orders_idempotency_key_key').on(t.idempotencyKey), index('orders_user_id_idx').on(t.userId)]);

const orderItems = pgTable('order_items', {
  id: uuid().primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productType: productType('product_type').notNull(),
  productId: uuid('product_id'),
  quantity: integer().default(1).notNull(),
  unitPriceCents: integer('unit_price_cents').notNull()
});

// ─── Outros (mantidos para compatibilidade) ──────────────
const refreshTokens = pgTable('refresh_tokens', { id: uuid().primaryKey().defaultRandom() });
const passwordResetTokens = pgTable('password_reset_tokens', { id: uuid().primaryKey().defaultRandom() });
const emailVerificationTokens = pgTable('email_verification_tokens', { id: uuid().primaryKey().defaultRandom() });
const newsletterSubscribers = pgTable('newsletter_subscribers', { id: uuid().primaryKey().defaultRandom() });
const socialLinks = pgTable('social_links', { id: uuid().primaryKey().defaultRandom() });
const playbackEvents = pgTable('playback_events', { id: bigserial({ mode: 'bigint' }).primaryKey().notNull() });
const prismaMigrations = pgTable('_prisma_migrations', { id: text().primaryKey() });

// ─── Exporta tudo ──────────────────────────────────────
module.exports = {
  adminAudit, albums, artists, authAuditLog, emailVerificationTokens,
  newsletterSubscribers, orderItems, orderStatus, orders, passwordResetTokens,
  paymentsEvents, plans, playbackEvents, prismaMigrations, productType,
  refreshTokens, rentalProducts, rentalStatus, rentals, siteContent,
  siteContentHistory, socialLinks, subscriptionStatus, subscriptions,
  trackStatus, tracks, userRole, users
};