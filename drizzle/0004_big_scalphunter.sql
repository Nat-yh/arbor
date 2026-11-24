CREATE TABLE "draft_screenshots" (
	"id" text PRIMARY KEY NOT NULL,
	"uploaded_by" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "draft_screenshots_size_check" CHECK ("draft_screenshots"."size" > 0 and "draft_screenshots"."size" <= 10485760 and octet_length("draft_screenshots"."content") = "draft_screenshots"."size")
);
--> statement-breakpoint
ALTER TABLE "draft_screenshots" ADD CONSTRAINT "draft_screenshots_uploaded_by_accounts_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_screenshots_expiry_idx" ON "draft_screenshots" USING btree ("expires_at");