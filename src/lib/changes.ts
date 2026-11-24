import { assigneeIds, DELIVERY_CHECKS, fmt, selectedDeliveryChecks, type DeliveryCheck, type WorkItem } from "./model";

/**
 * 计划修改的动态文案：只记录真正变化的字段，用中文字段名和人名 / 日期展示，
 * 长文本（说明、验收标准）只提示「修改了」，不展开内容。
 */

export interface FieldChange { key: string; from: unknown; to: unknown }
type NameOf = (id: string) => string;

const LABEL: Record<string, string> = {
  title: "标题", desc: "背景 / 说明", owner: "负责人", assignee: "执行人", assignees: "执行人", verifiers: "验证人", members: "成员",
  start: "开始", due: "截止", estimate: "工作量", aiTool: "AI 工具", ai: "AI 应用", acceptance: "验收标准",
  feishuGroup: "飞书群", feishuChatId: "飞书群 ID", milestones: "里程碑", iteration: "迭代", deliveryChecks: "交付检查", publisher: "发布人",
};
export const planFieldLabel = (key: string) => LABEL[key] ?? key;

export function editFormFields(item: Pick<WorkItem, "kind" | "title" | "owner" | "assignee" | "assignees" | "start" | "due" | "verifiers" | "desc" | "acceptance" | "ai"> & Partial<Pick<WorkItem, "checklist">>) {
  const { title, owner, assignee, start, due, verifiers, desc = "", acceptance = [], ai = false } = item;
  return { title, owner, assignee, assignees: assigneeIds(item), start, due, verifiers, desc, acceptance, ai, deliveryChecks: selectedDeliveryChecks(item.checklist ?? []) };
}

const PEOPLE_ONE = new Set(["owner", "assignee", "publisher"]);
const PEOPLE_MANY = new Set(["assignees", "verifiers", "members"]);
const DATES = new Set(["start", "due"]);
const TEXT_ONLY = new Set(["desc", "acceptance", "milestones"]);

/** 空字符串、空数组、null、undefined、false 视为「未设置」，彼此相等 */
const norm = (v: unknown) => (v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && !v.length) ? null : v);
const same = (a: unknown, b: unknown) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

export function diffPatch(before: object, patch: object): FieldChange[] {
  const b = before as Record<string, unknown>;
  return Object.entries(patch).filter(([k, v]) => !same(b[k], v)).map(([key, to]) => ({ key, from: b[key], to }));
}

function value(key: string, v: unknown, name: NameOf, iteration: NameOf): string {
  if (key === "iteration") return iteration(norm(v) === null ? "" : String(v));
  if (norm(v) === null) return key === "ai" ? "否" : "无";
  if (PEOPLE_ONE.has(key)) return name(String(v));
  if (PEOPLE_MANY.has(key)) return (v as string[]).map(name).join("、");
  if (DATES.has(key)) return fmt(String(v));
  if (key === "estimate") return `${v} 人天`;
  if (key === "ai") return "是";
  if (key === "deliveryChecks") return (v as DeliveryCheck[]).map((id) => DELIVERY_CHECKS[id].option).join("、");
  if (key === "title") return `「${v}」`;
  return String(v);
}

export function describeChange(c: FieldChange, name: NameOf, iteration: NameOf = (id) => id || "待规划"): string {
  const label = planFieldLabel(c.key);
  if (TEXT_ONLY.has(c.key)) return `${label}已更新`;
  if (c.key === "members") {
    const from = (c.from as string[] | undefined) ?? [], to = (c.to as string[] | undefined) ?? [];
    const add = to.filter((x) => !from.includes(x)), del = from.filter((x) => !to.includes(x));
    return [add.length && `加入 ${add.map(name).join("、")}`, del.length && `移出 ${del.map(name).join("、")}`].filter(Boolean).join("，") || `${label}已更新`;
  }
  return `${label}：${value(c.key, c.from, name, iteration)} → ${value(c.key, c.to, name, iteration)}`;
}

export const editLogText = (changes: FieldChange[], name: NameOf, iteration?: NameOf) => `修改了 ${changes.map((c) => describeChange(c, name, iteration)).join("；")}`;

/**
 * 旧版动态写的是原始 JSON：「修改：title："a" → "a"；owner：…」。
 * 解析出字段变化，去掉没变的字段，按新格式展示；解析不了就返回 null，原样显示。
 */
export function parseLegacyEdit(text: string): FieldChange[] | null {
  if (!text.startsWith("修改：")) return null;
  const parts = text.slice(3).split(/；(?=[a-zA-Z]+：)/);
  const out: FieldChange[] = [];
  for (const p of parts) {
    const m = /^([a-zA-Z]+)：([\s\S]*) → ([\s\S]*)$/.exec(p);
    if (!m || !(m[1] in LABEL)) return null;
    const parse = (s: string) => { if (s === "未设置") return undefined; try { return JSON.parse(s); } catch { return s; } };
    out.push({ key: m[1], from: parse(m[2]), to: parse(m[3]) });
  }
  return out.filter((c) => !same(c.from, c.to));
}

/** 展示用：旧格式的修改记录转成可读文案；其余原样返回 */
export function readableLog(text: string, name: NameOf): string {
  const changes = parseLegacyEdit(text);
  if (!changes) return text;
  return changes.length ? editLogText(changes, name) : "保存了属性（没有实际变化）";
}
