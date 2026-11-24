CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'dev' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"menus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope" text DEFAULT 'joined' NOT NULL,
	"projects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"perf" text DEFAULT 'self' NOT NULL,
	"can_create" boolean DEFAULT true NOT NULL,
	"gitee" text,
	"feishu_open_id" text,
	"feishu_union_id" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_feishu_open_id_unique" UNIQUE("feishu_open_id"),
	CONSTRAINT "accounts_feishu_union_id_unique" UNIQUE("feishu_union_id")
);
--> statement-breakpoint
CREATE TABLE "app_meta" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	CONSTRAINT "app_meta_singleton" CHECK ("app_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "repo_events" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_version_positive" CHECK ("work_items"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_parent_id_work_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repo_events_received_idx" ON "repo_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "work_items_parent_idx" ON "work_items" USING btree ("parent_id");