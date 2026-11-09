CREATE TABLE "payment_events" (
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
CREATE TABLE "_prisma_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"finished_at" timestamp with time zone,
	"migration_name" text NOT NULL,
	"logs" text,
	"rolled_back_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"applied_steps_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"size_limit" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "preference_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "preference_init_point" text;