// 把代码仓库事件落到任务上：创建 PR = 提交验收，审查通过 = 代码评审，合并 = 完成（需要业务验收的停在待验收）
import { verifierAllowed, type Account } from "./access";
import { REPO_PROVIDER_LABELS, repoLabel, repoParts, sameRepo, type RepoProvider } from "./repo-providers";
import type { RepoEvent } from "./gitea";
import { isAssignee, isPublishing, person, requiresProduction, usesAcceptanceCriteria, type Person, type Verification, type WorkItem } from "./model";
import { isInactive, projectOf, statusOf, verifiersOf } from "./tree";

export type SyncStatus = "applied" | "unlinked" | "unbound" | "ignored";
export interface SyncRecord extends RepoEvent {
  status: SyncStatus;
  itemId?: string;
  projectId?: string; // 仓库绑定的项目
  warning?: string; // 例如：任务不在该仓库绑定的项目里
  result: string;
}

export const projectOfRepo = (items: WorkItem[], repo: string) => items.find((x) => x.kind === "project" && x.repos?.some((r) => sameRepo(r, repo)));

export function repoActor(accounts: Account[], provider: RepoProvider, login?: string) {
  if (!login) return undefined;
  return accounts.find((account) => {
    const handle = provider === "gitea" ? account.gitee : account.repoLogins?.[provider];
    return provider === "gitea" ? handle === login : handle?.toLowerCase() === login.toLowerCase();
  })?.id;
}

export function applyRepoEvent(items: WorkItem[], accounts: Account[], ev: RepoEvent, today: string, people?: Person[]): { items: WorkItem[]; record: SyncRecord } {
  const lookup = (id: string) => people?.find((p) => p.id === id) ?? person(id);
  const project = projectOfRepo(items, ev.repo);
  let warning: string | undefined;
  const rec = (status: SyncStatus, result: string, itemId?: string): SyncRecord => ({ ...ev, status, result, itemId, projectId: project?.id, warning });
  // 仓库没有绑定项目：不处理，等管理员绑定后再补处理
  if (!project) return { items, record: rec("unbound", `仓库 ${repoLabel(ev.repo)} 还没有绑定项目`) };
  if (ev.kind === "ignored") return { items, record: rec("ignored", ev.note ?? "已忽略") };

  const item = ev.ref ? items.find((x) => x.id.toLowerCase() === ev.ref!.toLowerCase()) : undefined;
  if (!item) return { items, record: rec("unlinked", ev.ref ? `找不到任务 AR-${ev.ref}` : "分支名 / 标题里没有 AR-编号") };
  if (isInactive(items, item) || isInactive(items, project)) return { items, record: rec("ignored", "工作项已取消或项目已归档，未改动", item.id) };
  // 任务不在仓库绑定的项目里：照常同步，记一条警告（多半是编号写错）
  const taskProject = projectOf(items, item);
  if (taskProject.id !== project.id) warning = `仓库属于「${project.title}」，任务在「${taskProject.title}」，请确认编号是否写错`;

  const { provider } = repoParts(ev.repo);
  const platform = REPO_PROVIDER_LABELS[provider];
  const actor = repoActor(accounts, provider, ev.sender) ?? repoActor(accounts, provider, ev.author);
  const actorName = actor ? lookup(actor).name : ev.sender ?? platform;
  const pr = ev.number === undefined ? `CI${ev.note ? ` ${ev.note}` : ""}` : `${provider === "gitlab" ? "MR !" : "PR #"}${ev.number}`;
  const log = (x: WorkItem, text: string) => [...x.log, { date: today, by: actor ?? platform, text: `【${platform}】${text}${warning ? `（注意：${warning}）` : ""}` }];
  const check = (x: WorkItem, c: Omit<Verification, "id" | "date">) => [...x.checks, { ...c, id: `g${x.checks.length + 1}`, date: today }];
  const link = ev.number === undefined ? {} : { pr: { number: ev.number, url: ev.url ?? "", repo: ev.repo } };

  if (requiresProduction(item) && isPublishing(statusOf(items, item)) && ["pr_open", "pr_update", "pr_merged", "pr_closed"].includes(ev.kind)) {
    const message = `${pr} 已同步，生产发布流程保持当前状态`;
    return { items: items.map((x) => x.id === item.id ? { ...x, ...link, log: log(x, message) } : x), record: rec("applied", message, item.id) };
  }

  let next: Partial<WorkItem> = {};
  let result = "";

  switch (ev.kind) {
    case "pr_open":
    case "pr_update": {
      if (item.status === "done") return { items, record: rec("ignored", "任务已完成，未改动", item.id) };
      const first = item.status !== "review";
      next = {
        ...link,
        status: "review",
        progress: 100,
        deliverable: ev.url,
        reviewSince: first ? today : item.reviewSince,
        reviewToken: first ? ev.id : item.reviewToken,
        updates: first ? [...item.updates, { date: today, by: actor ?? item.assignee, text: `提交验收：${platform} ${pr} ${ev.title ?? ""}`, progress: 100 }] : item.updates,
        log: log(item, `${pr} ${ev.kind === "pr_open" ? "已创建" : "有新提交"}，任务${first ? "进入待验收" : "保持待验收"}`),
      };
      result = first ? "任务 → 待验收，等待验证人" : "已记录更新";
      break;
    }
    case "pr_approved": {
      if ((actor && isAssignee(item, actor)) || (ev.sender && ev.author && ev.sender.toLowerCase() === ev.author.toLowerCase())) {
        next = { log: log(item, `${pr} 由作者本人审查通过，不计入代码评审`) };
        result = "作者本人审查，不计入";
        break;
      }
      next = { ...link, checks: check(item, { type: "代码评审", by: actor ?? platform, result: "通过", note: `${platform} ${pr} 审查通过` }), log: log(item, `${actorName} 审查通过 ${pr}`) };
      result = "记一条代码评审通过";
      break;
    }
    case "pr_tested": {
      next = { ...link, checks: check(item, { type: "自动化测试", by: actor ?? platform, result: "通过", note: `${platform} ${pr} 测试通过` }), log: log(item, `${pr} 测试通过`) };
      result = "记一条测试通过";
      break;
    }
    case "pr_merged": {
      const pms = verifiersOf(items, item).filter((v) => lookup(v).kind === "pm" && verifierAllowed(item, v));
      const accepted = item.checks.some((c) => c.result === "通过" && (c.type === "业务验收" || c.type === "验收"));
      if (usesAcceptanceCriteria(item) || requiresProduction(item)) {
        const awaiting = item.status !== "done";
        next = {
          ...link,
          ...(awaiting ? { status: "review", reviewSince: item.reviewSince ?? today, reviewToken: item.reviewToken ?? ev.id } : {}),
          log: log(item, awaiting ? `${pr} 已合并，等待业务验收` : `${pr} 已合并`),
        };
        result = awaiting ? "代码已合并，等待业务验收" : "已记录合并";
      } else if (pms.length && !accepted) {
        next = { ...link, status: "review", reviewSince: item.reviewSince ?? today, log: log(item, `${pr} 已合并，等待 ${pms.map((v) => lookup(v).name).join("、")} 业务验收`) };
        result = "代码已合并，等待业务验收";
      } else {
        next = { ...link, status: "done", progress: 100, doneAt: today, log: log(item, `${pr} 已合并，任务自动完成`) };
        result = "任务 → 已完成";
      }
      break;
    }
    case "pr_closed": {
      next = {
        ...link,
        status: "doing",
        progress: Math.min(item.progress, 90),
        rework: (item.rework ?? 0) + 1,
        checks: check(item, { type: "代码评审", by: actor ?? platform, result: "不通过", note: `${platform} ${pr} 关闭未合并` }),
        log: log(item, `${pr} 被关闭且未合并（返工 +1）`),
      };
      result = "任务 → 进行中，返工 +1";
      break;
    }
    case "comment": {
      next = { updates: [...item.updates, { date: today, by: actor ?? item.assignee, text: `${platform} 评论：${ev.note ?? ""}` }] };
      result = "评论已同步到动态";
      break;
    }
  }
  return { items: items.map((x) => (x.id === item.id ? { ...x, ...next } : x)), record: rec("applied", result, item.id) };
}
