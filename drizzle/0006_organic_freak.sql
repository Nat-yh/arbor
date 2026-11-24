CREATE TABLE "role_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "role_template_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "role_templates_name_idx" ON "role_templates" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_role_template_id_role_templates_id_fk" FOREIGN KEY ("role_template_id") REFERENCES "public"."role_templates"("id") ON DELETE no action ON UPDATE no action;