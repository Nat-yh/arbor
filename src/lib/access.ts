// 权限按账号保存。内置预设和自定义角色都可以用于填写账号权限。
import { assigneeIds, requiresProduction, isAssignee, type Defect, type Kind, type WorkItem } from "./model";
import type { RepoLogins } from "./repo-providers";
import { childrenOf, descendants, isInactive, projectOf, verifiersOf, type Items } from "./tree";

// team:off 表示显式关闭默认团队入口，保存在原有 JSON 菜单权限中。
export type MenuKey = "projects" | "alerts" | "quality" | "performance" | "settings" | "team" | "team:off";

export const MENUS: { key: MenuKey; label: string; desc: string }[] = [
  { key: "team", label: "团队", desc: "成员负载、可见项目的最近动态；默认管理员和项目负责人可见" },
  { key: "projects", label: "项目", desc: "查看和拆分项目、需求、任务" },
  { key: "alerts", label: "自动提醒", desc: "今日提醒、提醒规则（只读）" },
  { key: "quality", label: "质量中心", desc: "缺陷、验证记录" },
  { key: "performance", label: "绩效看板", desc: "交付效率、质量、主动性指标" },
  { key: "settings", label: "系统设置", desc: "账号权限、提醒规则、飞书接入" },
];

export type Scope = "all" | "joined" | "selected";
export const SCOPES: { key: Scope; label: string; desc: string }[] = [
  { key: "all", label: "全部项目", desc: "能看到系统里所有项目" },
  { key: "joined", label: "参与的项目", desc: "只看自己是成员、负责人、执行人或验证人的项目" },
  { key: "selected", label: "参与的 + 指定项目", desc: "在参与的项目之外，额外开放指定项目（例如给业务方看进度）" },
];

export interface Account {
  id: string;
  active: boolean;
  menus: MenuKey[];
  scope: Scope;
  projects: string[]; // scope = selected 时额外可见的项目
  perf: "all" | "self"; // 有绩效看板菜单时，能看全员还是仅本人
  canCreate: boolean; // 能否新建项目
  roleTemplateId?: string;
  repoLogins?: RepoLogins;
  gitee?: string; // 存储 Gitea 用户名，保留现有字段名；用于匹配 PR 审查人和作者。
}

export type RolePermissions = Pick<Account, "menus" | "scope" | "perf" | "canCreate">;

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  permissions: RolePermissions;
  revision: number;
}
export type RoleId = "admin" | "member" | "guest";

export const ROLES: Record<RoleId, { label: string; desc: string; preset: RolePermissions }> = {
  admin: {
    label: "管理员",
    desc: "看全部项目和绩效，能配置账号权限、提醒规则和飞书",
    preset: { menus: ["projects", "alerts", "quality", "performance", "settings"], scope: "all", perf: "all", canCreate: true },
  },
  member: {
    label: "成员",
    desc: "只看参与的项目，可以新建项目，看不到绩效",
    preset: { menus: ["projects", "alerts", "quality"], scope: "joined", perf: "self", canCreate: true },
  },
  guest: {
    label: "访客",
    desc: "适合业务方或领导：只看指定项目的进度，不能新建",
    preset: { menus: ["projects"], scope: "selected", perf: "self", canCreate: false },
  },
};

export function applyRole(acc: Account, role: RoleId): Account {
  return { ...acc, ...ROLES[role].preset, roleTemplateId: undefined, projects: role === "guest" ? acc.projects : [] };
}

export function applyRoleTemplate(acc: Account, template: RoleTemplate): Account {
  return { ...acc, ...template.permissions, roleTemplateId: template.id, projects: template.permissions.scope === "selected" ? acc.projects : [] };
}

export function sameRolePermissions(a: RolePermissions, b: RolePermissions) {
  return a.scope === b.scope && a.perf === b.perf && a.canCreate === b.canCreate &&
    a.menus.length === b.menus.length && a.menus.every((menu) => b.menus.includes(menu));
}

/** 权限判定沿用内置预设，以及账号当前实际生效的权限。 */
export function roleOf(acc: Account): RoleId | "custom" {
  return (Object.keys(ROLES) as RoleId[]).find((role) => sameRolePermissions(ROLES[role].preset, acc)) ?? "custom";
}

export function accountRoleId(account: Account) {
  return account.roleTemplateId ?? roleOf(account);
}

export function roleLabel(acc: Account, templates?: RoleTemplate[]) {
  const template = templates?.find(({ id }) => id === acc.roleTemplateId);
  if (template) return template.name;
  const role = roleOf(acc);
  return role === "custom" ? "独立权限" : ROLES[role].label;
}

export const isAdmin = (acc: Account) => !!acc.menus?.includes("settings");

/** 项目成员 = 显式添加的成员 + 项目里担任过负责人 / 执行人 / 验证人的人 */
export function membersOf(items: Items, project: WorkItem): string[] {
  const all = [project, ...descendants(items, project.id)];
  return [...new Set([...(project.members ?? []), ...all.flatMap((x) => [x.owner, ...assigneeIds(x), ...x.verifiers])])];
}

export function canSeeProject(items: Items, project: WorkItem, acc: Account, members?: ReadonlySet<string>) {
  if (!acc.active || !acc.menus?.includes("projects")) return false;
  if (acc.scope === "all") return true;
  if (acc.scope === "selected" && acc.projects.includes(project.id)) return true;
  return members ? members.has(acc.id) : membersOf(items, project).includes(acc.id);
}

export const visibleProjects = (items: Items, acc: Account) => childrenOf(items, null).filter((p) => canSeeProject(items, p, acc));

export const canSee = (items: Items, item: WorkItem, acc: Account) => canSeeProject(items, projectOf(items, item), acc);

/** 能管理项目（改成员、改计划）：有系统设置权限的人或项目负责人 */
export const canManage = (items: Items, item: WorkItem, acc: Account) => isAdmin(acc) || projectOf(items, item).owner === acc.id;

export const canMaintainDefect = (items: Items, item: WorkItem, defect: Defect, acc: Account) =>
  acc.menus.includes("quality") && canSee(items, item, acc) && !isInactive(items, item) &&
  (defect.owner === acc.id || canManage(items, item, acc));

export const canAddItemScreenshots = (items: Items, item: WorkItem, acc: Account) =>
  item.kind !== "project" && !isInactive(items, item) && canSee(items, item, acc);

export const canAddChild = (items: Items, parent: WorkItem, acc: Account, kind: Kind = "task") =>
  canManage(items, parent, acc) || isAssignee(parent, acc.id) ||
  (kind === "task" && parent.kind === "feature" && parent.owner === acc.id);

/** 任务负责人可以编辑本项计划，项目级管理权限仍由 canManage 判断。 */
export const canEditPlan = (items: Items, item: WorkItem, acc: Account) =>
  canManage(items, item, acc) || (item.kind === "task" && item.owner === acc.id);

/** 创建事件由服务端写入。旧任务缺少创建记录时，不根据现负责人推断创建人。 */
function isCreatedAndOwnedTask(item: WorkItem, accountId: string): boolean {
  const created = item.log[0];
  return item.kind === "task" && item.owner === accountId && created?.text === "创建任务" && created.by === accountId;
}

export function canRemoveWorkItem(items: Items, item: WorkItem, acc: Account, action: "cancel" | "delete"): boolean {
  if (isInactive(items, item) || !canSee(items, item, acc)) return false;
  if (canManage(items, item, acc)) return true;
  if (!isAssignee(projectOf(items, item), acc.id) || !isCreatedAndOwnedTask(item, acc.id)) return false;

  // 取消会写入整个下级分支，逐一检查本次会改动的工作项。
  return action === "delete" || descendants(items, item.id).every((child) =>
    child.status === "cancelled" || isCreatedAndOwnedTask(child, acc.id));
}

export const canUseTeam = (items: Items, acc: Account) => acc.active && !acc.menus.includes("team:off") && (acc.menus.includes("team") || isAdmin(acc) || visibleProjects(items, acc).some((p) => p.owner === acc.id));

/** 项目需保留独立验证人，需求和任务允许执行人担任验证人。 */
export const verifierAllowed = (item: Pick<WorkItem, "kind" | "assignee" | "assignees">, id: string) => item.kind !== "project" || !isAssignee(item, id);

export const canVerify = (items: Items, item: WorkItem, acc: Account) =>
  (verifierAllowed(item, acc.id) && verifiersOf(items, item).includes(acc.id)) ||
  (!isAssignee(item, acc.id) && isAdmin(acc));

export const canVerifyDelivery = (items: Items, item: WorkItem, acc: Account) =>
  requiresProduction(item) ? verifiersOf(items, item).includes(acc.id) : canVerify(items, item, acc);

export const canCreate = (acc: Account) => acc.active && acc.menus.includes("projects") && acc.canCreate;
