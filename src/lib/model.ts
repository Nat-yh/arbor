// 领域模型：工作项树（项目 → 需求 → 任务 → 子任务）

export type Kind = "project" | "feature" | "task";
export type Status = "todo" | "doing" | "review" | "release" | "production-review" | "done" | "blocked" | "cancelled";

export const KIND_LABEL: Record<Kind, string> = { project: "项目", feature: "需求", task: "任务" };

export const STATUS: Record<Status, { label: string; cls: string; bar: string; color: string }> = {
  todo: { label: "未开始", cls: "text-fg-3", bar: "bg-st-todo", color: "text-st-todo" },
  doing: { label: "进行中", cls: "text-fg-2", bar: "bg-st-doing", color: "text-st-doing" },
  review: { label: "待验收", cls: "text-fg-2", bar: "bg-st-review", color: "text-st-review" },
  release: { label: "待发布", cls: "text-fg-2", bar: "bg-st-doing", color: "text-st-doing" },
  "production-review": { label: "待线上验收", cls: "text-fg-2", bar: "bg-st-review", color: "text-st-review" },
  done: { label: "已完成", cls: "text-fg-3", bar: "bg-st-done", color: "text-st-done" },
  cancelled: { label: "已取消", cls: "text-fg-4", bar: "bg-st-cancelled", color: "text-st-cancelled" },
  blocked: { label: "阻塞", cls: "text-danger", bar: "bg-st-blocked", color: "text-st-blocked" },
};

export const isPublishing = (status: Status): status is "release" | "production-review" => status === "release" || status === "production-review";

export const requiresProduction = (item: Pick<WorkItem, "publisher" | "productionRequired">) =>
  item.productionRequired === true || !!item.publisher;

export const statusLabel = (status: Status, item: Pick<WorkItem, "publisher" | "productionRequired">) =>
  status === "review" && requiresProduction(item) ? "待测试验收" : STATUS[status].label;

// ───────── 完成检查项（原「门禁」）─────────
// 含义：把一项工作标记为「已完成」之前，必须确认的事情。项目按需添加，需求按交付场景启用。

export type CheckSource = "通用" | "项目上线" | "AI 应用" | "自定义";

export interface CheckItem {
  id: string;
  label: string;
  source: CheckSource;
  done: boolean;
  required?: boolean;
  doneBy?: string;
  doneAt?: string;
}

interface Tpl {
  label: string;
  source: CheckSource;
  when: (kind: Kind, ai?: boolean) => boolean;
}

export const NO_OPEN_BLOCKING_DEFECTS = "无未关闭的 P0 / P1 缺陷";
const isFeature = (k: Kind) => k === "feature";
const TEMPLATES: Tpl[] = [
  // 需求：通用
  { label: "验收标准已与业务方确认", source: "通用", when: isFeature },
  { label: "代码评审通过（评审人不是开发者本人）", source: "通用", when: isFeature },
  { label: "测试通过", source: "通用", when: isFeature },
  { label: "业务验收通过", source: "通用", when: isFeature },
  { label: NO_OPEN_BLOCKING_DEFECTS, source: "通用", when: isFeature },
  { label: "评测集通过率达到阈值", source: "AI 应用", when: (k, ai) => isFeature(k) && !!ai },
  { label: "单次调用成本不超预算", source: "AI 应用", when: (k, ai) => isFeature(k) && !!ai },
  { label: "Bad Case 已修复或已豁免", source: "AI 应用", when: (k, ai) => isFeature(k) && !!ai },
];

/** 生成完成检查项；doneKeys 中任一关键字命中的项视为已完成 */
export function buildChecklist(kind: Kind, ai?: boolean, doneKeys: string[] | "all" = []): CheckItem[] {
  return TEMPLATES.filter((t) => t.when(kind, ai)).map((t, i) => ({
    id: `c${i}`,
    label: t.label,
    source: t.source,
    done: doneKeys === "all" || doneKeys.some((k) => t.label.includes(k)),
  }));
}

export const ACCEPTANCE_CHECK_ID = "acceptance-criteria";
export const BLOCKING_DEFECT_CHECK_ID = "blocking-defects";
export const DELIVERY_CHECKS = {
  "code-review": { option: "需要代码评审", label: "代码评审通过（由执行人以外的验证人确认）" },
  testing: { option: "需要测试", label: "测试通过" },
} as const;
export type DeliveryCheck = keyof typeof DELIVERY_CHECKS;

export const usesAcceptanceCriteria = (item: Pick<WorkItem, "kind" | "productionRequired" | "checklist">) =>
  item.kind === "feature" && (item.productionRequired === true || item.checklist.some((check) => check.id === ACCEPTANCE_CHECK_ID));
export const hasAcceptanceCriteria = (item: Pick<WorkItem, "acceptance">) =>
  !!item.acceptance?.some((criterion) => criterion.trim());

export function selectedDeliveryChecks(checklist: CheckItem[]): DeliveryCheck[] {
  const options = Object.keys(DELIVERY_CHECKS) as DeliveryCheck[];
  return options.filter((id) => checklist.some((check) => check.id === id && check.required !== false));
}

export function setDeliveryChecks(checklist: CheckItem[], selected: DeliveryCheck[]): CheckItem[] {
  const options = Object.keys(DELIVERY_CHECKS) as DeliveryCheck[];
  const existing = checklist.map((check) => options.includes(check.id as DeliveryCheck)
    ? { ...check, required: selected.includes(check.id as DeliveryCheck) }
    : check);
  return [...existing, ...options.filter((id) => selected.includes(id) && !checklist.some((check) => check.id === id))
    .map((id): CheckItem => ({ id, label: DELIVERY_CHECKS[id].label, source: "通用", done: false }))];
}

export function buildNewChecklist(kind: Kind, ai?: boolean, selected: DeliveryCheck[] = []): CheckItem[] {
  if (kind !== "feature") return [];
  return setDeliveryChecks(buildChecklist(kind, ai).filter((check) => check.source === "AI 应用"), selected);
}

// ───────── 人员 ─────────

export interface Person {
  id: string;
  active?: boolean;
  canReceiveAssignment?: boolean;
  name: string;
  title: string;
  avatarUrl?: string;
  kind: "pm" | "dev" | "qa" | "algo";
  role: "admin" | "member"; // 兼容展示字段，由账号权限推导，数据库不存角色。
}

// 每次加载快照时注册，person() 与现有组件调用方式保持兼容。
export let PEOPLE: Person[] = [];
export function setPeople(people: Person[]) { PEOPLE = people; }
export const person = (id: string): Person => PEOPLE.find((p) => p.id === id) ?? { id, name: id, title: "", kind: "dev", role: "member" };

export const AI_TOOLS = ["Claude Code", "Codex", "Cursor", "纯手工"] as const;
export type AiTool = (typeof AI_TOOLS)[number];

// ───────── 记录类 ─────────

export interface Verification {
  id: string;
  type: "自测" | "自动化测试" | "代码评审" | "业务验收" | "验收" | "模型评测" | "UAT" | "测试验收" | "线上验收";
  by: string;
  result: "通过" | "不通过";
  date: string;
  note: string;
}

export const DEFECT_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export const DEFECT_STAGES = ["自测", "代码评审", "测试", "验收", "线上"] as const;
export type FoundAt = (typeof DEFECT_STAGES)[number];

export interface DefectInput {
  title: string;
  description?: string;
  severity: (typeof DEFECT_SEVERITIES)[number];
  foundAt: FoundAt;
  owner: string;
  attachmentIds?: string[];
}

export interface Defect extends DefectInput {
  id: string;
  status: "open" | "fixed";
  date: string;
  by?: string;
  revision?: number;
}

export interface BadCase {
  id: string;
  input: string;
  expected: string;
  actual: string;
  status: "待处理" | "已修复" | "已豁免";
  by: string;
  date?: string;
}

export interface AiEval {
  dataset: string;
  datasetSize: number;
  metric: string;
  threshold: number;
  costBudget: number; // 元 / 千次
  costPerK: number;
  latencyP95: number;
  model: string;
  prompts: { version: string; date: string; passRate: number; note: string }[];
  badCases: BadCase[];
}

export interface Update {
  id?: string;
  mentions?: { id: string; name: string }[];
  editedAt?: string;
  retractedAt?: string;
  attachmentIds?: string[];
  date: string;
  by: string;
  text: string;
  progress?: number;
  /** 精确时间（ISO），用于同一天内排序；旧数据可能没有 */
  at?: string;
}

export interface Attachment {
  id: string;
  itemId: string;
  uploadedBy: string;
  name: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface Milestone {
  name: string;
  date: string;
  done: boolean;
}

/** 迭代（版本）：挂在项目上，一个项目 = 一个系统，按版本节奏推进 */
export interface Iteration {
  id: string;
  name: string; // 如「V2.1」「第 3 迭代」
  start: string;
  end: string;
  goal?: string;
  closedAt?: string;
  closedBy?: string;
  /** 结束时的快照：计划多少项、完成多少、结转多少、结转到哪个迭代 */
  summary?: { planned: number; done: number; carried: number; to?: string; toName?: string };
}

export interface WorkItem {
  id: string;
  parentId: string | null;
  /** 项目共享的手动子项顺序。 */
  childOrder?: string[];
  kind: Kind;
  title: string;
  desc?: string;
  ai?: boolean; // AI 应用：下层继承，额外带出评测相关检查项
  owner: string; // 负责人：对结果负责
  assignee: string; // 首位执行人，兼容旧记录和客户端
  assignees?: string[]; // 执行人，未设置时读取 assignee
  verifiers: string[]; // 验证人；为空时继承上级
  start: string;
  due: string;
  doneAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  cancellation?: { rootId: string; batch: string; status: Exclude<Status, "cancelled"> };
  archivedAt?: string;
  archiveReason?: string;
  status: Status; // 仅叶子任务手动维护；有子项时由子项汇总
  progress: number; // 叶子任务 0-100
  estimate: number; // 兼容历史记录，实际工作量按排期工作日计算
  aiTool?: AiTool;
  deliverable?: string;
  screenshotIds?: string[];
  productionRequired?: boolean;
  publisher?: string; // 旧实验版标记，发布权限以执行人名单为准
  releaseCycle?: { id: string; scope: string };
  publication?: { id: string; version: string; by: string; at: string };
  blockedReason?: string;
  blockedSince?: string;
  /** 执行人约定的下次进展更新日期。 */
  progressRemindAt?: string;
  /** 当前负责人对本次排期的直接交付确认。 */
  directDelivery?: { owner: string; iterationId: string; start: string; due: string };
  reviewSince?: string;
  reviewToken?: string; // 每轮提交验收的标识，用于提醒去重
  checklist: CheckItem[];
  updates: Update[];
  checks: Verification[];
  defects: Defect[];
  eval?: AiEval;
  milestones?: Milestone[];
  iterations?: Iteration[]; // 仅项目：版本迭代列表
  iteration?: string; // 需求 / 任务所属迭代 ID；为空时沿用上级
  feishuGroup?: string; // 项目飞书群显示名
  feishuChatId?: string; // 飞书项目群 chat_id
  repos?: string[]; // 项目绑定的仓库，一个平台的仓库只属于一个项目
  members?: string[]; // 项目成员（另外，凡是在项目里担任负责人 / 执行人 / 验证人的人自动可见）
  rework?: number; // 验收被打回次数
  pr?: { number: number; url: string; repo: string }; // 关联的合并请求
  acceptance?: string[];
  log: { date: string; by: string; text: string; at?: string; action?: "blocked" | "reopen" }[];
}

type Assignment = Pick<WorkItem, "assignee" | "assignees">;

export function assigneeIds(item: Assignment): string[] {
  return item.assignees ?? (item.assignee ? [item.assignee] : []);
}

export const isAssignee = (item: Assignment, id: string) => assigneeIds(item).includes(id);
export const assigneeNames = (item: Assignment) => assigneeIds(item).map((id) => person(id).name).join("、");

let clientTimezone: string | undefined;
export const appTimezone = () => clientTimezone ?? process.env.APP_TIMEZONE ?? "Asia/Shanghai";
export function setAppTimezone(zone: string) { clientTimezone = zone; }
/** 公历日期，不依赖运行机器的本地时区；客户端使用服务端下发的应用时区。 */
export function today(now = new Date(), timezone = appTimezone()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function dateOffset(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 周一至周五，计入有效的起止日期。 */
export function workingDays(start: string, due: string): number {
  const total = daysBetween(start, due) + 1;
  if (!Number.isFinite(total) || total <= 0) return 0;
  const weekday = new Date(`${start}T00:00:00Z`).getUTCDay();
  let days = Math.floor(total / 7) * 5;
  for (let offset = 0; offset < total % 7; offset++) {
    const day = (weekday + offset) % 7;
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}

export const fmt = (d: string) => d.slice(5).replace("-", "/");
