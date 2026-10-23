CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"target" text,
	"metadata" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"email_hash" text,
	"user_id" uuid,
	"ip" text,
	"user_agent" text,
	"success" boolean NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'mercadopago' NOT NULL,
	"provider_event" text NOT NULL,
	"event_type" text NOT NULL,
	"external_id" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_content" (
	"key" text PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_content_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "payment_events" CASCADE;--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "playback_events" DROP CONSTRAINT "playback_events_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "playback_events" DROP CONSTRAINT "playback_events_track_id_fkey";
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_order_id_fkey";
--> statement-breakpoint
ALTER TABLE "tracks" DROP CONSTRAINT "tracks_album_id_fkey";
--> statement-breakpoint
ALTER TABLE "tracks" DROP CONSTRAINT "tracks_artist_id_fkey";
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_plan_id_fkey";
--> statement-breakpoint
ALTER TABLE "albums" DROP CONSTRAINT "albums_artist_id_fkey";
--> statement-breakpoint
ALTER TABLE "rental_products" DROP CONSTRAINT "rental_products_track_id_fkey";
--> statement-breakpoint
ALTER TABLE "rental_products" DROP CONSTRAINT "rental_products_album_id_fkey";
--> statement-breakpoint
ALTER TABLE "rentals" DROP CONSTRAINT "rentals_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "rentals" DROP CONSTRAINT "rentals_track_id_fkey";
--> statement-breakpoint
ALTER TABLE "rentals" DROP CONSTRAINT "rentals_album_id_fkey";
--> statement-breakpoint
ALTER TABLE "rentals" DROP CONSTRAINT "rentals_order_id_fkey";
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "password_reset_tokens_user_id_fkey";
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP CONSTRAINT "email_verification_tokens_user_id_fkey";
--> statement-breakpoint
DROP INDEX "refresh_tokens_token_hash_key";--> statement-breakpoint
DROP INDEX "refresh_tokens_user_id_idx";--> statement-breakpoint
DROP INDEX "playback_events_track_id_created_at_idx";--> statement-breakpoint
DROP INDEX "order_items_order_id_idx";--> statement-breakpoint
DROP INDEX "subscriptions_user_id_idx";--> statement-breakpoint
DROP INDEX "social_links_platform_key";--> statement-breakpoint
DROP INDEX "newsletter_subscribers_email_key";--> statement-breakpoint
DROP INDEX "password_reset_tokens_token_hash_key";--> statement-breakpoint
DROP INDEX "password_reset_tokens_user_id_idx";--> statement-breakpoint
DROP INDEX "email_verification_tokens_token_hash_key";--> statement-breakpoint
DROP INDEX "email_verification_tokens_user_id_idx";--> statement-breakpoint
DROP INDEX "plans_name_key";--> statement-breakpoint
DROP INDEX "orders_idempotency_key_key";--> statement-breakpoint
DROP INDEX "orders_user_id_idx";--> statement-breakpoint
DROP INDEX "tracks_album_id_idx";--> statement-breakpoint
DROP INDEX "tracks_album_id_track_number_idx";--> statement-breakpoint
DROP INDEX "tracks_artist_id_idx";--> statement-breakpoint
DROP INDEX "tracks_slug_key";--> statement-breakpoint
DROP INDEX "tracks_status_idx";--> statement-breakpoint
DROP INDEX "subscriptions_external_subscription_id_key";--> statement-breakpoint
DROP INDEX "users_email_key";--> statement-breakpoint
DROP INDEX "albums_artist_id_idx";--> statement-breakpoint
DROP INDEX "albums_slug_key";--> statement-breakpoint
DROP INDEX "albums_sort_order_idx";--> statement-breakpoint
DROP INDEX "artists_name_key";--> statement-breakpoint
DROP INDEX "artists_slug_key";--> statement-breakpoint
DROP INDEX "rental_products_album_id_idx";--> statement-breakpoint
DROP INDEX "rental_products_track_id_idx";--> statement-breakpoint
DROP INDEX "rentals_album_id_idx";--> statement-breakpoint
DROP INDEX "rentals_rental_code_key";--> statement-breakpoint
DROP INDEX "rentals_track_id_idx";--> statement-breakpoint
DROP INDEX "rentals_user_id_idx";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "tracks" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "albums" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "artists" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "social_links" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "rental_products" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "rentals" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "lyrics" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "full_path" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "preview_path" text;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "artist" text;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "year" integer;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "type" text DEFAULT 'album';--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "published" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "cover_initials" text;--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "order_index" integer DEFAULT 0;--> statement-breakpoint
CREATE INDEX "idx_content_history_key" ON "site_content_history" USING btree ("key","created_at");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_products" ADD CONSTRAINT "rental_products_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rental_products" ADD CONSTRAINT "rental_products_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rentals" ADD CONSTRAINT "rentals_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_status" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_rentals_user_track" ON "rentals" USING btree ("user_id","track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_name_key" ON "plans" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tracks_album_id_idx" ON "tracks" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "tracks_album_id_track_number_idx" ON "tracks" USING btree ("album_id","track_number");--> statement-breakpoint
CREATE INDEX "tracks_artist_id_idx" ON "tracks" USING btree ("artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_slug_key" ON "tracks" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tracks_status_idx" ON "tracks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions" USING btree ("external_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "albums_artist_id_idx" ON "albums" USING btree ("artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "albums_slug_key" ON "albums" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "albums_sort_order_idx" ON "albums" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_name_key" ON "artists" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_slug_key" ON "artists" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "rental_products_album_id_idx" ON "rental_products" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "rental_products_track_id_idx" ON "rental_products" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "rentals_album_id_idx" ON "rentals" USING btree ("album_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rentals_rental_code_key" ON "rentals" USING btree ("rental_code");--> statement-breakpoint
CREATE INDEX "rentals_track_id_idx" ON "rentals" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "rentals_user_id_idx" ON "rentals" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "checksum";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "finished_at";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "migration_name";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "logs";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "rolled_back_at";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "_prisma_migrations" DROP COLUMN "applied_steps_count";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "revoked_at";--> statement-breakpoint
ALTER TABLE "refresh_tokens" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "playback_events" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "playback_events" DROP COLUMN "track_id";--> statement-breakpoint
ALTER TABLE "playback_events" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "playback_events" DROP COLUMN "seconds_played";--> statement-breakpoint
ALTER TABLE "playback_events" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "platform";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "label";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "url";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "sort_order";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "active";--> statement-breakpoint
ALTER TABLE "social_links" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "used_at";--> statement-breakpoint
ALTER TABLE "password_reset_tokens" DROP COLUMN "created_at";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP COLUMN "expires_at";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP COLUMN "used_at";--> statement-breakpoint
ALTER TABLE "email_verification_tokens" DROP COLUMN "created_at";