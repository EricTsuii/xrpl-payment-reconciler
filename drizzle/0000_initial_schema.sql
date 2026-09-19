CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'DELIVERED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."payment_asset_type" AS ENUM('XRP', 'ISSUED_CURRENCY');--> statement-breakpoint
CREATE TABLE "account_cursors" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_reconciled_ledger" bigint NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"last_error" varchar(1000),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_cursors_last_reconciled_ledger_check" CHECK ("account_cursors"."last_reconciled_ledger" >= 0)
);
--> statement-breakpoint
CREATE TABLE "monitored_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"network_id" integer NOT NULL,
	"address" text NOT NULL,
	"label" varchar(120),
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitored_accounts_network_id_address_key" UNIQUE("network_id","address"),
	CONSTRAINT "monitored_accounts_network_id_check" CHECK ("monitored_accounts"."network_id" BETWEEN 0 AND 65535)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_event_type_aggregate_id_key" UNIQUE("event_type","aggregate_id"),
	CONSTRAINT "outbox_events_event_type_check" CHECK ("outbox_events"."event_type" = 'payment.validated'),
	CONSTRAINT "outbox_events_attempt_count_check" CHECK ("outbox_events"."attempt_count" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"monitored_account_id" uuid NOT NULL,
	"network_id" integer NOT NULL,
	"transaction_hash" char(64) NOT NULL,
	"xrpl_ctid" char(16) NOT NULL,
	"ledger_index" bigint NOT NULL,
	"transaction_index" integer NOT NULL,
	"ledger_hash" char(64) NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"source_account" text NOT NULL,
	"destination_account" text NOT NULL,
	"destination_tag" bigint,
	"asset_type" "payment_asset_type" NOT NULL,
	"currency" text,
	"issuer" text,
	"drops" numeric(30, 0),
	"value" text,
	"transaction_result" text NOT NULL,
	"raw_transaction" jsonb NOT NULL,
	"raw_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_network_id_transaction_hash_key" UNIQUE("network_id","transaction_hash"),
	CONSTRAINT "payments_network_id_xrpl_ctid_key" UNIQUE("network_id","xrpl_ctid"),
	CONSTRAINT "payments_network_id_check" CHECK ("payments"."network_id" BETWEEN 0 AND 65535),
	CONSTRAINT "payments_ledger_index_check" CHECK ("payments"."ledger_index" BETWEEN 0 AND 268435455),
	CONSTRAINT "payments_transaction_index_check" CHECK ("payments"."transaction_index" BETWEEN 0 AND 65535),
	CONSTRAINT "payments_destination_tag_check" CHECK ("payments"."destination_tag" IS NULL OR "payments"."destination_tag" BETWEEN 0 AND 4294967295),
	CONSTRAINT "payments_transaction_hash_check" CHECK ("payments"."transaction_hash" ~ '^[A-F0-9]{64}$'),
	CONSTRAINT "payments_ledger_hash_check" CHECK ("payments"."ledger_hash" ~ '^[A-F0-9]{64}$'),
	CONSTRAINT "payments_xrpl_ctid_check" CHECK ("payments"."xrpl_ctid" ~ '^C[A-F0-9]{15}$'),
	CONSTRAINT "payments_xrp_amount_check" CHECK ("payments"."asset_type" <> 'XRP' OR ("payments"."drops" IS NOT NULL AND "payments"."currency" IS NULL AND "payments"."issuer" IS NULL AND "payments"."value" IS NULL)),
	CONSTRAINT "payments_issued_amount_check" CHECK ("payments"."asset_type" <> 'ISSUED_CURRENCY' OR ("payments"."drops" IS NULL AND "payments"."currency" IS NOT NULL AND "payments"."issuer" IS NOT NULL AND "payments"."value" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "account_cursors" ADD CONSTRAINT "account_cursors_account_id_monitored_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."monitored_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_aggregate_id_payments_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_monitored_account_id_monitored_accounts_id_fk" FOREIGN KEY ("monitored_account_id") REFERENCES "public"."monitored_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at","locked_until") WHERE "outbox_events"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "payments_account_order_idx" ON "payments" USING btree ("monitored_account_id","ledger_index" DESC NULLS LAST,"transaction_index" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_destination_tag_idx" ON "payments" USING btree ("destination_tag") WHERE "payments"."destination_tag" IS NOT NULL;