CREATE TABLE "notification_log" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"object_id" text NOT NULL,
	"recipient" text NOT NULL,
	"time_window" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"batch" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_log_status_check" CHECK ("notification_log"."status" in ('pending','sent','failed','dry_run','cancelled')),
	CONSTRAINT "notification_log_mode_check" CHECK ("notification_log"."mode" in ('live','dry_run'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_identity_idx" ON "notification_log" USING btree ("type","object_id","recipient","time_window","mode");--> statement-breakpoint
CREATE INDEX "notification_log_status_idx" ON "notification_log" USING btree ("status","mode");--> statement-breakpoint
CREATE INDEX "notification_log_sent_idx" ON "notification_log" USING btree ("sent_at");