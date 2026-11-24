// Gitea WebHook：将仓库事件转换为 Arbor 事件。

export type RepoEventKind = "pr_open" | "pr_update" | "pr_approved" | "pr_tested" | "pr_merged" | "pr_closed" | "comment" | "ignored";

export interface RepoEvent {
  id: string; // 去重用
  kind: RepoEventKind;
  receivedAt: string;
  verified: boolean; // 是否通过签名校验
  repo: string; // owner/name
  ref?: string; // 识别出的任务编号，如 T6
  number?: number;
  title?: string;
  url?: string;
  branch?: string;
  author?: string; // Gitea 用户名
  sender?: string;
  note?: string; // 评论内容或忽略原因
  rawAction?: string;
}

/** 任务编号写在分支名、PR 标题或描述里，格式 AR-<编号> */
export const TASK_REF = /\bAR-([A-Za-z0-9]+)\b/;

export const branchNameFor = (id: string) => `feature/AR-${id}`;

export function findRef(...texts: (string | null | undefined)[]): string | undefined {
  for (const t of texts) {
    const m = t?.match(TASK_REF);
    if (m) return m[1];
  }
  return undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseGiteaPayload(eventHeader: string | null, eventTypeHeader: string | null, body: any, verified: boolean, now = new Date().toISOString()): RepoEvent {
  const repo = body?.repository?.full_name ?? "unknown";
  const base = { id: `event-${repo}-${now}`, receivedAt: now, verified, repo };
  const headers = [eventHeader, eventTypeHeader].map((h) => h?.toLowerCase() ?? "");
  const action = String(body?.action ?? "");
  const reviewType = String(body?.review?.type ?? "").toLowerCase();
  const reviewKinds = ["approved", "rejected", "comment"] as const;
  const review = reviewKinds.find((kind) => headers.some((h) => h === `pull_request_review_${kind}` || (kind !== "comment" && h === `pull_request_${kind}`))
    || (action === "reviewed" && reviewType.includes(kind)));

  const commentEvent = !review && headers.some((h) => h === "issue_comment" || h === "pull_request_comment");
  if (!commentEvent && (review || headers.includes("pull_request"))) {
    const pr = body?.pull_request ?? {};
    let kind: RepoEventKind = "ignored";
    let note: string | undefined;
    if (review === "approved") kind = "pr_approved";
    else if (review === "rejected" || review === "comment") {
      kind = "comment";
      note = review === "rejected" ? `要求修改：${body?.review?.content ?? ""}` : body?.review?.content;
    } else if (action === "opened") kind = "pr_open";
    else if (action === "synchronized" || action === "reopened") kind = "pr_update";
    else if (action === "closed") kind = pr.merged === true ? "pr_merged" : "pr_closed";
    if (kind === "ignored") note = `不处理的 PR 动作：${action || "空"}`;
    return {
      ...base, kind, note, rawAction: action,
      ref: findRef(pr.head?.ref, pr.title, pr.body),
      number: pr.number, title: pr.title, url: pr.html_url,
      branch: pr.head?.ref, author: pr.user?.login, sender: body?.sender?.login,
    };
  }

  if (commentEvent) {
    const issue = body?.issue ?? {};
    const isPull = body?.is_pull === true || !!issue.pull_request;
    return {
      ...base, kind: isPull ? "comment" : "ignored", rawAction: action,
      ref: findRef(issue.title, issue.body), number: issue.number, title: issue.title,
      url: body?.comment?.html_url, sender: body?.comment?.user?.login ?? body?.sender?.login,
      note: isPull ? body?.comment?.body : "不处理普通 Issue 评论",
    };
  }

  if (headers.includes("status")) {
    const branches = Array.isArray(body?.branches) ? body.branches.map((branch: any) => branch?.name) : [];
    return {
      ...base, kind: body?.state === "success" ? "pr_tested" : "ignored",
      ref: findRef(...branches, body?.commit?.commit?.message, body?.commit?.message),
      url: body?.target_url, sender: body?.sender?.login,
      note: body?.state === "success" ? body?.context : `不处理的提交状态：${body?.state ?? "未知"}`,
    };
  }

  return { ...base, kind: "ignored", note: `不处理的事件类型：${eventTypeHeader ?? eventHeader ?? "未知"}` };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const KIND_LABEL: Record<RepoEventKind, string> = {
  pr_open: "PR 创建",
  pr_update: "PR 更新",
  pr_approved: "审查通过",
  pr_tested: "测试通过",
  pr_merged: "已合并",
  pr_closed: "关闭未合并",
  comment: "PR 评论",
  ignored: "已忽略",
};
