-- JM Music: vínculo determinístico entre pedido/assinatura e lease de webhook.
-- Pré-condição: esta migração aborta se já existirem eventos duplicados
-- para o mesmo provedor e provider_event; não apaga histórico automaticamente.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "order_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_order_id_orders_id_fk'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE "subscriptions"
      ADD CONSTRAINT "subscriptions_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_order_id_key" ON "subscriptions" USING btree ("order_id");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "rentals" r
    LEFT JOIN "orders" o ON o."id" = r."order_id"
    WHERE r."order_id" IS NOT NULL AND o."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Migração abortada: rentals contém order_id sem pedido correspondente. Reconcilie os registros antes de aplicar.';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rentals_order_id_orders_id_fk'
      AND conrelid = 'public.rentals'::regclass
  ) THEN
    ALTER TABLE "rentals"
      ADD CONSTRAINT "rentals_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
-- Um pedido de aluguel concede no máximo um aluguel. Aborta sem apagar
-- registros se o histórico já contiver concessões duplicadas.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "rentals"
    WHERE "order_id" IS NOT NULL
    GROUP BY "order_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migração abortada: há pedidos com mais de um aluguel associado. Reconcilie os registros antes de aplicar.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rentals_order_id_key"
  ON "rentals" USING btree ("order_id");
--> statement-breakpoint
ALTER TABLE "payments_events"
  ADD COLUMN IF NOT EXISTS "processing_at" timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payments_events"
    GROUP BY "provider", "provider_event"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migração abortada: payments_events contém eventos duplicados por provider/provider_event. Faça a reconciliação antes de aplicar.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_events_provider_event_key"
  ON "payments_events" USING btree ("provider", "provider_event");
--> statement-breakpoint
-- Restrições novas são NOT VALID para não apagar/bloquear dados históricos;
-- PostgreSQL as aplica a novas gravações e atualizações. Validar após saneamento.
ALTER TABLE "rental_products"
  ADD CONSTRAINT "rental_products_exactly_one_target"
  CHECK (("track_id" IS NOT NULL AND "album_id" IS NULL) OR ("track_id" IS NULL AND "album_id" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "rental_products"
  ADD CONSTRAINT "rental_products_duration_positive"
  CHECK ("duration_hours" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "rental_products"
  ADD CONSTRAINT "rental_products_price_nonnegative"
  CHECK ("price_cents" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_cents_nonnegative"
  CHECK ("total_cents" >= 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive"
  CHECK ("quantity" > 0) NOT VALID;
--> statement-breakpoint
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_unit_price_nonnegative"
  CHECK ("unit_price_cents" >= 0) NOT VALID;
