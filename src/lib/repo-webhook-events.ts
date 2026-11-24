import { findRef, type RepoEvent, type RepoEventKind } from "./gitea";
import { repoKey, type RepoProvider } from "./repo-providers";

type Payload = Record<string, unknown>;
const object = (value: unknown): Payload =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Payload : {};
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const url = (value: unknown) => typeof value === "string" && /^https?:\/\//i.test(value) ? value : undefined;

type EventFields = Pick<RepoEvent, "kind"> & Partial<Omit<RepoEvent, "id" | "repo" | "receivedAt" | "verified" | "kind">>;

function pullRequest(pr: Payload) {
  const branch = text(object(pr.head).ref);
  const title = text(pr.title);
  return { branch, title, ref: findRef(branch, title, text(pr.body)), number: number(pr.number),
    url: url(pr.html_url), author: text(object(pr.user).login) };
}

function githubFields(event: string, body: Payload): EventFields {
  const pr = object(body.pull_request);
  const action = text(body.action);
  const sender = text(object(body.sender).login);
  if (event === "pull_request") {
    const kind = action === "opened" ? "pr_open"
      : action === "synchronize" || action === "reopened" || action === "ready_for_review" ? "pr_update"
        : action === "closed" ? pr.merged === true ? "pr_merged" : "pr_closed" : "ignored";
    return { ...pullRequest(pr), kind, rawAction: action, sender };
  }
  if (event === "pull_request_review" && action === "submitted") {
    const review = object(body.review);
    const state = review.state;
    const kind = state === "approved" ? "pr_approved" : state === "commented" || state === "changes_requested" ? "comment" : "ignored";
    const note = state === "changes_requested" ? `要求修改：${text(review.body) ?? ""}` : text(review.body);
    return { ...pullRequest(pr), kind, sender: text(object(review.user).login) ?? sender, note };
  }
  if (event === "pull_request_review_comment" && action === "created") {
    return { ...pullRequest(pr), kind: "comment", sender, note: text(object(body.comment).body) };
  }
  if (event === "issue_comment" && action === "created") {
    const issue = object(body.issue);
    if (issue.pull_request) return { kind: "comment", sender, title: text(issue.title), number: number(issue.number),
      ref: findRef(text(issue.title), text(issue.body)), note: text(object(body.comment).body) };
  }
  if (event === "status" && body.state === "success") {
    const branches = Array.isArray(body.branches) ? body.branches.map((branch) => text(object(branch).name)) : [];
    return { kind: "pr_tested", sender, ref: findRef(...branches, text(object(object(body.commit).commit).message)), note: text(body.context) };
  }
  if (event === "check_run" && action === "completed") {
    const run = object(body.check_run);
    if (run.conclusion === "success") {
      const associated = Array.isArray(run.pull_requests) ? run.pull_requests.map((request) => text(object(object(request).head).ref)) : [];
      return { kind: "pr_tested", sender, ref: findRef(text(object(run.check_suite).head_branch), ...associated), note: text(run.name) };
    }
  }
  return { kind: "ignored" };
}

function gitlabFields(event: string, body: Payload): EventFields {
  const attributes = object(body.object_attributes);
  const user = object(body.user);
  const sender = text(user.username);
  const action = text(attributes.action);
  if (event === "merge request hook") {
    const branch = text(attributes.source_branch);
    const kind = action === "open" ? "pr_open"
      : action === "reopen" || (action === "update" && typeof attributes.oldrev === "string") ? "pr_update"
        : action === "approval" ? "pr_approved"
          : action === "merge" ? "pr_merged" : action === "close" ? "pr_closed" : "ignored";
    return { kind, branch, title: text(attributes.title), number: number(attributes.iid), url: url(attributes.url),
      sender, author: number(user.id) && user.id === attributes.author_id ? sender : undefined, rawAction: action,
      ref: findRef(branch, text(attributes.title), text(attributes.description)) };
  }
  const mr = object(body.merge_request);
  if (event === "note hook" && attributes.noteable_type === "MergeRequest") {
    return { kind: "comment", sender, number: number(mr.iid), title: text(mr.title), url: url(mr.url),
      ref: findRef(text(mr.source_branch), text(mr.title), text(mr.description)), note: text(attributes.note) };
  }
  if (event === "pipeline hook" && attributes.status === "success") {
    return { kind: "pr_tested", sender, ref: findRef(text(attributes.ref), text(mr.source_branch), text(mr.title)), note: "Pipeline" };
  }
  return { kind: "ignored" };
}

function giteeFields(event: string, body: Payload): EventFields {
  const pr = object(body.pull_request);
  const common = pullRequest(pr);
  const sender = text(object(body.sender).login);
  const hook = body.hook_name;
  if (event === "merge request hook" || hook === "merge_request_hooks") {
    const action = text(body.action)?.toLowerCase();
    const state = text(pr.state ?? body.state)?.toLowerCase();
    let kind: RepoEventKind = "ignored";
    if (pr.merged === true || state === "merged" || action === "merge") kind = "pr_merged";
    else if (state === "closed" || action === "close") kind = "pr_closed";
    else if (action === "approved") kind = "pr_approved";
    else if (action === "tested") kind = "pr_tested";
    else if (action === "open" || action === "opened") kind = "pr_open";
    else if (action === "update" || action === "reopen" || (!action && state === "open")) kind = "pr_update";
    return { ...common, kind, rawAction: action, sender, author: common.author ?? text(object(body.author).login) };
  }
  if ((event === "note hook" || hook === "note_hooks") && body.noteable_type === "PullRequest") {
    const comment = object(body.comment);
    return { ...common, kind: "comment", sender: text(object(comment.user).login) ?? sender, note: text(comment.body) };
  }
  return { kind: "ignored" };
}

export function parseRepoWebhook(provider: Exclude<RepoProvider, "gitea">, eventHeader: string, body: Payload, now: string): RepoEvent | null {
  const event = eventHeader.toLowerCase();
  const project = object(body.project);
  const repository = object(body.repository);
  const source = provider === "gitlab" ? text(project.path_with_namespace)
    : text(repository.full_name) ?? (provider === "gitee" ? text(project.path_with_namespace) ?? text(object(object(object(body.pull_request).base).repo).full_name) : undefined);
  const repo = source && repoKey(provider, source);
  if (!repo) return null;
  const parse = provider === "github" ? githubFields : provider === "gitlab" ? gitlabFields : giteeFields;
  const fields = parse(event, body);
  return { id: "", repo, receivedAt: now, verified: true, ...fields,
    ...(fields.kind === "ignored" ? { note: `已忽略事件：${eventHeader || text(body.hook_name) || "未知"}` } : {}) };
}
