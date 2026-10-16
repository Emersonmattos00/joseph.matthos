import { pgTable, varchar, timestamp, text, integer, index, uniqueIndex, pgPolicy, uuid, jsonb, foreignKey, char, bigserial, boolean, unique, inet, bigint, date, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const orderStatus = pgEnum("OrderStatus", ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'])
export const productType = pgEnum("ProductType", ['RENTAL', 'SUBSCRIPTION'])
export const rentalStatus = pgEnum("RentalStatus", ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'])
export const subscriptionStatus = pgEnum("SubscriptionStatus", ['PENDING', 'ACTIVE', 'PAUSED', 'CANCELLED', 'EXPIRED', 'PAST_DUE'])
export const trackStatus = pgEnum("TrackStatus", ['DRAFT', 'PUBLISHED', 'ARCHIVED'])
export const userRole = pgEnum("UserRole", ['CUSTOMER', 'ADMIN'])


export const prismaMigrations = pgTable("_prisma_migrations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	checksum: varchar({ length: 64 }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	migrationName: varchar("migration_name", { length: 255 }).notNull(),
	logs: text(),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	appliedStepsCount: integer("applied_steps_count").default(0).notNull(),
});

export const paymentEvents = pgTable("payment_events", {
	id: uuid().primaryKey().notNull(),
	provider: text().notNull(),
	externalEventId: text("external_event_id").notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("payment_events_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("payment_events_provider_external_event_id_key").using("btree", table.provider.asc().nullsLast().op("text_ops"), table.externalEventId.asc().nullsLast().op("text_ops")),
	pgPolicy("payment_events_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const refreshTokens = pgTable("refresh_tokens", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	tokenHash: text("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("refresh_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("refresh_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "refresh_tokens_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	pgPolicy("refresh_tokens_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const orders = pgTable("orders", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	status: orderStatus().default('PENDING').notNull(),
	totalCents: integer("total_cents").notNull(),
	currency: char({ length: 3 }).default('BRL').notNull(),
	externalPaymentId: text("external_payment_id"),
	idempotencyKey: text("idempotency_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("orders_idempotency_key_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
	index("orders_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "orders_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	pgPolicy("orders_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const playbackEvents = pgTable("playback_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	userId: uuid("user_id"),
	trackId: uuid("track_id").notNull(),
	source: text().notNull(),
	secondsPlayed: integer("seconds_played").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("playback_events_track_id_created_at_idx").using("btree", table.trackId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "playback_events_user_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.trackId],
			foreignColumns: [tracks.id],
			name: "playback_events_track_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	pgPolicy("playback_events_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const plans = pgTable("plans", {
	id: uuid().primaryKey().notNull(),
	name: text().notNull(),
	priceCents: integer("price_cents").notNull(),
	currency: char({ length: 3 }).default('BRL').notNull(),
	intervalUnit: text("interval_unit").notNull(),
	intervalCount: integer("interval_count").default(1).notNull(),
	active: boolean().default(true).notNull(),
	externalPlanId: text("external_plan_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("plans_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
	pgPolicy("plans_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const orderItems = pgTable("order_items", {
	id: uuid().primaryKey().notNull(),
	orderId: uuid("order_id").notNull(),
	productType: productType("product_type").notNull(),
	productId: uuid("product_id"),
	quantity: integer().default(1).notNull(),
	unitPriceCents: integer("unit_price_cents").notNull(),
}, (table) => [
	index("order_items_order_id_idx").using("btree", table.orderId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_items_order_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	pgPolicy("order_items_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const tracks = pgTable("tracks", {
	id: uuid().primaryKey().notNull(),
	albumId: uuid("album_id"),
	artistId: uuid("artist_id").notNull(),
	title: text().notNull(),
	slug: text().notNull(),
	isrc: text(),
	upc: text(),
	genre: text(),
	mood: text(),
	durationSeconds: integer("duration_seconds"),
	status: trackStatus().default('DRAFT').notNull(),
	previewKey: text("preview_key"),
	streamKey: text("stream_key"),
	masterKey: text("master_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	trackNumber: integer("track_number"),
	fullPath: text("full_path"),
	previewPath: text("preview_path"),
}, (table) => [
	index("tracks_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
	index("tracks_album_id_track_number_idx").using("btree", table.albumId.asc().nullsLast().op("int4_ops"), table.trackNumber.asc().nullsLast().op("uuid_ops")),
	index("tracks_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("tracks_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("tracks_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.albumId],
			foreignColumns: [albums.id],
			name: "tracks_album_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.artistId],
			foreignColumns: [artists.id],
			name: "tracks_artist_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	pgPolicy("tracks_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("tracks_no_write", { as: "permissive", for: "all", to: ["public"] }),
]);

export const socialLinks = pgTable("social_links", {
	id: uuid().primaryKey().notNull(),
	platform: text().notNull(),
	label: text().notNull(),
	url: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("social_links_platform_key").using("btree", table.platform.asc().nullsLast().op("text_ops")),
	pgPolicy("social_links_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const emailVerificationTokens = pgTable("email_verification_tokens", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	tokenHash: text("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("email_verification_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("email_verification_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "email_verification_tokens_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	pgPolicy("email_verification_tokens_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const paymentsEvents = pgTable("payments_events", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	provider: text().default('mercadopago').notNull(),
	providerEvent: text("provider_event").notNull(),
	eventType: text("event_type").notNull(),
	externalId: text("external_id"),
	payload: jsonb().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_events_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_events_external").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
	index("idx_events_unprocessed").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(processed_at IS NULL)`),
	unique("payments_events_provider_provider_event_key").on(table.providerEvent, table.provider),
	pgPolicy("events_no_access", { as: "permissive", for: "all", to: ["public"], using: sql`false`, withCheck: sql`false`  }),
]);

export const users = pgTable("users", {
	id: uuid().primaryKey().notNull(),
	email: text().notNull(),
	passwordHash: text("password_hash"),
	name: text().notNull(),
	role: userRole().default('CUSTOMER').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	emailVerified: timestamp("email_verified", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("users_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
	pgPolicy("users_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const subscriptions = pgTable("subscriptions", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	planId: uuid("plan_id").notNull(),
	externalSubscriptionId: text("external_subscription_id"),
	status: subscriptionStatus().default('PENDING').notNull(),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: 'string' }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: 'string' }),
	cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	initPoint: text("init_point"),
	payerEmail: text("payer_email"),
}, (table) => [
	index("idx_subscriptions_status").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("idx_subscriptions_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_subscriptions_user_status").using("btree", table.userId.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("enum_ops")),
	uniqueIndex("subscriptions_external_subscription_id_key").using("btree", table.externalSubscriptionId.asc().nullsLast().op("text_ops")),
	index("subscriptions_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "subscriptions_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.planId],
			foreignColumns: [plans.id],
			name: "subscriptions_plan_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	pgPolicy("subscriptions_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("subscriptions_no_write", { as: "permissive", for: "all", to: ["public"] }),
]);

export const artists = pgTable("artists", {
	id: uuid().primaryKey().notNull(),
	name: text().notNull(),
	bio: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	imageUrl: text("image_url"),
	slug: text(),
}, (table) => [
	uniqueIndex("artists_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
	uniqueIndex("artists_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	pgPolicy("artists_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const newsletterSubscribers = pgTable("newsletter_subscribers", {
	id: uuid().primaryKey().notNull(),
	email: text().notNull(),
	name: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("newsletter_subscribers_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
	pgPolicy("newsletter_subscribers_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const rentalProducts = pgTable("rental_products", {
	id: uuid().primaryKey().notNull(),
	trackId: uuid("track_id"),
	albumId: uuid("album_id"),
	name: text().notNull(),
	durationHours: integer("duration_hours").notNull(),
	priceCents: integer("price_cents").notNull(),
	currency: char({ length: 3 }).default('BRL').notNull(),
	active: boolean().default(true).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
	index("rental_products_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
	index("rental_products_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.trackId],
			foreignColumns: [tracks.id],
			name: "rental_products_track_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.albumId],
			foreignColumns: [albums.id],
			name: "rental_products_album_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	pgPolicy("rental_products_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
	id: uuid().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	tokenHash: text("token_hash").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	usedAt: timestamp("used_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("password_reset_tokens_token_hash_key").using("btree", table.tokenHash.asc().nullsLast().op("text_ops")),
	index("password_reset_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "password_reset_tokens_user_id_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	pgPolicy("password_reset_tokens_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
]);

export const rentals = pgTable("rentals", {
	id: uuid().primaryKey().notNull(),
	rentalCode: text("rental_code").notNull(),
	userId: uuid("user_id").notNull(),
	trackId: uuid("track_id"),
	albumId: uuid("album_id"),
	orderId: uuid("order_id"),
	status: rentalStatus().default('PENDING').notNull(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("idx_rentals_user_track").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.trackId.asc().nullsLast().op("uuid_ops")),
	index("rentals_album_id_idx").using("btree", table.albumId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("rentals_rental_code_key").using("btree", table.rentalCode.asc().nullsLast().op("text_ops")),
	index("rentals_track_id_idx").using("btree", table.trackId.asc().nullsLast().op("uuid_ops")),
	index("rentals_user_id_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "rentals_user_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.trackId],
			foreignColumns: [tracks.id],
			name: "rentals_track_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.albumId],
			foreignColumns: [albums.id],
			name: "rentals_album_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "rentals_order_id_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	pgPolicy("rentals_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("rentals_no_write", { as: "permissive", for: "all", to: ["public"] }),
]);

export const adminAudit = pgTable("admin_audit", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	actor: text(),
	action: text().notNull(),
	target: text(),
	metadata: jsonb(),
	ip: inet(),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_admin_audit_action").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("idx_admin_audit_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	pgPolicy("admin_audit_no_access", { as: "permissive", for: "all", to: ["public"], using: sql`false`, withCheck: sql`false`  }),
]);

export const authAuditLog = pgTable("auth_audit_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	event: text().notNull(),
	emailHash: text("email_hash"),
	userId: uuid("user_id"),
	ip: inet(),
	userAgent: text("user_agent"),
	success: boolean().notNull(),
	reason: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_auth_audit_created").using("btree", table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_auth_audit_email_hash").using("btree", table.emailHash.asc().nullsLast().op("text_ops")),
	index("idx_auth_audit_event").using("btree", table.event.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_auth_audit_ip").using("btree", table.ip.asc().nullsLast().op("inet_ops")),
	pgPolicy("auth_audit_no_access", { as: "permissive", for: "all", to: ["public"], using: sql`false`, withCheck: sql`false`  }),
]);

export const tracksBackup20261016 = pgTable("tracks_backup_20261016", {
	id: uuid(),
	albumId: uuid("album_id"),
	artistId: uuid("artist_id"),
	title: text(),
	slug: text(),
	isrc: text(),
	upc: text(),
	genre: text(),
	mood: text(),
	durationSeconds: integer("duration_seconds"),
	status: trackStatus(),
	previewKey: text("preview_key"),
	streamKey: text("stream_key"),
	masterKey: text("master_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	trackNumber: integer("track_number"),
	fullPath: text("full_path"),
	previewPath: text("preview_path"),
});

export const playbackEventsBackup20261016 = pgTable("playback_events_backup_20261016", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	userId: uuid("user_id"),
	trackId: uuid("track_id"),
	source: text(),
	secondsPlayed: integer("seconds_played"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
});

export const tracksBackupTitles20261016 = pgTable("tracks_backup_titles_20261016", {
	id: uuid(),
	title: text(),
	slug: text(),
});

export const albums = pgTable("albums", {
	id: uuid().primaryKey().notNull(),
	title: text().notNull(),
	slug: text().notNull(),
	releaseDate: date("release_date"),
	artistId: uuid("artist_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	coverUrl: text("cover_url"),
	sortOrder: integer("sort_order").default(0).notNull(),
	upc: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	artist: text(),
	year: integer(),
	type: text().default('album'),
	description: text(),
	published: boolean().default(false),
	coverInitials: text("cover_initials"),
	orderIndex: integer("order_index").default(0),
}, (table) => [
	index("albums_artist_id_idx").using("btree", table.artistId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("albums_slug_key").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("albums_sort_order_idx").using("btree", table.sortOrder.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.artistId],
			foreignColumns: [artists.id],
			name: "albums_artist_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	pgPolicy("albums_service_all", { as: "permissive", for: "all", to: ["service_role"], using: sql`true`, withCheck: sql`true`  }),
	pgPolicy("albums_no_write", { as: "permissive", for: "all", to: ["public"] }),
]);
