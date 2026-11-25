import { z } from "zod";
import { isScheduleId, pendingSplit, validScheduleTime } from "./alerts";
import { accountRoleId, applyRole, applyRoleTemplate, ROLES, type Account, type RoleId, sameRolePermissions, type RolePermissions, canAddChild, canAddItemScreenshots, canCreate, canEditPlan, canMaintainDefect, canManage, canRemoveWorkItem, canSee, canVerify, canVerifyDelivery, isAdmin, verifierAllowed } from "./access";
import { assigneeIds, isAssignee, buildNewChecklist, hasAcceptanceCriteria, isPublishing, requiresProduction, selectedDeliveryChecks, setDeliveryChecks, usesAcceptanceCriteria, BLOCKING_DEFECT_CHECK_ID, DEFECT_SEVERITIES, DEFECT_STAGES, STATUS, type CheckItem, type WorkItem } from "./model";
import { REPO_PROVIDERS, repoKey, repoLabel, repoParts, sameRepo } from "./repo-providers";
import { applyRepoEvent, projectOfRepo } from "./repo-sync";
import type { AppState } from "./state";
import { deleteBlockReason, canRestore, restoreTargets, restoredStatus } from "./lifecycle";
import { diffPatch, editFormFields, editLogText, planFieldLabel } from "./changes";
import { attachmentError, MAX_ITEM_SCREENSHOTS } from "./attachments";
import { editableUpdate, hasMention, updateKey } from "./updates";
import { BACKLOG, canReparentTask, childrenOf, descendants, doneInIteration, isCancelled, isInactive, projectOf, aiOf, autoCheck, blockingDefects, byId, isLeaf, iterationIdOf, iterationScope, levelLabel, openChecks, parentIterationOf, releaseScope, statusOf, verifiersOf } from "./tree";

const id = z.string().trim().min(1).max(150);
const text = z.string().max(20000);
const date = z.iso.date();
const ids = z.array(id).max(200);
const screenshotDraftIds = z.array(z.string().regex(/^D[A-F0-9]{32}$/)).max(MAX_ITEM_SCREENSHOTS).optional();
const deliveryChecksInput = z.array(z.enum(["code-review", "testing"])).max(2);
const editable = z.object({
  title: z.string().trim().min(1).max(300), desc: text, owner: id, assignee: id, assignees: ids.min(1), verifiers: ids,
  start: date, due: date, estimate: z.number().positive().max(10000),
  aiTool: z.enum(["Claude Code", "Codex", "Cursor", "纯手工"]).nullable(), ai: z.boolean(),
  acceptance: z.array(text).max(100), feishuGroup: z.string().max(300), feishuChatId: z.string().trim().max(150).regex(/^(oc_[a-zA-Z0-9_-]+)?$/, "请填写 oc_ 开头的飞书 chat_id"), members: ids,
  milestones: z.array(z.object({ name: z.string().min(1).max(300), date, done: z.boolean() }).strict()).max(100),
  iteration: id.nullable(), deliveryChecks: deliveryChecksInput,
}).partial().strict();
const editBaseline = z.object({
  title: text, desc: text, owner: text, assignee: text, start: text, due: text,
  assignees: z.array(text).max(200), verifiers: z.array(text).max(200), acceptance: z.array(text).max(100), ai: z.boolean(), deliveryChecks: deliveryChecksInput,
}).partial().strict();
type EditBaseline = z.infer<typeof editBaseline>;

const iterationInput = z.object({ name: z.string().trim().min(1).max(60), start: date, end: date, goal: z.string().trim().max(500).optional() }).strict();
const rolePermissions = z.object({
  menus: z.array(z.enum(["projects", "alerts", "quality", "performance", "settings", "team", "team:off"])).max(7),
  scope: z.enum(["all", "joined", "selected"]), perf: z.enum(["all", "self"]), canCreate: z.boolean(),
}).strict();
const repoLogin = z.string().trim().max(100).optional();
const repoLogins = z.object({ github: repoLogin, gitlab: repoLogin, gitee: repoLogin }).strict();
const account = rolePermissions.extend({
  id, active: z.boolean(), projects: ids, gitee: z.string().max(100).optional(), roleTemplateId: id.optional(), repoLogins: repoLogins.optional(),
});
const roleTemplateInput = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200),
  permissions: rolePermissions,
}).strict();
const defectInput = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().trim().max(20000).optional(),
  severity: z.enum(DEFECT_SEVERITIES), foundAt: z.enum(DEFECT_STAGES),
  owner: id, attachmentIds: z.array(id).max(10).optional(),
}).strict();
const expectedDelivery = z.object({
  status: z.enum(["todo", "doing", "blocked", "review", "release", "production-review", "done", "cancelled"]),
  reviewToken: id.nullable(),
}).strict().optional();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uploadAttachment"), id, name: z.string().min(1).max(255), mime: z.string().min(1).max(150), size: z.number().int().positive().max(10485760), purpose: z.literal("item-screenshot").optional() }).strict(),
  z.object({ type: z.literal("restore"), id, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("unarchive"), id, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("cancel"), id, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("archive"), id, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("delete"), id, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("addItem"), item: editable.extend({ parentId: id.nullable(), kind: z.enum(["project", "feature", "task"]), title: z.string().trim().min(1).max(300), owner: id, due: date }), screenshotDraftIds }).strict(),
  z.object({ type: z.literal("moveItem"), id, fromParentId: id, targetId: id, toParentId: id.optional(),
    placement: z.enum(["before", "after", "inside"]), confirmed: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("edit"), id, patch: editable, what: text.optional(), expected: editBaseline.optional(), screenshotDraftIds }).strict(),
  z.object({ type: z.literal("toggleCheck"), id, checkId: id }).strict(),
  z.object({ type: z.literal("saveProjectCheck"), id, checkId: id.optional(), label: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("deleteProjectCheck"), id, checkId: id }).strict(),
  z.object({ type: z.literal("saveIteration"), id, iterationId: id.optional(), iteration: iterationInput }).strict(),
  z.object({ type: z.literal("deleteIteration"), id, iterationId: id }).strict(),
  z.object({ type: z.literal("closeIteration"), id, iterationId: id, moveTo: id.nullable() }).strict(),
  z.object({ type: z.literal("setStatus"), id, status: z.enum(["todo", "doing", "done", "blocked"]), reason: text.optional(), expectedDelivery }).strict(),
  z.object({ type: z.literal("submit"), id, deliverable: z.string().trim().min(1).max(2000), note: text, verifiers: ids.optional(), expectedDelivery }).strict(),
  z.object({ type: z.literal("verify"), id, pass: z.boolean(), note: text, expectedDelivery }).strict(),
  z.object({ type: z.literal("publish"), id, cycle: id, version: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("recordReleaseIssue"), id, cycle: id, publicationId: id.nullable(), note: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("verifyProduction"), id, publicationId: id, pass: z.boolean(), note: z.string().trim().max(2000) }).strict(),
  z.object({ type: z.literal("deferProgress"), id, until: date }).strict(),
  z.object({ type: z.literal("confirmDirectDelivery"), id }).strict(),
  z.object({ type: z.literal("postUpdate"), id, text: z.string().trim().min(1).max(20000), progress: z.number().min(0).max(100).optional(), attachmentIds: z.array(id).max(10).optional(), mentionIds: ids.max(20).optional() }).strict(),
  z.object({ type: z.literal("editUpdate"), id, updateId: id, text: z.string().trim().min(1).max(20000), mentionIds: ids.max(20).optional(), expected: text.nullable() }).strict(),
  z.object({ type: z.literal("retractUpdate"), id, updateId: id, expected: text.nullable() }).strict(),
  z.object({ type: z.literal("addDefect"), id, defect: defectInput, requestId: z.uuid().optional() }).strict(),
  z.object({ type: z.literal("editDefect"), id, defectId: id, expected: z.number().int().nonnegative(), defect: defectInput }).strict(),
  z.object({ type: z.literal("fixDefect"), id, defectId: id }).strict(),
  z.object({ type: z.literal("reopenDefect"), id, defectId: id }).strict(),
  z.object({ type: z.literal("addBadCase"), id, badCase: z.object({ input: text.min(1), expected: text, actual: text }).strict() }).strict(),
  z.object({ type: z.literal("setBadCase"), id, caseId: id, status: z.enum(["待处理", "已修复", "已豁免"]) }).strict(),
  z.object({ type: z.literal("setRule"), id, patch: z.object({ enabled: z.boolean().optional(), n: z.number().min(0).max(365).optional(), scheduleTime: z.string().refine(validScheduleTime).optional() }).strict() }).strict(),
  z.object({ type: z.literal("setAccount"), id, account }).strict(),
  z.object({ type: z.literal("setMember"), id, active: z.boolean(), gitee: repoLogin, repoLogins: repoLogins.optional(), roleId: id.optional() }).strict(),
  z.object({ type: z.literal("moveRoleMembers"), roleId: id,
    members: z.array(z.object({ id, fromRoleId: id }).strict()).min(1).max(200),
  }).strict(),
  z.object({ type: z.literal("saveRoleTemplate"), id: id.optional(), expectedRevision: z.number().int().positive().optional(), template: roleTemplateInput }).strict(),
  z.object({ type: z.literal("deleteRoleTemplate"), id }).strict(),
  z.object({ type: z.literal("bindRepo"), id, repo: z.string().min(1).max(300), provider: z.enum(REPO_PROVIDERS).optional() }).strict(),
  z.object({ type: z.literal("unbindRepo"), id, repo: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal("linkRepoEvent"), eventId: id, itemId: id }).strict(),
  z.object({ type: z.literal("ignoreRepoEvent"), eventId: id }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export interface CommandContext { accountId: string; today: string; newId: string; /** 精确时间，缺省取当前时间；用于动态在同一天内排序 */ now?: string }
export interface CommandResult { ok: boolean; reason?: string; id?: string; expiresAt?: string; retryScreenshots?: boolean; conflicts?: EditBaseline }
export class CommandError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
export class EditConflict extends CommandError {
  constructor(public conflicts: EditBaseline, fields: string[]) {
    super(`${fields.map(planFieldLabel).join("、")}已被其他人更新。`, 409);
  }
}
function requireThat(condition: unknown, message: string, status = 403): asserts condition {
  if (!condition) throw new CommandError(message, status);
}

function validatePermissionMenus({ menus }: RolePermissions) {
  requireThat(new Set(menus).size === menus.length, "菜单权限不能重复", 400);
  requireThat(!(menus.includes("team") && menus.includes("team:off")), "团队权限不能同时开启和关闭", 400);
}

function requireActiveAdmin(state: AppState) {
  requireThat(state.accounts.some((a) => a.active && isAdmin(a)), "至少要保留一个能进入「系统设置」的启用账号");
}

function roleAssignment(state: AppState, roleId: string) {
  if (Object.hasOwn(ROLES, roleId)) return (account: Account) => applyRole(account, roleId as RoleId);
  const role = state.roleTemplates?.find(({ id }) => id === roleId);
  requireThat(role, "角色已删除，请重新选择", 409);
  return (account: Account) => applyRoleTemplate(account, role);
}

/** 同步纯函数：时间与 ID 由调用方提供；失败抛错，输入快照不会被改动。 */
export function applyCommand(input: AppState, ctx: CommandContext, raw: unknown): { state: AppState; result: CommandResult } {
  const parsed = commandSchema.safeParse(raw);
  requireThat(parsed.success, "命令参数无效或包含不允许修改的字段", 400);
  const cmd = parsed.data;
  const state = structuredClone(input);
  const acc = state.accounts.find((a) => a.id === ctx.accountId);
  requireThat(acc?.active, "账号未登录或已停用", 401);
  const admin = () => requireThat(isAdmin(acc), "需要系统设置权限");
  const now = ctx.now ?? new Date().toISOString();
  const entry = (text: string) => ({ date: ctx.today, by: acc.id, text, at: now });
  const get = (itemId: string) => {
    const x = byId(state.items, itemId);
    requireThat(x && canSee(state.items, x, acc), "工作项不存在或无访问权限");
    requireThat(!isInactive(state.items, x), "工作项已取消或项目已归档，不能修改", 400);
    return x;
  };
  if ("expectedDelivery" in cmd && cmd.expectedDelivery) {
    const item = get(cmd.id);
    const from = cmd.expectedDelivery;
    requireThat(statusOf(state.items, item) === from.status &&
      (from.status !== "review" || (item.reviewToken ?? null) === from.reviewToken),
    "交付状态已变化，请刷新后再移动", 409);
  }
  const manage = (x: WorkItem) => requireThat(canManage(state.items, x, acc), "只有项目负责人或管理员能管理项目计划");
  const doer = (x: WorkItem) => requireThat(isAssignee(x, acc.id) || canManage(state.items, x, acc), "只有执行人或可管理者能修改进度和状态");
  const quality = () => requireThat(acc.menus.includes("quality"), "需要质量中心权限");
  const checkAttachments = (itemId: string, refs: string[] = []) => {
    requireThat(new Set(refs).size === refs.length && refs.every((id) => state.attachments?.some((a) => a.id === id && a.itemId === itemId && a.uploadedBy === acc.id)), "附件不存在、属于其他工作项或不是本人上传", 400);
  };
  const peopleExist = (values: string[]) => requireThat(values.every((v) => state.accounts.some((a) => a.id === v && a.active)), "请指定启用中的人员", 400);
  const defectOwner = (item: WorkItem, id: string) => {
    const owner = state.accounts.find((account) => account.id === id);
    requireThat(owner && canSee(state.items, item, owner), "请选择能查看此工作项的启用人员为缺陷负责人", 400);
  };
  const mentionedPeople = (item: WorkItem, text: string, ids: string[] = [], previous: NonNullable<WorkItem["updates"][number]["mentions"]> = []) =>
    [...new Set(ids)].filter((id) => id !== acc.id).flatMap((id) => {
      const name = previous.find((p) => p.id === id)?.name ?? state.people.find((p) => p.id === id)?.name;
      if (!name || !hasMention(text, name)) return [];
      const target = state.accounts.find((account) => account.id === id);
      requireThat(target && canSee(state.items, item, target), "被提及的成员已无法查看此工作项，请移除后重试", 400);
      return [{ id, name }];
    });
  const change = (x: WorkItem, patch: Partial<WorkItem>, log?: string) => {
    const next = { ...x, ...patch, log: log ? [...x.log, entry(log)] : x.log };
    state.items = state.items.map((i) => i.id === x.id ? next : i);
    return next;
  };
  // 更新分组的数据库记录前，保存上层列表的当前顺序。
  const preserveAncestorOrder = (item: WorkItem) => {
    let parentId = item.parentId;
    while (parentId) {
      const parent = byId(state.items, parentId)!;
      if (!parent.childOrder) change(parent, { childOrder: childrenOf(state.items, parent.id).map((i) => i.id) });
      parentId = parent.parentId;
    }
  };
  const ensureChecks = (item: WorkItem) => {
    if (usesAcceptanceCriteria(item)) requireThat(hasAcceptanceCriteria(item), "请先填写验收标准", 400);
    const pending = openChecks(state.items, item);
    if (!pending.length) return;
    if (!usesAcceptanceCriteria(item)) throw new CommandError("还有完成检查项未确认，不能通过验收", 400);
    const labels = pending.map(({ id, label }) => id === BLOCKING_DEFECT_CHECK_ID
      ? blockingDefects(state.items, item).map((defect) => `${defect.severity}「${defect.title}」尚未关闭`).join("、")
      : label);
    throw new CommandError(`请先处理：${labels.join("、")}`, 400);
  };
  const assignments = (input: { assignee?: string; assignees?: string[] }, previous?: WorkItem) => {
    if (input.assignees) {
      requireThat(new Set(input.assignees).size === input.assignees.length, "执行人不能重复", 400);
      requireThat(input.assignee === undefined || input.assignee === input.assignees[0], "执行人字段不一致", 400);
      return input.assignees;
    }
    // 旧客户端只修改首位，保留其他已指派人员。
    if (input.assignee && previous?.assignees) {
      return [input.assignee, ...previous.assignees.slice(1).filter((id) => id !== input.assignee)];
    }
  };
  const validatePlan = (x: WorkItem, previous?: WorkItem) => {
    const newlyAssigned = assigneeIds(x).filter((id) => !previous || !isAssignee(previous, id));
    // 历史记录可以继续引用停用人员；新指派必须是启用人员。
    peopleExist([
      ...(x.owner !== previous?.owner ? [x.owner] : []),
      ...newlyAssigned,
      ...x.verifiers.filter((v) => !previous?.verifiers.includes(v)),
      ...(x.members ?? []).filter((v) => !previous?.members?.includes(v)),
    ]);
    requireThat(newlyAssigned.every((id) => state.accounts.some((a) => a.id === id && a.menus.includes("projects"))), "执行人需要有项目访问权限", 400);
    requireThat(x.start <= x.due, "截止日期不能早于开始日期", 400);
    requireThat(!x.verifiers.length || x.verifiers.some((v) => verifierAllowed(x, v)), "验证人不能只有执行人自己", 400);
  };
  const iterationById = (x: WorkItem, iterationId?: string) => (iterationId ? projectOf(state.items, x).iterations?.find((i) => i.id === iterationId) : undefined);
  /**
   * 归入迭代：只能进入本项目未结束的迭代——直接指定或经由沿用上级都一样。
   * 实际归属没变时不校验（已结束迭代的历史归属可以保留）。
   */
  const validateIteration = (x: WorkItem, previous?: WorkItem) => {
    if (x.iteration) requireThat(x.kind !== "project", "项目本身不能归入迭代", 400);
    if (x.iteration && x.iteration !== BACKLOG && x.iteration !== previous?.iteration) requireThat(iterationById(x, x.iteration), "迭代不存在或不属于这个项目", 400);
    const effective = x.iteration ? (x.iteration === BACKLOG ? undefined : x.iteration) : parentIterationOf(state.items, x);
    const before = previous ? iterationIdOf(state.items, previous) : undefined;
    const it = iterationById(x, effective);
    if (it?.closedAt && effective !== before) throw new CommandError(x.iteration ? `迭代「${it.name}」已结束，不能再归入` : `上级所在的迭代「${it.name}」已结束，请选择一个迭代或「待规划」`, 400);
  };
  const iterationName = (x: WorkItem, iterationId?: string | null) => (iterationId && iterationId !== BACKLOG ? iterationById(x, iterationId)?.name ?? iterationId : "待规划");
  let result: CommandResult = { ok: true };

  switch (cmd.type) {
    case "uploadAttachment": {
      const x = get(cmd.id);
      const error = attachmentError(cmd);
      requireThat(!error, error ?? "附件参数无效", 400);
      requireThat(!(state.attachments ?? []).some((a) => a.id === ctx.newId), "附件 ID 冲突", 409);
      if (cmd.purpose === "item-screenshot") {
        requireThat(canAddItemScreenshots(state.items, x, acc), "你没有权限为这个需求或任务上传截图");
        requireThat(cmd.mime.startsWith("image/"), "请选择图片作为截图", 400);
        const screenshots = x.screenshotIds ?? [];
        requireThat(screenshots.length < MAX_ITEM_SCREENSHOTS, `每个工作项最多上传 ${MAX_ITEM_SCREENSHOTS} 张截图`, 400);
        change(x, { screenshotIds: [...screenshots, ctx.newId] }, `上传截图「${cmd.name}」`);
      }
      state.attachments = [...(state.attachments ?? []), { id: ctx.newId, itemId: x.id, uploadedBy: acc.id, name: cmd.name, mime: cmd.mime, size: cmd.size, createdAt: now }];
      result.id = ctx.newId;
      break;
    }
    case "cancel": {
      const x = get(cmd.id);
      requireThat(canRemoveWorkItem(state.items, x, acc, "cancel"),
        "项目执行人只能取消本人创建并负责的任务，且不能连带取消他人的子任务。也可请项目负责人或管理员处理。");
      const ids = new Set([x.id, ...descendants(state.items, x.id).map((i) => i.id)]);
      for (const target of state.items.filter((i) => ids.has(i.id) && i.status !== "cancelled")) change(target, { status: "cancelled", cancelledAt: ctx.today, cancelReason: cmd.reason, cancellation: { rootId: x.id, batch: ctx.newId, status: target.status as Exclude<WorkItem["status"], "cancelled"> } }, `取消${target.id !== x.id ? `（随上级「${x.title}」）` : ""}：${cmd.reason}`);
      break;
    }
    case "restore":
    case "unarchive": {
      const x = byId(state.items, cmd.id);
      requireThat(x && canSee(state.items, x, acc), "工作项不存在或无访问权限");
      manage(x);
      if (cmd.type === "unarchive") {
        requireThat(x.kind === "project" && x.archivedAt, "只有已归档项目可以解除归档", 400);
        change(x, { archivedAt: undefined, archiveReason: undefined }, `解除归档：${cmd.reason}`);
      } else {
        requireThat(canRestore(state.items, x), "请先恢复上级或解除项目归档，且本项必须已取消", 400);
        for (const target of restoreTargets(state.items, x)) change(target, { status: restoredStatus(target), cancelledAt: undefined, cancelReason: undefined, cancellation: undefined }, `恢复${target.id !== x.id ? `（随上级「${x.title}」）` : ""}：${cmd.reason}`);
      }
      break;
    }
    case "archive": {
      const x = get(cmd.id); manage(x);
      requireThat(x.kind === "project", "只有项目可以归档", 400);
      change(x, { archivedAt: ctx.today, archiveReason: cmd.reason }, `归档项目：${cmd.reason}`);
      break;
    }
    case "delete": {
      const x = get(cmd.id);
      requireThat(canRemoveWorkItem(state.items, x, acc, "delete"),
        "项目执行人只能删除本人创建并负责的任务。也可请项目负责人或管理员处理。");
      const blocked = deleteBlockReason(state, x, ctx.today);
      if (blocked) throw new CommandError(x.kind === "project"
        ? "只有当天刚创建、没有动态、子项或关联记录的项才能真删除，请改用取消或归档"
        : `当前工作项${blocked}，无法删除，可以改用取消。`, 400);
      const text = `删除「${x.title}」（${x.id}）：${cmd.reason}`;
      state.activities = [...(state.activities ?? []), { id: ctx.newId, itemId: x.id, projectId: projectOf(state.items, x).id, title: x.title, ...entry(text) }];
      if (x.parentId) {
        const parent = byId(state.items, x.parentId)!;
        change(parent, parent.childOrder ? { childOrder: parent.childOrder.filter((id) => id !== x.id) } : {}, text);
      }
      state.items = state.items.filter((i) => i.id !== x.id);
      break;
    }
    case "setMember": {
      admin();
      const account = state.accounts.find((member) => member.id === cmd.id);
      requireThat(account, "账号不存在", 404);
      const profile = {
        ...account, active: cmd.active,
        gitee: cmd.gitee === undefined ? account.gitee : cmd.gitee || undefined,
        repoLogins: cmd.repoLogins ?? account.repoLogins,
      };
      const next = cmd.roleId ? roleAssignment(state, cmd.roleId)(profile) : profile;
      state.accounts = state.accounts.map((member) => member.id === cmd.id ? next : member);
      requireActiveAdmin(state);
      break;
    }
    case "moveRoleMembers": {
      admin();
      const assign = roleAssignment(state, cmd.roleId);
      const sourceRoles = new Map(cmd.members.map(({ id, fromRoleId }) => [id, fromRoleId]));
      requireThat(sourceRoles.size === cmd.members.length, "成员不能重复", 400);
      for (const [id, fromRoleId] of sourceRoles) {
        const member = state.accounts.find((account) => account.id === id);
        requireThat(member, "成员已不存在，请刷新后再操作", 409);
        const current = accountRoleId(member);
        requireThat(current === fromRoleId || current === cmd.roleId, "成员角色已变更，请刷新后再操作", 409);
      }
      state.accounts = state.accounts.map((member) =>
        sourceRoles.has(member.id) && accountRoleId(member) !== cmd.roleId ? assign(member) : member);
      requireActiveAdmin(state);
      break;
    }
    case "setAccount": {
      admin();
      requireThat(cmd.account.id === cmd.id && state.accounts.some((a) => a.id === cmd.id), "账号不存在或 ID 不匹配", 400);
      validatePermissionMenus(cmd.account);
      requireThat(cmd.account.projects.every((p) => state.items.some((x) => x.id === p && x.kind === "project")), "指定项目不存在", 400);
      if (cmd.account.roleTemplateId) {
        const template = state.roleTemplates?.find((role) => role.id === cmd.account.roleTemplateId);
        requireThat(template && sameRolePermissions(template.permissions, cmd.account), "角色已变更，请刷新后重新选择", 409);
      }
      state.accounts = state.accounts.map((a) => a.id === cmd.id ? { ...cmd.account, repoLogins: cmd.account.repoLogins ?? a.repoLogins } : a);
      requireActiveAdmin(state);
      break;
    }
    case "saveRoleTemplate": {
      admin();
      const templates = state.roleTemplates ?? [];
      const existing = templates.find((role) => role.id === cmd.id);
      if (cmd.id) requireThat(existing?.revision === cmd.expectedRevision && existing, "角色已变更，请刷新后再编辑", 409);
      validatePermissionMenus(cmd.template.permissions);
      const name = cmd.template.name.toLowerCase();
      const reservedNames = [...Object.values(ROLES).map(({ label }) => label), "自定义", "独立权限"];
      requireThat(!reservedNames.includes(name) && !templates.some((role) => role.id !== cmd.id && role.name.toLowerCase() === name),
        "已有同名角色，请使用其他名称", 409);
      if (existing?.name === cmd.template.name && existing.description === cmd.template.description &&
          sameRolePermissions(existing.permissions, cmd.template.permissions)) break;
      const template = { ...cmd.template, id: cmd.id ?? ctx.newId, revision: (existing?.revision ?? 0) + 1 };
      state.roleTemplates = existing
        ? templates.map((role) => role.id === template.id ? template : role)
        : [...templates, template];
      if (existing && !sameRolePermissions(existing.permissions, template.permissions)) {
        state.accounts = state.accounts.map((a) => a.roleTemplateId === template.id ? applyRoleTemplate(a, template) : a);
        requireActiveAdmin(state);
      }
      break;
    }
    case "deleteRoleTemplate": {
      admin();
      const templates = state.roleTemplates ?? [];
      requireThat(templates.some((role) => role.id === cmd.id), "角色不存在", 404);
      requireThat(!state.accounts.some((a) => a.roleTemplateId === cmd.id), "请先为使用此角色的成员更换角色", 409);
      state.roleTemplates = templates.filter((role) => role.id !== cmd.id);
      break;
    }
    case "setRule": {
      admin();
      const rule = state.rules.find((r) => r.id === cmd.id);
      requireThat(rule, "提醒规则不存在", 400);
      requireThat(cmd.patch.scheduleTime === undefined || (rule.kind === "schedule" && isScheduleId(rule.id)), "此规则没有固定发送时间", 400);
      state.rules = state.rules.map((r) => r.id === cmd.id ? { ...r, ...cmd.patch } : r);
      break;
    }
    case "addItem": {
      const p = cmd.item;
      const parent = p.parentId ? get(p.parentId) : undefined;
      if (!parent) requireThat(p.kind === "project" && canCreate(acc), "没有新建项目权限");
      else {
        requireThat(p.kind !== "project", "项目不能嵌套", 400);
        requireThat(canAddChild(state.items, parent, acc, p.kind), "只有执行人、需求负责人或项目管理者可以添加下级任务");
        requireThat(levelLabel(state.items, parent) !== "子任务", "子任务下不能继续拆分", 400);
      }
      requireThat(!state.items.some((x) => x.id === ctx.newId), "工作项 ID 冲突", 409);
      const { aiTool, iteration, deliveryChecks, assignees: _assignees, ...plan } = p;
      requireThat(p.kind === "feature" || deliveryChecks === undefined, "只有需求能设置交付检查", 400);
      const assigned = assignments(p);
      void _assignees;
      requireThat(p.kind === "project" || (p.feishuGroup === undefined && p.feishuChatId === undefined), "只有项目能绑定飞书群", 400);
      const item: WorkItem = {
        assignee: p.owner, verifiers: [], start: ctx.today, status: "todo", progress: 0, estimate: 1,
        checklist: buildNewChecklist(p.kind, p.ai ?? (parent ? aiOf(state.items, parent) : false), deliveryChecks), updates: [], checks: [], defects: [], log: [entry(`创建${p.kind === "project" ? "项目" : p.kind === "feature" ? "需求" : "任务"}`)],
        ...plan, ...(p.kind === "feature" ? { productionRequired: true } : {}), ...(assigned ? { assignee: assigned[0], assignees: assigned } : {}), id: ctx.newId, aiTool: aiTool ?? undefined, iteration: iteration ?? undefined,
      };
      if (!item.iteration) delete item.iteration;
      // 上级所在迭代已结束（比如重新打开后补拆子任务）：新项放进待规划，不混进已结束的迭代
      if (!item.iteration && parent && iterationById(parent, parentIterationOf(state.items, item))?.closedAt) item.iteration = BACKLOG;
      if (item.iteration === BACKLOG && !parentIterationOf(state.items, item)) delete item.iteration;
      if (!parent) item.members = [...new Set([...(p.members ?? []), acc.id])];
      validatePlan(item); validateIteration(item);
      if (parent) {
        preserveAncestorOrder(parent);
        const siblings = childrenOf(state.items, parent.id);
        change(parent, { childOrder: [item.id, ...siblings.map((x) => x.id)] },
          siblings.length === 0 ? "拆分出子任务，进度和状态改为由子任务汇总" : undefined);
      }
      state.items.push(item);
      result = { ok: true, id: item.id };
      break;
    }
    case "moveItem": {
      const x = get(cmd.id);
      manage(x);
      requireThat(x.kind !== "project" && x.parentId, "项目不能移动", 400);
      requireThat(x.parentId === cmd.fromParentId, "原归属已变更，请刷新列表后重试", 409);
      const parent = get(x.parentId);
      const target = get(cmd.targetId);
      requireThat(x.id !== target.id, "不能移动到自身", 400);

      const destination = cmd.placement === "inside" ? target : cmd.toParentId ? get(cmd.toParentId) : parent;
      if (cmd.placement !== "inside") {
        requireThat(target.parentId === destination.id, "排序目标已不在所选归属下，请刷新列表后重试", 409);
      }
      const transferring = parent.id !== destination.id;
      if (cmd.placement === "inside" || transferring) {
        requireThat(cmd.confirmed, "请确认转移任务", 400);
        requireThat(canReparentTask(state.items, x, destination), "无法移到此处。请选择同一项目内可拆分的需求或任务", 400);
      }

      const before = childrenOf(state.items, destination.id).map((i) => i.id);
      const order = before.filter((id) => id !== x.id);
      const index = cmd.placement === "inside" ? order.length : order.indexOf(target.id) + (cmd.placement === "after" ? 1 : 0);
      order.splice(index, 0, x.id);
      if (!transferring && before.every((id, index) => id === order[index])) break;

      preserveAncestorOrder(parent);
      if (transferring) preserveAncestorOrder(destination);

      if (transferring) {
        // 保留当前迭代，包括待规划及已结束迭代中的历史归属。
        const current = iterationIdOf(state.items, x);
        const inherited = iterationIdOf(state.items, destination);
        const iteration = x.iteration ?? (current === inherited ? undefined : current ?? BACKLOG);
        change(x, { parentId: destination.id, ...(iteration ? { iteration } : {}) }, `归属从「${parent.title}」改为「${destination.title}」`);
        const original = byId(state.items, parent.id)!;
        if (original.childOrder) change(original, { childOrder: original.childOrder.filter((id) => id !== x.id) });
      }
      change(byId(state.items, destination.id)!, { childOrder: order });
      break;
    }
    case "edit": {
      const x = get(cmd.id);
      const screenshotsOnly = !!cmd.screenshotDraftIds?.length && Object.keys(cmd.patch).length === 0 && canAddItemScreenshots(state.items, x, acc);
      requireThat(canEditPlan(state.items, x, acc) || screenshotsOnly, x.kind === "task"
        ? "只有该任务的负责人、项目负责人或管理员能编辑属性"
        : "只有项目负责人或管理员能编辑属性");
      if (screenshotsOnly) break;
      requireThat(x.kind === "project" || (!cmd.patch.members && cmd.patch.feishuGroup === undefined && cmd.patch.feishuChatId === undefined && !cmd.patch.milestones), "只有项目能设置成员、群和里程碑", 400);
      const assigned = assignments(cmd.patch, x);
      const { deliveryChecks, ...plan } = cmd.patch;
      requireThat(deliveryChecks === undefined || usesAcceptanceCriteria(x), "仅新建规则下的需求可调整交付检查", 400);
      if (deliveryChecks !== undefined) requireThat(statusOf(state.items, x) !== "done", "请先重新打开已完成的需求", 400);
      const patch: Partial<WorkItem> = { ...plan, ...(cmd.patch.aiTool !== undefined ? { aiTool: cmd.patch.aiTool ?? undefined } : {}), ...(cmd.patch.iteration !== undefined ? { iteration: cmd.patch.iteration ?? undefined } : {}) } as Partial<WorkItem>;
      if (assigned) {
        patch.assignee = assigned[0];
        patch.assignees = assigned;
      }
      // 在事务锁内比较原值，只拦截本次实际写入且已被他人修改的字段。
      const nextDeliveryChecks = deliveryChecks === undefined ? undefined : [...new Set(deliveryChecks)].sort();
      const changes = diffPatch({
        ...x, assignees: assigned ? assigneeIds(x) : x.assignees, deliveryChecks: selectedDeliveryChecks(x.checklist),
      }, { ...patch, ...(nextDeliveryChecks !== undefined ? { deliveryChecks: nextDeliveryChecks } : {}) });
      if (nextDeliveryChecks !== undefined && changes.some(({ key }) => key === "deliveryChecks")) {
        patch.checklist = setDeliveryChecks(x.checklist, nextDeliveryChecks);
      }
      if (cmd.expected) {
        const fields = new Set(changes.map(({ key }) => key));
        const conflicts = diffPatch(editFormFields(x), cmd.expected).filter(({ key }) => fields.has(key));
        if (conflicts.length) throw new EditConflict(
          Object.fromEntries(conflicts.map(({ key, from }) => [key, from])),
          conflicts.map(({ key }) => key),
        );
      }
      const next = { ...x, ...patch }; validatePlan(next, x); validateIteration(next, x);
      // 只记录真正变化的字段，用人名 / 日期展示；没有变化就不写动态
      if (changes.length) change(x, patch, editLogText(changes.filter(({ key }) => key !== "assignee" || !assigned), (pid) => state.people.find((p) => p.id === pid)?.name ?? pid, (iid) => iterationName(x, iid)));
      break;
    }
    case "saveIteration": {
      const x = get(cmd.id); manage(x);
      requireThat(x.kind === "project", "只有项目能设置迭代", 400);
      const input = { ...cmd.iteration, goal: cmd.iteration.goal || undefined };
      requireThat(input.start <= input.end, "迭代结束日期不能早于开始日期", 400);
      const list = x.iterations ?? [];
      requireThat(!list.some((i) => i.id !== cmd.iterationId && i.name === input.name), `已有名为「${input.name}」的迭代`, 400);
      if (cmd.iterationId) {
        const old = list.find((i) => i.id === cmd.iterationId);
        requireThat(old, "迭代不存在", 400);
        requireThat(!old.closedAt, "已结束的迭代不能修改", 400);
        const what = [old.name !== input.name && `名称 ${old.name} → ${input.name}`, (old.start !== input.start || old.end !== input.end) && `时间 ${old.start}~${old.end} → ${input.start}~${input.end}`, (old.goal ?? "") !== (input.goal ?? "") && "目标"].filter(Boolean);
        if (what.length) change(x, { iterations: list.map((i) => i.id === old.id ? { ...old, ...input } : i) }, `修改迭代「${old.name}」：${what.join("，")}`);
      } else {
        requireThat(list.length < 200, "迭代数量过多", 400);
        requireThat(!list.some((i) => i.id === ctx.newId), "迭代 ID 冲突", 409);
        change(x, { iterations: [...list, { id: ctx.newId, ...input }] }, `新建迭代「${input.name}」（${input.start} ~ ${input.end}）`);
        result.id = ctx.newId;
      }
      break;
    }
    case "deleteIteration": {
      const x = get(cmd.id); manage(x);
      const it = x.iterations?.find((i) => i.id === cmd.iterationId);
      requireThat(it, "迭代不存在", 400);
      requireThat(!it.closedAt, "已结束的迭代保留为历史记录，不能删除", 400);
      const refs = descendants(state.items, x.id).filter((d) => d.iteration === it.id);
      requireThat(refs.every((d) => isInactive(state.items, d)), "迭代里还有工作项，请先移出或结束迭代", 400);
      // 已取消的项不能再编辑，删除迭代时顺带清掉它们的归属
      for (const d of refs) change(d, { iteration: undefined });
      const project = byId(state.items, x.id)!;
      change(project, { iterations: project.iterations!.filter((i) => i.id !== it.id) }, `删除迭代「${it.name}」`);
      break;
    }
    case "closeIteration": {
      const x = get(cmd.id); manage(x);
      const list = x.iterations ?? [];
      const it = list.find((i) => i.id === cmd.iterationId);
      requireThat(it && !it.closedAt, "迭代不存在或已结束", 400);
      if (cmd.moveTo) {
        const to = list.find((i) => i.id === cmd.moveTo);
        requireThat(to && !to.closedAt && to.id !== it.id, "结转目标必须是本项目另一个未结束的迭代", 400);
      }
      const scope = iterationScope(state.items, x, it.id);
      const unfinished = scope.filter((s) => !doneInIteration(state.items, s, it.id));
      const toName = iterationName(x, cmd.moveTo);
      for (const u of unfinished) {
        // 已完成和已取消的下级留在本迭代，保持历史；只有没做完的部分跟着上级结转
        for (const d of descendants(state.items, u.id)) {
          const keep = isCancelled(state.items, d) || statusOf(state.items, d) === "done";
          if (keep && !d.iteration && iterationIdOf(state.items, d) === it.id) change(d, { iteration: it.id });
          // 下级自己也写了本迭代、但没做完：清掉自身设置，跟着上级一起结转
          else if (!keep && d.iteration === it.id) change(d, { iteration: undefined });
        }
        // 嵌套项选「待规划」时要明确标记，否则会沿用上级的迭代
        const moved = change(u, { iteration: cmd.moveTo ?? (parentIterationOf(state.items, u) ? BACKLOG : undefined) });
        change(moved, {}, `迭代「${it.name}」结束，未完成，结转到「${iterationName(moved, iterationIdOf(state.items, moved))}」`);
      }
      const summary = { planned: scope.length, done: scope.length - unfinished.length, carried: unfinished.length, ...(cmd.moveTo ? { to: cmd.moveTo, toName } : {}) };
      const project = byId(state.items, x.id)!;
      change(project, { iterations: (project.iterations ?? []).map((i) => i.id === it.id ? { ...i, closedAt: ctx.today, closedBy: acc.id, summary } : i) }, `结束迭代「${it.name}」：完成 ${summary.done}/${summary.planned}${unfinished.length ? `，${unfinished.length} 项结转到「${toName}」` : ""}`);
      break;
    }
    case "saveProjectCheck":
    case "deleteProjectCheck": {
      const x = get(cmd.id);
      requireThat(x.kind === "project", "仅支持调整项目检查项", 400);
      manage(x);
      const existing = x.checklist.find((check) => check.id === cmd.checkId);
      if (cmd.type === "deleteProjectCheck") {
        requireThat(existing, "检查项不存在", 400);
        change(x, { checklist: x.checklist.filter((check) => check.id !== existing.id) }, `删除检查项「${existing.label}」`);
        break;
      }
      if (cmd.checkId) requireThat(existing, "检查项不存在", 400);
      if (existing?.label === cmd.label) break;
      requireThat(!x.checklist.some((check) => check.label === cmd.label), "已有同名检查项", 400);
      requireThat(existing || x.checklist.length < 100, "最多添加 100 个检查项", 400);
      const check: CheckItem = { id: existing?.id ?? ctx.newId, label: cmd.label, source: "自定义", done: false };
      const checklist = existing ? x.checklist.map((entry) => entry.id === existing.id ? check : entry) : [...x.checklist, check];
      change(x, { checklist }, existing ? `将检查项「${existing.label}」改为「${check.label}」` : `添加检查项「${check.label}」`);
      break;
    }
    case "toggleCheck": {
      const x = get(cmd.id);
      requireThat(canVerify(state.items, x, acc) || canManage(state.items, x, acc), "只有验证人或项目管理者能确认检查项");
      const c = x.checklist.find((c) => c.id === cmd.checkId);
      requireThat(c && c.required !== false, "检查项不存在或未启用", 400);
      if (c.id === "code-review") requireThat(!isAssignee(x, acc.id), "代码评审需要由执行人以外的验证人确认");
      requireThat(autoCheck(state.items, x, c) === undefined, "自动检查项不能人工修改", 400);
      if (/评审|测试|验收/.test(c.label)) requireThat(canVerify(state.items, x, acc), "评审、测试和验收检查项需要由验证人确认");
      change(x, { checklist: x.checklist.map((c) => c.id === cmd.checkId ? { ...c, done: !c.done, doneBy: c.done ? undefined : acc.id, doneAt: c.done ? undefined : ctx.today } : c) }, `${c.done ? "取消确认" : "确认"}检查项「${c.label}」`);
      break;
    }
    case "setStatus": {
      const x = get(cmd.id); doer(x);
      requireThat(isLeaf(state.items, x.id), "有子任务的工作项，状态由子任务自动汇总", 400);
      requireThat(!isPublishing(statusOf(state.items, x)), "请在详情中处理生产发布和线上验收", 400);
      if (cmd.status === "blocked") requireThat(cmd.reason?.trim(), "阻塞必须填写原因", 400);
      if (cmd.status === "done") {
        requireThat(x.kind === "task", "需求和项目需要提交验收", 400);
        requireThat(x.status !== "review", "待验收的工作需由验证人验收", 400);
        requireThat(!openChecks(state.items, x).length, "还有完成检查项未确认", 400);
      }
      change(x, { status: cmd.status, progress: cmd.status === "done" ? 100 : x.progress, doneAt: cmd.status === "done" ? ctx.today : undefined, blockedReason: cmd.status === "blocked" ? cmd.reason?.trim() : undefined, blockedSince: cmd.status === "blocked" ? ctx.today : undefined, reviewSince: undefined, ...(requiresProduction(x) ? { publication: undefined, releaseCycle: undefined } : {}) }, `状态改为「${STATUS[cmd.status].label}」${cmd.reason ? `：${cmd.reason}` : ""}${cmd.status === "done" ? "（未经验收直接完成）" : ""}`);
      if (cmd.status === "blocked" || (x.status === "done" && cmd.status !== "done")) {
        const next = byId(state.items, x.id)!;
        state.items = state.items.map((i) => i.id === x.id ? { ...next, log: next.log.map((l, index) => index === next.log.length - 1 ? { ...l, action: cmd.status === "blocked" ? "blocked" as const : "reopen" as const } : l) } : i);
      }
      break;
    }
    case "submit": {
      const x = get(cmd.id); doer(x);
      requireThat(isLeaf(state.items, x.id), "有子任务的工作项由子任务汇总", 400);
      requireThat(x.status !== "done", "请先重新打开已完成的工作", 400);
      requireThat(!isPublishing(statusOf(state.items, x)), "请先处理当前的生产发布或线上验收", 400);
      if (usesAcceptanceCriteria(x)) requireThat(hasAcceptanceCriteria(x), "请先填写验收标准，再提交验收", 400);
      // 只有替换已有合格验证人才需要管理权限。
      if (cmd.verifiers?.length && verifiersOf(state.items, x).some((v) => verifierAllowed(x, v))) manage(x);
      const vs = cmd.verifiers?.length ? cmd.verifiers : verifiersOf(state.items, x);
      peopleExist(vs);
      requireThat(vs.some((v) => verifierAllowed(x, v)), x.kind === "project" ? "请指定一位执行人以外的验证人" : "请指定至少一位验证人", 400);
      change(x, { status: "review", progress: 100, deliverable: cmd.deliverable, verifiers: cmd.verifiers?.length ? cmd.verifiers : x.verifiers, reviewSince: x.status === "review" ? x.reviewSince ?? ctx.today : ctx.today, reviewToken: x.status === "review" ? x.reviewToken : ctx.newId, doneAt: undefined, blockedSince: undefined, blockedReason: undefined, updates: [...x.updates, { date: ctx.today, at: now, by: acc.id, text: `提交验收：${cmd.deliverable}${cmd.note ? `。${cmd.note}` : ""}`, progress: 100 }] }, `提交验收，交付物：${cmd.deliverable}`);
      break;
    }
    case "verify": {
      const x = get(cmd.id);
      const production = requiresProduction(x);
      requireThat(canVerifyDelivery(state.items, x, acc), production ? "只有指定的验收人能确认测试验收" : "只有验证人或有验收权限的管理员能验收");
      requireThat(statusOf(state.items, x) === "review", "工作项尚未提交验收", 400);
      requireThat(cmd.pass || cmd.note.trim(), "打回需要写明原因", 400);
      requireThat(cmd.pass || production || isLeaf(state.items, x.id), "有子任务的工作项请打回对应的子任务", 400);
      const kind = state.people.find((p) => p.id === acc.id)?.kind;
      const type = production ? "测试验收" : usesAcceptanceCriteria(x) || kind === "pm" ? "业务验收" : kind === "qa" ? "UAT" : "代码评审";
      const next = change(x, {
        status: !cmd.pass ? "doing" : production ? "release" : "done",
        progress: cmd.pass ? 100 : Math.min(x.progress, 90), doneAt: cmd.pass && !production ? ctx.today : undefined,
        reviewSince: cmd.pass && production ? ctx.today : undefined, rework: cmd.pass ? x.rework : (x.rework ?? 0) + 1,
        ...(requiresProduction(x) ? { publication: undefined, releaseCycle: cmd.pass || !isLeaf(state.items, x.id) ? { id: ctx.newId, scope: releaseScope(state.items, x) } : undefined } : {}),
        checks: [...x.checks, { id: ctx.newId, type, by: acc.id, result: cmd.pass ? "通过" : "不通过", date: ctx.today, note: cmd.note }],
      }, cmd.pass ? `${type}通过${cmd.note ? `：${cmd.note}` : ""}` : `${type}打回（返工 +1）：${cmd.note}`);
      if (cmd.pass) ensureChecks(next);
      break;
    }
    case "publish":
    case "recordReleaseIssue": {
      const x = get(cmd.id);
      requireThat(requiresProduction(x) && isAssignee(x, acc.id), "只有执行人能记录生产发布");
      const status = statusOf(state.items, x);
      requireThat(x.releaseCycle?.id === cmd.cycle, "发布轮次已变化，请刷新后重试", 409);
      if (cmd.type === "publish") {
        requireThat(status === "release", "需求尚未进入待发布，或已记录发布", 409);
        ensureChecks(x);
        change(x, { status: "production-review", reviewSince: ctx.today,
          publication: { id: ctx.newId, version: cmd.version, by: acc.id, at: now },
        }, `已发布到生产：${cmd.version}`);
      } else {
        requireThat((x.publication?.id ?? null) === cmd.publicationId, "发布记录已变化，请刷新后重试", 409);
        requireThat(status === "release" || status === "production-review" || status === "done", "当前状态无法记录发布异常", 409);
        change(x, { status: "release", publication: undefined, doneAt: undefined,
          reviewSince: x.publication ? ctx.today : x.reviewSince,
          releaseCycle: x.publication ? { ...x.releaseCycle, id: ctx.newId } : x.releaseCycle,
        },
          `${x.publication ? `生产版本「${x.publication.version}」已回滚` : "生产发布失败"}：${cmd.note}`);
      }
      break;
    }
    case "verifyProduction": {
      const x = get(cmd.id);
      requireThat(requiresProduction(x) && canVerifyDelivery(state.items, x, acc), "只有指定的验收人能确认线上验收");
      requireThat(statusOf(state.items, x) === "production-review" && x.publication?.id === cmd.publicationId, "当前生产版本或状态已变化，请刷新后重试", 409);
      requireThat(cmd.pass || cmd.note, "打回需要写明原因", 400);
      if (cmd.pass) ensureChecks(x);
      change(x, {
        status: cmd.pass ? "done" : "doing",
        progress: cmd.pass ? 100 : Math.min(x.progress, 90), doneAt: cmd.pass ? ctx.today : undefined,
        reviewSince: undefined, rework: cmd.pass ? x.rework : (x.rework ?? 0) + 1,
        publication: cmd.pass ? x.publication : undefined, releaseCycle: x.releaseCycle,
        checks: [...x.checks, { id: ctx.newId, type: "线上验收", by: acc.id, result: cmd.pass ? "通过" : "不通过", date: ctx.today, note: cmd.note }],
      }, `线上验收${cmd.pass ? "通过" : "打回"}（${x.publication.version}）${cmd.note ? `：${cmd.note}` : ""}`);
      break;
    }
    case "deferProgress": {
      const x = get(cmd.id); doer(x);
      requireThat(x.kind !== "project" && isLeaf(state.items, x.id) && statusOf(state.items, x) === "doing", "只有进行中的末级工作项可以约定下次更新时间", 400);
      requireThat(cmd.until > ctx.today, "下次更新时间要晚于今天", 400);
      if (x.progressRemindAt !== cmd.until) change(x, { progressRemindAt: cmd.until }, `暂无变化，下次更新 ${cmd.until}`);
      break;
    }
    case "confirmDirectDelivery": {
      const x = get(cmd.id);
      requireThat(x.kind === "feature" && (x.owner === acc.id || canManage(state.items, x, acc)), "只有需求负责人或项目管理者可以确认直接交付");
      const rule = state.rules.find((entry) => entry.id === "split_needed" && entry.enabled);
      const iteration = rule && pendingSplit(state.items, x, ctx.today, rule.n ?? 3);
      if (!iteration) {
        const saved = x.directDelivery;
        requireThat(saved?.owner === x.owner && saved.start === x.start && saved.due === x.due &&
          saved.iterationId === iterationIdOf(state.items, x), "该需求已经不在待拆解列表，请刷新后查看", 409);
        break;
      }
      change(x, { directDelivery: { owner: x.owner, iterationId: iteration.id, start: x.start, due: x.due } }, "确认本次排期可直接交付");
      break;
    }
    case "postUpdate": {
      const x = get(cmd.id); checkAttachments(x.id, cmd.attachmentIds);
      if (cmd.progress !== undefined) {
        requireThat(x.kind !== "project", "项目进度由下级工作项汇总", 400);
        doer(x);
        requireThat(isLeaf(state.items, x.id) && x.status !== "done" && x.status !== "review" && !isPublishing(x.status), "当前状态不能修改进度", 400);
      }
      const mentions = mentionedPeople(x, cmd.text, cmd.mentionIds);
      change(x, { progress: cmd.progress ?? x.progress, ...(cmd.progress !== undefined ? { progressRemindAt: undefined } : {}), status: x.status === "todo" && (cmd.progress ?? 0) > 0 ? "doing" : x.status, updates: [...x.updates, { id: ctx.newId, date: ctx.today, at: now, by: acc.id, text: cmd.text, progress: cmd.progress, attachmentIds: cmd.attachmentIds, mentions }] });
      result = { ok: true, id: ctx.newId };
      break;
    }
    case "editUpdate":
    case "retractUpdate": {
      const x = get(cmd.id);
      const index = x.updates.findIndex((update, i) => updateKey(update, i) === cmd.updateId);
      const update = x.updates[index];
      requireThat(update, "找不到这条动态", 404);
      requireThat(editableUpdate(update, acc.id), "只能编辑或撤回自己发布的文字动态", 403);
      requireThat((update.editedAt ?? null) === cmd.expected, "这条动态已更新，请刷新后重试", 409);
      const edited = cmd.type === "editUpdate" ? {
        ...update, text: cmd.text, editedAt: now, mentions: mentionedPeople(x, cmd.text, cmd.mentionIds, update.mentions),
      } : {
        ...update, text: "", attachmentIds: [], mentions: [], retractedAt: now,
      };
      change(x, { updates: x.updates.map((entry, i) => i === index ? edited : entry) });
      result = { ok: true, id: cmd.updateId };
      break;
    }
    case "addDefect": {
      quality();
      const x = get(cmd.id);
      const defectId = cmd.requestId ? `B${cmd.requestId.replaceAll("-", "").toUpperCase()}` : ctx.newId;
      const existing = x.defects.find((defect) => defect.id === defectId);
      if (existing) {
        requireThat(existing.by === acc.id, "登记请求已使用，请重新登记", 409);
        requireThat(!diffPatch(existing, cmd.defect).length, "此缺陷已登记，请打开缺陷详情修改", 409);
      } else {
        defectOwner(x, cmd.defect.owner);
        checkAttachments(x.id, cmd.defect.attachmentIds);
        const defect = { ...cmd.defect, id: defectId, date: ctx.today, status: "open" as const, by: acc.id };
        change(x, { defects: [...x.defects, defect] }, `登记缺陷 ${defect.severity}「${defect.title}」`);
      }
      result = { ok: true, id: defectId };
      break;
    }
    case "editDefect":
    case "fixDefect":
    case "reopenDefect": {
      quality();
      const x = get(cmd.id);
      const defect = x.defects.find((d) => d.id === cmd.defectId);
      requireThat(defect, "缺陷不存在", 404);
      requireThat(canMaintainDefect(state.items, x, defect, acc), "只有缺陷负责人或项目管理者能维护缺陷");
      const revision = defect.revision ?? 0;
      if (cmd.type === "editDefect") {
        requireThat(cmd.expected === revision, "缺陷已被更新，请重新打开详情后再编辑", 409);
        const patch = cmd.defect;
        if (patch.owner !== defect.owner) defectOwner(x, patch.owner);
        if (patch.attachmentIds) {
          requireThat(new Set(patch.attachmentIds).size === patch.attachmentIds.length, "缺陷附件不能重复", 400);
          checkAttachments(x.id, patch.attachmentIds.filter((id) => !defect.attachmentIds?.includes(id)));
        }
        change(x, { defects: x.defects.map((d) => d === defect ? { ...d, ...patch, revision: revision + 1 } : d) }, `编辑缺陷「${patch.title}」`);
      } else {
        const status = cmd.type === "fixDefect" ? "fixed" : "open";
        if (defect.status !== status) {
          change(x, { defects: x.defects.map((d) => d === defect ? { ...d, status, revision: revision + 1 } : d) },
            `${status === "fixed" ? "关闭" : "重新打开"}缺陷「${defect.title}」`);
        }
      }
      break;
    }
    case "addBadCase": {
      quality(); const x = get(cmd.id); requireThat(x.eval, "该工作项没有评测配置", 400);
      change(x, { eval: { ...x.eval, badCases: [...x.eval.badCases, { ...cmd.badCase, id: ctx.newId, by: acc.id, date: ctx.today, status: "待处理" }] } }, `新增 Bad Case「${cmd.badCase.input}」`);
      break;
    }
    case "setBadCase": {
      quality(); const x = get(cmd.id); doer(x);
      requireThat(x.eval && x.eval.badCases.some((b) => b.id === cmd.caseId), "Bad Case 不存在", 400);
      change(x, { eval: { ...x.eval, badCases: x.eval.badCases.map((b) => b.id === cmd.caseId ? { ...b, status: cmd.status } : b) } }, `Bad Case ${cmd.caseId} 标记为「${cmd.status}」`);
      break;
    }
    case "bindRepo": {
      const x = get(cmd.id); manage(x); requireThat(x.kind === "project", "只能给项目绑定仓库", 400);
      const parsed = repoParts(cmd.repo.trim());
      const repo = repoKey(cmd.provider ?? parsed.provider, parsed.path);
      requireThat(repo, "请填写当前平台的仓库地址或命名空间/仓库名", 400);
      requireThat(!projectOfRepo(state.items, repo), "仓库已经绑定，一个仓库只能属于一个项目", 409);
      change(x, { repos: [...(x.repos ?? []), repo] }, `绑定仓库 ${repoLabel(repo)}`);
      const held = state.repoEvents.filter((e) => e.status === "unbound" && sameRepo(e.repo, repo)).reverse();
      for (const ev of held) {
        const applied = applyRepoEvent(state.items, state.accounts, ev, ctx.today, state.people);
        state.items = applied.items;
        state.repoEvents = state.repoEvents.map((e) => e.id === ev.id ? { ...applied.record, result: `绑定后补处理：${applied.record.result}` } : e);
      }
      result.reason = held.length ? `已补处理 ${held.length} 条事件` : undefined;
      break;
    }
    case "unbindRepo": {
      const x = get(cmd.id); manage(x);
      requireThat(x.kind === "project", "只能对项目解除仓库绑定", 400);
      change(x, { repos: (x.repos ?? []).filter((r) => !sameRepo(r, cmd.repo)) }, `解除绑定仓库 ${repoLabel(cmd.repo)}`);
      break;
    }
    case "linkRepoEvent":
    case "ignoreRepoEvent": {
      const ev = state.repoEvents.find((e) => e.id === cmd.eventId);
      requireThat(ev, "事件不存在", 400);
      const project = projectOfRepo(state.items, ev.repo);
      if (project) manage(get(project.id)); else admin();
      if (cmd.type === "ignoreRepoEvent") state.repoEvents = state.repoEvents.map((e) => e.id === ev.id ? { ...e, status: "ignored", result: "已手动忽略" } : e);
      else {
        const x = get(cmd.itemId); manage(x);
        requireThat(isLeaf(state.items, x.id) && x.kind === "task", "请关联到叶子任务", 400);
        requireThat(ev.status === "unlinked", "只有未关联的事件可手动关联", 400);
        const applied = applyRepoEvent(state.items, state.accounts, { ...ev, ref: x.id }, ctx.today, state.people);
        state.items = applied.items;
        state.repoEvents = state.repoEvents.map((e) => e.id === ev.id ? { ...applied.record, result: `手动关联：${applied.record.result}` } : e);
      }
      break;
    }
  }
  // 树由新建构造，编辑不能移动节点；不允许经通用编辑改写审计、权限或验证事实。
  return { state, result };
}
