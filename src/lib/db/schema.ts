import { boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MenuKey, RolePermissions, Scope } from "../access";
import type { Rule } from "../alerts";
import type { Person, Status, WorkItem } from "../model";
import type { RepoLogins } from "../repo-providers";
import type { SyncRecord } from "../repo-sync";

export const roleTemplates = pgTable("role_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  permissions: jsonb("permissions").$type<RolePermissions>().notNull(),
  revision: integer("revision").notNull().default(1),
}, (t) => [uniqueIndex("role_templates_name_idx").on(sql`lower(${t.name})`)]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull().default(""),
  kind: text("kind").$type<Person["kind"]>().notNull().default("dev"),
  active: boolean("active").notNull().default(true),
  menus: jsonb("menus").$type<MenuKey[]>().notNull().default([]),
  scope: text("scope").$type<Scope>().notNull().default("joined"),
  projects: jsonb("projects").$type<string[]>().notNull().default([]),
  perf: text("perf").$type<"all" | "self">().notNull().default("self"),
  canCreate: boolean("can_create").notNull().default(true),
  roleTemplateId: text("role_template_id").references(() => roleTemplates.id),
  repoLogins: jsonb("repo_logins").$type<RepoLogins>().notNull().default({}),
  gitee: text("gitee"), // 存储 Gitea 用户名，保留现有列名。
  feishuOpenId: text("feishu_open_id").unique(),
  feishuUnionId: text("feishu_union_id").unique(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const localCredentials = pgTable("local_credentials", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  retryAfter: timestamp("retry_after", { withTimezone: true }),
});

export const memberInvitations = pgTable("member_invitations", {
  tokenHash: text("token_hash").primaryKey(),
  issuedBy: text("issued_by").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("member_invitations_expires_idx").on(t.expiresAt)]);

export const workItems = pgTable("work_items", {
  id: text("id").primaryKey(),
  parentId: text("parent_id").references((): AnyPgColumn => workItems.id),
  kind: text("kind").$type<WorkItem["kind"]>().notNull(),
  data: jsonb("data").$type<Omit<WorkItem, "id" | "parentId" | "kind"> & { productionStage?: Extract<Status, "release" | "production-review"> }>().notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("work_items_parent_idx").on(t.parentId), check("work_items_version_positive", sql`${t.version} > 0`)]);

export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<Rule>().notNull(),
});

export const repoEvents = pgTable("repo_events", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<SyncRecord>().notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("repo_events_received_idx").on(t.receivedAt)]);

export const sessions = pgTable("sessions", {
  // Cookie 保存随机令牌，数据库只存 SHA-256 摘要。
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sessions_account_idx").on(t.accountId), index("sessions_expires_idx").on(t.expiresAt)]);

export const appMeta = pgTable("app_meta", {
  id: integer("id").primaryKey().default(1),
}, (t) => [check("app_meta_singleton", sql`${t.id} = 1`)]);

// 每个逻辑通知一行；同一批的多行共享 batch（卡片和 uuid），发送结果逐行保留。
export const notificationLog = pgTable("notification_log", {
  id: text("id").primaryKey(),
  type: text("type").$type<import("../notifications/plan").Notice["type"]>().notNull(),
  objectId: text("object_id").notNull(),
  recipient: text("recipient").notNull(), // account:<内部账号> 或 chat:<chat_id>
  window: text("time_window").notNull(),
  mode: text("mode").$type<"live" | "dry_run">().notNull(),
  status: text("status").$type<"pending" | "sent" | "failed" | "dry_run" | "cancelled">().notNull().default("pending"),
  payload: jsonb("payload").$type<import("../notifications/plan").Notice>().notNull(),
  batch: jsonb("batch").$type<{ id: string; card: import("../feishu/messages").Card }>(),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  messageId: text("message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("notification_log_identity_idx").on(t.type, t.objectId, t.recipient, t.window, t.mode),
  index("notification_log_status_idx").on(t.status, t.mode),
  index("notification_log_sent_idx").on(t.sentAt),
  check("notification_log_status_check", sql`${t.status} in ('pending','sent','failed','dry_run','cancelled')`),
  check("notification_log_mode_check", sql`${t.mode} in ('live','dry_run')`),
]);

// 删除后仍保留动态；不设指向已删除工作项的外键。
export const activityLog = pgTable("activity_log", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<import("../state").Activity>().notNull(),
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey(),
  itemId: text("item_id").notNull().references(() => workItems.id),
  uploadedBy: text("uploaded_by").notNull().references(() => accounts.id),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  content: bytea("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("attachments_item_idx").on(t.itemId), check("attachments_size_check", sql`${t.size} > 0 and ${t.size} <= 10485760 and octet_length(${t.content}) = ${t.size}`)]);

export const draftScreenshots = pgTable("draft_screenshots", {
  id: text("id").primaryKey(),
  uploadedBy: text("uploaded_by").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  content: bytea("content").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [
  index("draft_screenshots_expiry_idx").on(t.expiresAt),
  check("draft_screenshots_size_check", sql`${t.size} > 0 and ${t.size} <= 10485760 and octet_length(${t.content}) = ${t.size}`),
]);
