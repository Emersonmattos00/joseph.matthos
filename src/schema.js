var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var schema_exports = {};
__export(schema_exports, {
  adminAudit: () => adminAudit,
  albums: () => albums,
  artists: () => artists,
  authAuditLog: () => authAuditLog,
  emailVerificationTokens: () => emailVerificationTokens,
  newsletterSubscribers: () => newsletterSubscribers,
  orderItems: () => orderItems,
  orderStatus: () => orderStatus,
  orders: () => orders,
  passwordResetTokens: () => passwordResetTokens,
  paymentEvents: () => paymentEvents,
  paymentsEvents: () => paymentsEvents,
  plans: () => plans,
  playbackEvents: () => playbackEvents,
  prismaMigrations: () => prismaMigrations,
  productType: () => productType,
  refreshTokens: () => refreshTokens,
  rentalProducts: () => rentalProducts,
  rentalStatus: () => rentalStatus,
  rentals: () => rentals,
  siteContent: () => siteContent,
  siteContentHistory: () => siteContentHistory,
  socialLinks: () => socialLinks,
  subscriptionStatus: () => subscriptionStatus,
  subscriptions: () => subscriptions,
  trackStatus: () => trackStatus,
  tracks: () => tracks,
  userRole: () => userRole,
  users: () => users
});
module.exports = __toCommonJS(schema_exports);
var import_pg_core = require("drizzle-orm/pg-core");
var import_drizzle_orm = require("drizzle-orm");
const orderStatus = (0, import_pg_core.pgEnum)("OrderStatus", ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED"]);
const productType = (0, import_pg_core.pgEnum)("ProductType", ["RENTAL", "SUBSCRIPTION"]);
const rentalStatus = (0, import_pg_core.pgEnum)("RentalStatus", ["PENDING", "ACTIVE", "EXPIRED", "CANCELLED"]);
const subscriptionStatus = (0, import_pg_core.pgEnum)("SubscriptionStatus", ["PENDING", "ACTIVE", "PAUSED", "CANCELLED", "EXPIRED", "PAST_DUE"]);
const trackStatus = (0, import_pg_core.pgEnum)("TrackStatus", ["DRAFT", "PUBLISHED", "ARCHIVED"]);
const userRole = (0, import_pg_core.pgEnum)("UserRole", ["CUSTOMER", "ADMIN"]);
const prismaMigrations = (0, import_pg_core.pgTable)("_prisma_migrations", {
  id: (0, import_pg_core.varchar)({ length: 36 }).primaryKey().notNull(),
  checksum: (0, import_pg_core.varchar)({ length: 64 }).notNull(),
  finishedAt: (0, import_pg_core.timestamp)("finished_at", { withTimezone: true, mode: "string" }),
  migrationName: (0, import_pg_core.varchar)("migration_name", { length: 255 }).notNull(),
  logs: (0, import_pg_core.text)(),
  rolledBackAt: (0, import_pg_core.timestamp)("rolled_back_at", { withTimezone: true, mode: "string" }),
  startedAt: (0, import_pg_core.timestamp)("started_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
  appliedStepsCount: (0, import_pg_core.integer)("applied_steps_count").default(0).notNull()
});
const paymentEvents = (0, import_pg_core.pgTable)("payment_events", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  provider: (0, import_pg_core.text)().notNull(),
  externalEventId: (0, import_pg_core.text)("external_event_id").notNull(),
  eventType: (0, import_pg_core.text)("event_type").notNull(),
  payload: (0, import_pg_core.jsonb)().notNull(),
  processedAt: (0, import_pg_core.timestamp)("processed_at", { withTimezone: true, mode: "string" }),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.index)("payment_events_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
  (0, import_pg_core.uniqueIndex)("payment_events_provider_external_event_id_key").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.externalEventId.asc().nullsLast().op("text_ops"))
]);
const refreshTokens = (0, import_pg_core.pgTable)("refresh_tokens", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  tokenHash: (0, import_pg_core.text)("token_hash").notNull(),
  expiresAt: (0, import_pg_core.timestamp)("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  revokedAt: (0, import_pg_core.timestamp)("revoked_at", { withTimezone: true, mode: "string" }),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("refresh_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("refresh_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "refresh_tokens_user_id_fkey"
  }).onUpdate("cascade").onDelete("cascade")
]);
const plans = (0, import_pg_core.pgTable)("plans", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  name: (0, import_pg_core.text)().notNull(),
  priceCents: (0, import_pg_core.integer)("price_cents").notNull(),
  currency: (0, import_pg_core.char)({ length: 3 }).default("BRL").notNull(),
  intervalUnit: (0, import_pg_core.text)("interval_unit").notNull(),
  intervalCount: (0, import_pg_core.integer)("interval_count").default(1).notNull(),
  active: (0, import_pg_core.boolean)().default(true).notNull(),
  externalPlanId: (0, import_pg_core.text)("external_plan_id"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("plans_name_key").using("btree", table.name.asc().nullsLast().op("text_ops"))
]);
const orders = (0, import_pg_core.pgTable)("orders", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  status: orderStatus().default("PENDING").notNull(),
  totalCents: (0, import_pg_core.integer)("total_cents").notNull(),
  currency: (0, import_pg_core.char)({ length: 3 }).default("BRL").notNull(),
  externalPaymentId: (0, import_pg_core.text)("external_payment_id"),
  idempotencyKey: (0, import_pg_core.text)("idempotency_key"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  paidAt: (0, import_pg_core.timestamp)("paid_at", { withTimezone: true, mode: "string" })
}, (table) => [
  (0, import_pg_core.uniqueIndex)("orders_idempotency_key_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("orders_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "orders_user_id_fkey"
  }).onUpdate("cascade").onDelete("restrict")
]);
const playbackEvents = (0, import_pg_core.pgTable)("playback_events", {
  id: (0, import_pg_core.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id"),
  trackId: (0, import_pg_core.uuid)("track_id").notNull(),
  source: (0, import_pg_core.text)().notNull(),
  secondsPlayed: (0, import_pg_core.integer)("seconds_played").default(0).notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.index)("playback_events_track_id_created_at_idx").using("btree", table.trackId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "playback_events_user_id_fkey"
  }).onUpdate("cascade").onDelete("set null"),
  (0, import_pg_core.foreignKey)({
    columns: [table.trackId],
    foreignColumns: [tracks.id],
    name: "playback_events_track_id_fkey"
  }).onUpdate("cascade").onDelete("restrict")
]);
const orderItems = (0, import_pg_core.pgTable)("order_items", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  orderId: (0, import_pg_core.uuid)("order_id").notNull(),
  productType: productType("product_type").notNull(),
  productId: (0, import_pg_core.uuid)("product_id"),
  quantity: (0, import_pg_core.integer)().default(1).notNull(),
  unitPriceCents: (0, import_pg_core.integer)("unit_price_cents").notNull()
}, (table) => [
  (0, import_pg_core.index)("order_items_order_id_idx").using("btree", table.orderId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.orderId],
    foreignColumns: [orders.id],
    name: "order_items_order_id_fkey"
  }).onUpdate("cascade").onDelete("cascade")
]);
const tracks = (0, import_pg_core.pgTable)("tracks", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  albumId: (0, import_pg_core.uuid)("album_id"),
  artistId: (0, import_pg_core.uuid)("artist_id").notNull(),
  title: (0, import_pg_core.text)().notNull(),
  slug: (0, import_pg_core.text)().notNull(),
  isrc: (0, import_pg_core.text)(),
  upc: (0, import_pg_core.text)(),
  genre: (0, import_pg_core.text)(),
  mood: (0, import_pg_core.text)(),
  durationSeconds: (0, import_pg_core.integer)("duration_seconds"),
  status: trackStatus().default("DRAFT").notNull(),
  previewKey: (0, import_pg_core.text)("preview_key"),
  streamKey: (0, import_pg_core.text)("stream_key"),
  masterKey: (0, import_pg_core.text)("master_key"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: (0, import_pg_core.timestamp)("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  trackNumber: (0, import_pg_core.integer)("track_number"),
  fullPath: (0, import_pg_core.text)("full_path"),
  previewPath: (0, import_pg_core.text)("preview_path")
}, (table) => [
  (0, import_pg_core.index)("tracks_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("tracks_album_id_track_number_idx").using("btree", table.albumId.asc().nullsLast().op("int4_ops"), table.trackNumber.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("tracks_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.uniqueIndex)("tracks_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("tracks_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.albumId],
    foreignColumns: [albums.id],
    name: "tracks_album_id_fkey"
  }).onUpdate("cascade").onDelete("set null"),
  (0, import_pg_core.foreignKey)({
    columns: [table.artistId],
    foreignColumns: [artists.id],
    name: "tracks_artist_id_fkey"
  }).onUpdate("cascade").onDelete("restrict")
]);
const users = (0, import_pg_core.pgTable)("users", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  email: (0, import_pg_core.text)().notNull(),
  passwordHash: (0, import_pg_core.text)("password_hash"),
  name: (0, import_pg_core.text)().notNull(),
  role: userRole().default("CUSTOMER").notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: (0, import_pg_core.timestamp)("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  emailVerified: (0, import_pg_core.timestamp)("email_verified", { withTimezone: true, mode: "string" })
}, (table) => [
  (0, import_pg_core.uniqueIndex)("users_email_key").using("btree", table.email.asc().nullsLast().op("text_ops"))
]);
const subscriptions = (0, import_pg_core.pgTable)("subscriptions", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  planId: (0, import_pg_core.uuid)("plan_id").notNull(),
  externalSubscriptionId: (0, import_pg_core.text)("external_subscription_id"),
  status: subscriptionStatus().default("PENDING").notNull(),
  currentPeriodStart: (0, import_pg_core.timestamp)("current_period_start", { withTimezone: true, mode: "string" }),
  currentPeriodEnd: (0, import_pg_core.timestamp)("current_period_end", { withTimezone: true, mode: "string" }),
  cancelAtPeriodEnd: (0, import_pg_core.boolean)("cancel_at_period_end").default(false).notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: (0, import_pg_core.timestamp)("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  initPoint: (0, import_pg_core.text)("init_point"),
  payerEmail: (0, import_pg_core.text)("payer_email")
}, (table) => [
  (0, import_pg_core.index)("idx_subscriptions_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
  (0, import_pg_core.index)("idx_subscriptions_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("idx_subscriptions_user_status").using("btree", table.userId.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("enum_ops")),
  (0, import_pg_core.uniqueIndex)("subscriptions_external_subscription_id_key").using("btree", table.externalSubscriptionId.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("subscriptions_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "subscriptions_user_id_fkey"
  }).onUpdate("cascade").onDelete("restrict"),
  (0, import_pg_core.foreignKey)({
    columns: [table.planId],
    foreignColumns: [plans.id],
    name: "subscriptions_plan_id_fkey"
  }).onUpdate("cascade").onDelete("restrict")
]);
const albums = (0, import_pg_core.pgTable)("albums", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  title: (0, import_pg_core.text)().notNull(),
  slug: (0, import_pg_core.text)().notNull(),
  releaseDate: (0, import_pg_core.date)("release_date"),
  artistId: (0, import_pg_core.uuid)("artist_id").notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  coverUrl: (0, import_pg_core.text)("cover_url"),
  sortOrder: (0, import_pg_core.integer)("sort_order").default(0).notNull(),
  upc: (0, import_pg_core.text)(),
  updatedAt: (0, import_pg_core.timestamp)("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
  artist: (0, import_pg_core.text)(),
  year: (0, import_pg_core.integer)(),
  type: (0, import_pg_core.text)().default("album"),
  description: (0, import_pg_core.text)(),
  published: (0, import_pg_core.boolean)().default(false),
  coverInitials: (0, import_pg_core.text)("cover_initials"),
  orderIndex: (0, import_pg_core.integer)("order_index").default(0)
}, (table) => [
  (0, import_pg_core.index)("albums_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.uniqueIndex)("albums_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("albums_sort_order_idx").using("btree", table.sortOrder.asc().nullsLast().op("int4_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.artistId],
    foreignColumns: [artists.id],
    name: "albums_artist_id_fkey"
  }).onUpdate("cascade").onDelete("restrict")
]);
const artists = (0, import_pg_core.pgTable)("artists", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  name: (0, import_pg_core.text)().notNull(),
  bio: (0, import_pg_core.text)(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull(),
  imageUrl: (0, import_pg_core.text)("image_url"),
  slug: (0, import_pg_core.text)()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("artists_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.uniqueIndex)("artists_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops"))
]);
const socialLinks = (0, import_pg_core.pgTable)("social_links", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  platform: (0, import_pg_core.text)().notNull(),
  label: (0, import_pg_core.text)().notNull(),
  url: (0, import_pg_core.text)().notNull(),
  sortOrder: (0, import_pg_core.integer)("sort_order").default(0).notNull(),
  active: (0, import_pg_core.boolean)().default(true).notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("social_links_platform_key").using("btree", table.platform.asc().nullsLast().op("text_ops"))
]);
const newsletterSubscribers = (0, import_pg_core.pgTable)("newsletter_subscribers", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  email: (0, import_pg_core.text)().notNull(),
  name: (0, import_pg_core.text)(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("newsletter_subscribers_email_key").using("btree", table.email.asc().nullsLast().op("text_ops"))
]);
const rentalProducts = (0, import_pg_core.pgTable)("rental_products", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  trackId: (0, import_pg_core.uuid)("track_id"),
  albumId: (0, import_pg_core.uuid)("album_id"),
  name: (0, import_pg_core.text)().notNull(),
  durationHours: (0, import_pg_core.integer)("duration_hours").notNull(),
  priceCents: (0, import_pg_core.integer)("price_cents").notNull(),
  currency: (0, import_pg_core.char)({ length: 3 }).default("BRL").notNull(),
  active: (0, import_pg_core.boolean)().default(true).notNull(),
  sortOrder: (0, import_pg_core.integer)("sort_order").default(0).notNull()
}, (table) => [
  (0, import_pg_core.index)("rental_products_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("rental_products_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.trackId],
    foreignColumns: [tracks.id],
    name: "rental_products_track_id_fkey"
  }).onUpdate("cascade").onDelete("cascade"),
  (0, import_pg_core.foreignKey)({
    columns: [table.albumId],
    foreignColumns: [albums.id],
    name: "rental_products_album_id_fkey"
  }).onUpdate("cascade").onDelete("cascade")
]);
const passwordResetTokens = (0, import_pg_core.pgTable)("password_reset_tokens", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  tokenHash: (0, import_pg_core.text)("token_hash").notNull(),
  expiresAt: (0, import_pg_core.timestamp)("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: (0, import_pg_core.timestamp)("used_at", { withTimezone: true, mode: "string" }),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("password_reset_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("password_reset_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "password_reset_tokens_user_id_fkey"
  }).onUpdate("cascade").onDelete("cascade")
]);
const rentals = (0, import_pg_core.pgTable)("rentals", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  rentalCode: (0, import_pg_core.text)("rental_code").notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  trackId: (0, import_pg_core.uuid)("track_id"),
  albumId: (0, import_pg_core.uuid)("album_id"),
  orderId: (0, import_pg_core.uuid)("order_id"),
  status: rentalStatus().default("PENDING").notNull(),
  startsAt: (0, import_pg_core.timestamp)("starts_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: (0, import_pg_core.timestamp)("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.index)("idx_rentals_user_track").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.trackId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("rentals_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.uniqueIndex)("rentals_rental_code_key").using("btree", table.rentalCode.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("rentals_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.index)("rentals_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "rentals_user_id_fkey"
  }).onUpdate("cascade").onDelete("restrict"),
  (0, import_pg_core.foreignKey)({
    columns: [table.trackId],
    foreignColumns: [tracks.id],
    name: "rentals_track_id_fkey"
  }).onUpdate("cascade").onDelete("set null"),
  (0, import_pg_core.foreignKey)({
    columns: [table.albumId],
    foreignColumns: [albums.id],
    name: "rentals_album_id_fkey"
  }).onUpdate("cascade").onDelete("set null"),
  (0, import_pg_core.foreignKey)({
    columns: [table.orderId],
    foreignColumns: [orders.id],
    name: "rentals_order_id_fkey"
  }).onUpdate("cascade").onDelete("set null")
]);
const emailVerificationTokens = (0, import_pg_core.pgTable)("email_verification_tokens", {
  id: (0, import_pg_core.uuid)().primaryKey().notNull(),
  userId: (0, import_pg_core.uuid)("user_id").notNull(),
  tokenHash: (0, import_pg_core.text)("token_hash").notNull(),
  expiresAt: (0, import_pg_core.timestamp)("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  usedAt: (0, import_pg_core.timestamp)("used_at", { withTimezone: true, mode: "string" }),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).default(import_drizzle_orm.sql`CURRENT_TIMESTAMP`).notNull()
}, (table) => [
  (0, import_pg_core.uniqueIndex)("email_verification_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("email_verification_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
  (0, import_pg_core.foreignKey)({
    columns: [table.userId],
    foreignColumns: [users.id],
    name: "email_verification_tokens_user_id_fkey"
  }).onUpdate("cascade").onDelete("cascade")
]);
const paymentsEvents = (0, import_pg_core.pgTable)("payments_events", {
  id: (0, import_pg_core.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
  provider: (0, import_pg_core.text)().default("mercadopago").notNull(),
  providerEvent: (0, import_pg_core.text)("provider_event").notNull(),
  eventType: (0, import_pg_core.text)("event_type").notNull(),
  externalId: (0, import_pg_core.text)("external_id"),
  payload: (0, import_pg_core.jsonb)().notNull(),
  processedAt: (0, import_pg_core.timestamp)("processed_at", { withTimezone: true, mode: "string" }),
  failureReason: (0, import_pg_core.text)("failure_reason"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull()
}, (table) => [
  (0, import_pg_core.index)("idx_events_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
  (0, import_pg_core.index)("idx_events_external").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("idx_events_unprocessed").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(import_drizzle_orm.sql`(processed_at IS NULL)`),
  (0, import_pg_core.unique)("payments_events_provider_provider_event_key").on(table.providerEvent, table.provider)
]);
const adminAudit = (0, import_pg_core.pgTable)("admin_audit", {
  id: (0, import_pg_core.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
  actor: (0, import_pg_core.text)(),
  action: (0, import_pg_core.text)().notNull(),
  target: (0, import_pg_core.text)(),
  metadata: (0, import_pg_core.jsonb)(),
  ip: (0, import_pg_core.inet)(),
  userAgent: (0, import_pg_core.text)("user_agent"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull()
}, (table) => [
  (0, import_pg_core.index)("idx_admin_audit_action").using("btree", table.action.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("idx_admin_audit_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops"))
]);
const authAuditLog = (0, import_pg_core.pgTable)("auth_audit_log", {
  id: (0, import_pg_core.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
  event: (0, import_pg_core.text)().notNull(),
  emailHash: (0, import_pg_core.text)("email_hash"),
  userId: (0, import_pg_core.uuid)("user_id"),
  ip: (0, import_pg_core.inet)(),
  userAgent: (0, import_pg_core.text)("user_agent"),
  success: (0, import_pg_core.boolean)().notNull(),
  reason: (0, import_pg_core.text)(),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull()
}, (table) => [
  (0, import_pg_core.index)("idx_auth_audit_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
  (0, import_pg_core.index)("idx_auth_audit_email_hash").using("btree", table.emailHash.asc().nullsLast().op("text_ops")),
  (0, import_pg_core.index)("idx_auth_audit_event").using("btree", table.event.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
  (0, import_pg_core.index)("idx_auth_audit_ip").using("btree", table.ip.asc().nullsLast().op("inet_ops"))
]);
// ═══════════════════════════════════════════════════════════════════════
//  site_content — conteúdo editável do site (adicionado na migração Neon)
// ═══════════════════════════════════════════════════════════════════════
const siteContent = (0, import_pg_core.pgTable)("site_content", {
  key: (0, import_pg_core.text)().primaryKey().notNull(),
  data: (0, import_pg_core.jsonb)().default({}).notNull(),
  version: (0, import_pg_core.integer)().default(0).notNull(),
  updatedBy: (0, import_pg_core.uuid)("updated_by"),
  updatedAt: (0, import_pg_core.timestamp)("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull()
});
// ═══════════════════════════════════════════════════════════════════════
//  site_content_history — histórico para rollback
// ═══════════════════════════════════════════════════════════════════════
const siteContentHistory = (0, import_pg_core.pgTable)("site_content_history", {
  id: (0, import_pg_core.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
  key: (0, import_pg_core.text)().notNull(),
  data: (0, import_pg_core.jsonb)().notNull(),
  version: (0, import_pg_core.integer)().notNull(),
  createdBy: (0, import_pg_core.uuid)("created_by"),
  createdAt: (0, import_pg_core.timestamp)("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull()
}, (table) => [
  (0, import_pg_core.index)("idx_content_history_key").using("btree", table.key.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops"))
]);