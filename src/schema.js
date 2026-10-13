"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailVerificationTokens = exports.passwordResetTokens = exports.rentals = exports.rentalProducts = exports.newsletterSubscribers = exports.socialLinks = exports.artists = exports.albums = exports.users = exports.subscriptions = exports.tracks = exports.orderItems = exports.playbackEvents = exports.orders = exports.plans = exports.refreshTokens = exports.paymentEvents = exports.prismaMigrations = exports.userRole = exports.trackStatus = exports.subscriptionStatus = exports.rentalStatus = exports.productType = exports.orderStatus = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
exports.orderStatus = (0, pg_core_1.pgEnum)("OrderStatus", ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED']);
exports.productType = (0, pg_core_1.pgEnum)("ProductType", ['RENTAL', 'SUBSCRIPTION']);
exports.rentalStatus = (0, pg_core_1.pgEnum)("RentalStatus", ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED']);
exports.subscriptionStatus = (0, pg_core_1.pgEnum)("SubscriptionStatus", ['PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'PAST_DUE']);
exports.trackStatus = (0, pg_core_1.pgEnum)("TrackStatus", ['DRAFT', 'PUBLISHED', 'ARCHIVED']);
exports.userRole = (0, pg_core_1.pgEnum)("UserRole", ['CUSTOMER', 'ADMIN']);
exports.prismaMigrations = (0, pg_core_1.pgTable)("_prisma_migrations", {
    id: (0, pg_core_1.varchar)({ length: 36 }).primaryKey().notNull(),
    checksum: (0, pg_core_1.varchar)({ length: 64 }).notNull(),
    finishedAt: (0, pg_core_1.timestamp)("finished_at", { withTimezone: true, mode: 'string' }),
    migrationName: (0, pg_core_1.varchar)("migration_name", { length: 255 }).notNull(),
    logs: (0, pg_core_1.text)(),
    rolledBackAt: (0, pg_core_1.timestamp)("rolled_back_at", { withTimezone: true, mode: 'string' }),
    startedAt: (0, pg_core_1.timestamp)("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    appliedStepsCount: (0, pg_core_1.integer)("applied_steps_count").default(0).notNull(),
});
exports.paymentEvents = (0, pg_core_1.pgTable)("payment_events", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    provider: (0, pg_core_1.text)().notNull(),
    externalEventId: (0, pg_core_1.text)("external_event_id").notNull(),
    eventType: (0, pg_core_1.text)("event_type").notNull(),
    payload: (0, pg_core_1.jsonb)().notNull(),
    processedAt: (0, pg_core_1.timestamp)("processed_at", { withTimezone: true, mode: 'string' }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.index)("payment_events_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
    (0, pg_core_1.uniqueIndex)("payment_events_provider_external_event_id_key").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.externalEventId.asc().nullsLast().op("text_ops")),
]);
exports.refreshTokens = (0, pg_core_1.pgTable)("refresh_tokens", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    tokenHash: (0, pg_core_1.text)("token_hash").notNull(),
    expiresAt: (0, pg_core_1.timestamp)("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: (0, pg_core_1.timestamp)("revoked_at", { withTimezone: true, mode: 'string' }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("refresh_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("refresh_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "refresh_tokens_user_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
]);
exports.plans = (0, pg_core_1.pgTable)("plans", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    name: (0, pg_core_1.text)().notNull(),
    priceCents: (0, pg_core_1.integer)("price_cents").notNull(),
    currency: (0, pg_core_1.char)({ length: 3 }).default('BRL').notNull(),
    intervalUnit: (0, pg_core_1.text)("interval_unit").notNull(),
    intervalCount: (0, pg_core_1.integer)("interval_count").default(1).notNull(),
    active: (0, pg_core_1.boolean)().default(true).notNull(),
    externalPlanId: (0, pg_core_1.text)("external_plan_id"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("plans_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);
exports.orders = (0, pg_core_1.pgTable)("orders", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    status: (0, exports.orderStatus)().default('PENDING').notNull(),
    totalCents: (0, pg_core_1.integer)("total_cents").notNull(),
    currency: (0, pg_core_1.char)({ length: 3 }).default('BRL').notNull(),
    externalPaymentId: (0, pg_core_1.text)("external_payment_id"),
    idempotencyKey: (0, pg_core_1.text)("idempotency_key"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    paidAt: (0, pg_core_1.timestamp)("paid_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("orders_idempotency_key_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("orders_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "orders_user_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
]);
exports.playbackEvents = (0, pg_core_1.pgTable)("playback_events", {
    id: (0, pg_core_1.bigserial)({ mode: "bigint" }).primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id"),
    trackId: (0, pg_core_1.uuid)("track_id").notNull(),
    source: (0, pg_core_1.text)().notNull(),
    secondsPlayed: (0, pg_core_1.integer)("seconds_played").default(0).notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.index)("playback_events_track_id_created_at_idx").using("btree", table.trackId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "playback_events_user_id_fkey"
    }).onUpdate("cascade").onDelete("set null"),
    (0, pg_core_1.foreignKey)({
        columns: [table.trackId],
        foreignColumns: [exports.tracks.id],
        name: "playback_events_track_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
]);
exports.orderItems = (0, pg_core_1.pgTable)("order_items", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    orderId: (0, pg_core_1.uuid)("order_id").notNull(),
    productType: (0, exports.productType)("product_type").notNull(),
    productId: (0, pg_core_1.uuid)("product_id"),
    quantity: (0, pg_core_1.integer)().default(1).notNull(),
    unitPriceCents: (0, pg_core_1.integer)("unit_price_cents").notNull(),
}, (table) => [
    (0, pg_core_1.index)("order_items_order_id_idx").using("btree", table.orderId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.orderId],
        foreignColumns: [exports.orders.id],
        name: "order_items_order_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
]);
exports.tracks = (0, pg_core_1.pgTable)("tracks", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    albumId: (0, pg_core_1.uuid)("album_id"),
    artistId: (0, pg_core_1.uuid)("artist_id").notNull(),
    title: (0, pg_core_1.text)().notNull(),
    slug: (0, pg_core_1.text)().notNull(),
    isrc: (0, pg_core_1.text)(),
    upc: (0, pg_core_1.text)(),
    genre: (0, pg_core_1.text)(),
    mood: (0, pg_core_1.text)(),
    durationSeconds: (0, pg_core_1.integer)("duration_seconds"),
    status: (0, exports.trackStatus)().default('DRAFT').notNull(),
    previewKey: (0, pg_core_1.text)("preview_key"),
    streamKey: (0, pg_core_1.text)("stream_key"),
    masterKey: (0, pg_core_1.text)("master_key"),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
    trackNumber: (0, pg_core_1.integer)("track_number"),
}, (table) => [
    (0, pg_core_1.index)("tracks_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.index)("tracks_album_id_track_number_idx").using("btree", table.albumId.asc().nullsLast().op("int4_ops"), table.trackNumber.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.index)("tracks_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.uniqueIndex)("tracks_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("tracks_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.albumId],
        foreignColumns: [exports.albums.id],
        name: "tracks_album_id_fkey"
    }).onUpdate("cascade").onDelete("set null"),
    (0, pg_core_1.foreignKey)({
        columns: [table.artistId],
        foreignColumns: [exports.artists.id],
        name: "tracks_artist_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
]);
exports.subscriptions = (0, pg_core_1.pgTable)("subscriptions", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    planId: (0, pg_core_1.uuid)("plan_id").notNull(),
    externalSubscriptionId: (0, pg_core_1.text)("external_subscription_id"),
    status: (0, exports.subscriptionStatus)().default('PENDING').notNull(),
    currentPeriodStart: (0, pg_core_1.timestamp)("current_period_start", { withTimezone: true, mode: 'string' }),
    currentPeriodEnd: (0, pg_core_1.timestamp)("current_period_end", { withTimezone: true, mode: 'string' }),
    cancelAtPeriodEnd: (0, pg_core_1.boolean)("cancel_at_period_end").default(false).notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
    initPoint: (0, pg_core_1.text)("init_point"),
    payerEmail: (0, pg_core_1.text)("payer_email"),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("subscriptions_external_subscription_id_key").using("btree", table.externalSubscriptionId.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("subscriptions_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "subscriptions_user_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
    (0, pg_core_1.foreignKey)({
        columns: [table.planId],
        foreignColumns: [exports.plans.id],
        name: "subscriptions_plan_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
]);
exports.users = (0, pg_core_1.pgTable)("users", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    email: (0, pg_core_1.text)().notNull(),
    passwordHash: (0, pg_core_1.text)("password_hash"),
    name: (0, pg_core_1.text)().notNull(),
    role: (0, exports.userRole)().default('CUSTOMER').notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
    emailVerified: (0, pg_core_1.timestamp)("email_verified", { withTimezone: true, mode: 'string' }),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("users_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
]);
exports.albums = (0, pg_core_1.pgTable)("albums", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    title: (0, pg_core_1.text)().notNull(),
    slug: (0, pg_core_1.text)().notNull(),
    releaseDate: (0, pg_core_1.date)("release_date"),
    artistId: (0, pg_core_1.uuid)("artist_id").notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    coverUrl: (0, pg_core_1.text)("cover_url"),
    sortOrder: (0, pg_core_1.integer)("sort_order").default(0).notNull(),
    upc: (0, pg_core_1.text)(),
}, (table) => [
    (0, pg_core_1.index)("albums_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.uniqueIndex)("albums_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("albums_sort_order_idx").using("btree", table.sortOrder.asc().nullsLast().op("int4_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.artistId],
        foreignColumns: [exports.artists.id],
        name: "albums_artist_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
]);
exports.artists = (0, pg_core_1.pgTable)("artists", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    name: (0, pg_core_1.text)().notNull(),
    bio: (0, pg_core_1.text)(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
    imageUrl: (0, pg_core_1.text)("image_url"),
    slug: (0, pg_core_1.text)(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("artists_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.uniqueIndex)("artists_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
]);
exports.socialLinks = (0, pg_core_1.pgTable)("social_links", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    platform: (0, pg_core_1.text)().notNull(),
    label: (0, pg_core_1.text)().notNull(),
    url: (0, pg_core_1.text)().notNull(),
    sortOrder: (0, pg_core_1.integer)("sort_order").default(0).notNull(),
    active: (0, pg_core_1.boolean)().default(true).notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("social_links_platform_key").using("btree", table.platform.asc().nullsLast().op("text_ops")),
]);
exports.newsletterSubscribers = (0, pg_core_1.pgTable)("newsletter_subscribers", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    email: (0, pg_core_1.text)().notNull(),
    name: (0, pg_core_1.text)(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("newsletter_subscribers_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
]);
exports.rentalProducts = (0, pg_core_1.pgTable)("rental_products", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    trackId: (0, pg_core_1.uuid)("track_id"),
    albumId: (0, pg_core_1.uuid)("album_id"),
    name: (0, pg_core_1.text)().notNull(),
    durationHours: (0, pg_core_1.integer)("duration_hours").notNull(),
    priceCents: (0, pg_core_1.integer)("price_cents").notNull(),
    currency: (0, pg_core_1.char)({ length: 3 }).default('BRL').notNull(),
    active: (0, pg_core_1.boolean)().default(true).notNull(),
    sortOrder: (0, pg_core_1.integer)("sort_order").default(0).notNull(),
}, (table) => [
    (0, pg_core_1.index)("rental_products_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.index)("rental_products_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.trackId],
        foreignColumns: [exports.tracks.id],
        name: "rental_products_track_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
    (0, pg_core_1.foreignKey)({
        columns: [table.albumId],
        foreignColumns: [exports.albums.id],
        name: "rental_products_album_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
]);
exports.rentals = (0, pg_core_1.pgTable)("rentals", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    rentalCode: (0, pg_core_1.text)("rental_code").notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    trackId: (0, pg_core_1.uuid)("track_id"),
    albumId: (0, pg_core_1.uuid)("album_id"),
    orderId: (0, pg_core_1.uuid)("order_id"),
    status: (0, exports.rentalStatus)().default('PENDING').notNull(),
    startsAt: (0, pg_core_1.timestamp)("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
    expiresAt: (0, pg_core_1.timestamp)("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.index)("rentals_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.uniqueIndex)("rentals_rental_code_key").using("btree", table.rentalCode.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("rentals_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.index)("rentals_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "rentals_user_id_fkey"
    }).onUpdate("cascade").onDelete("restrict"),
    (0, pg_core_1.foreignKey)({
        columns: [table.trackId],
        foreignColumns: [exports.tracks.id],
        name: "rentals_track_id_fkey"
    }).onUpdate("cascade").onDelete("set null"),
    (0, pg_core_1.foreignKey)({
        columns: [table.albumId],
        foreignColumns: [exports.albums.id],
        name: "rentals_album_id_fkey"
    }).onUpdate("cascade").onDelete("set null"),
    (0, pg_core_1.foreignKey)({
        columns: [table.orderId],
        foreignColumns: [exports.orders.id],
        name: "rentals_order_id_fkey"
    }).onUpdate("cascade").onDelete("set null"),
]);
exports.passwordResetTokens = (0, pg_core_1.pgTable)("password_reset_tokens", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    tokenHash: (0, pg_core_1.text)("token_hash").notNull(),
    expiresAt: (0, pg_core_1.timestamp)("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
    usedAt: (0, pg_core_1.timestamp)("used_at", { withTimezone: true, mode: 'string' }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("password_reset_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("password_reset_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "password_reset_tokens_user_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
]);
exports.emailVerificationTokens = (0, pg_core_1.pgTable)("email_verification_tokens", {
    id: (0, pg_core_1.uuid)().primaryKey().notNull(),
    userId: (0, pg_core_1.uuid)("user_id").notNull(),
    tokenHash: (0, pg_core_1.text)("token_hash").notNull(),
    expiresAt: (0, pg_core_1.timestamp)("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
    usedAt: (0, pg_core_1.timestamp)("used_at", { withTimezone: true, mode: 'string' }),
    createdAt: (0, pg_core_1.timestamp)("created_at", { withTimezone: true, mode: 'string' }).default((0, drizzle_orm_1.sql) `CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
    (0, pg_core_1.uniqueIndex)("email_verification_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
    (0, pg_core_1.index)("email_verification_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
    (0, pg_core_1.foreignKey)({
        columns: [table.userId],
        foreignColumns: [exports.users.id],
        name: "email_verification_tokens_user_id_fkey"
    }).onUpdate("cascade").onDelete("cascade"),
]);
