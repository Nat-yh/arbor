CREATE TABLE "local_credentials" (
	"account_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	CONSTRAINT "local_credentials_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "member_invitations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"issued_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_credentials" ADD CONSTRAINT "local_credentials_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_issued_by_accounts_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_invitations_expires_idx" ON "member_invitations" USING btree ("expires_at");