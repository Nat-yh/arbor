import { applyCommand, EditConflict, type Command, type CommandResult } from "./commands";
import { applyRole } from "./access";
import { buildChecklist, dateOffset, type WorkItem } from "./model";
import type { ClientState } from "./state";

export const practiceTracks = ["work", "create", "review"] as const;
export type PracticeTrack = (typeof practiceTracks)[number];
export const PRACTICE = { project: "practice-project", task: "practice-task", learner: "practice-learner", reviewer: "practice-reviewer" } as const;
const allowed = new Set<Command["type"]>(["addItem", "edit", "postUpdate", "setStatus", "submit", "verify", "toggleCheck", "saveProjectCheck", "deleteProjectCheck", "cancel", "restore", "archive", "unarchive", "delete", "addDefect", "editDefect", "fixDefect", "reopenDefect", "addBadCase", "setBadCase", "saveIteration", "deleteIteration", "closeIteration"]);
let sessionSequence = 0;

/** Only in-memory data and the shared pure command reducer. No persistence or network fallback. */
export class PracticeSession {
  readonly id = ++sessionSequence;
  private state: ClientState;
  private closed = false;
  private sequence = 0;

  constructor(readonly track: PracticeTrack, readonly returnTo: string, readonly date: string, timezone: string, readonly fullGuide = false) {
    const accounts = [PRACTICE.learner, PRACTICE.reviewer].map((id) => applyRole({ id, active: true, menus: [], scope: "joined", projects: [], perf: "self", canCreate: true }, "member"));
    const owner = track === "create" ? PRACTICE.learner : PRACTICE.reviewer;
    const project: WorkItem = {
      id: PRACTICE.project, parentId: null, kind: "project", title: "官网改版（练习）", desc: "这里的人员和任务仅供本次练习，退出后清除。",
      owner, assignee: owner, verifiers: [], members: accounts.map((a) => a.id),
      start: date, due: dateOffset(date, 14), status: "todo", progress: 0, estimate: 1,
      checklist: buildChecklist("project"), updates: [], checks: [], defects: [], log: [],
    };
    const task: WorkItem = {
      ...project, id: PRACTICE.task, parentId: project.id, kind: "task", title: "测试登录流程", owner: PRACTICE.reviewer, assignee: PRACTICE.learner,
      desc: "检查正确密码能否登录、错误密码是否有提示。完成后写明测试结果，交给林悦验收。", acceptance: ["正确密码可以登录", "错误密码有明确提示"],
      members: undefined, checklist: [], due: dateOffset(date, 7),
      ...(track === "review" ? { status: "review", progress: 100, verifiers: [PRACTICE.reviewer], deliverable: "登录测试结果：正确密码可登录，错误密码提示已检查。", reviewSince: date } : {}),
    };
    const me = track === "review" ? PRACTICE.reviewer : PRACTICE.learner;
    this.state = {
      items: track === "create" ? [project] : [project, task], accounts, me, acc: accounts.find((a) => a.id === me)!,
      people: [
        { id: PRACTICE.learner, name: "小夏", title: "练习执行人", kind: "dev", role: "member", active: true },
        { id: PRACTICE.reviewer, name: "林悦", title: "练习验证人", kind: "pm", role: "member", active: true },
      ],
      rules: [], repoEvents: [], attachments: [], activities: [], alerts: [], demoMode: false, timezone, repoConfigured: false,
    };
  }

  get snapshot() { return this.state; }

  dispatch(command?: Command, endpoint = "/api/commands", file?: File): CommandResult {
    if (this.closed) return { ok: false, reason: "练习已结束，请重新打开指南。" };
    if (file || endpoint !== "/api/commands" || !command || !allowed.has(command.type)) {
      return { ok: false, reason: "练习中不上传文件、不发送通知，也不修改账号或系统设置。退出练习后可正常使用。" };
    }
    try {
      const { state, result } = applyCommand(this.state, { accountId: this.state.me, today: this.date, newId: `practice-new-${++this.sequence}` }, command);
      this.state = { ...this.state, ...state };
      return result;
    } catch (error) {
      if (error instanceof EditConflict) return { ok: false, reason: error.message, conflicts: error.conflicts };
      return { ok: false, reason: error instanceof Error ? error.message : "操作未完成" };
    }
  }

  switchActor(id: string): boolean {
    const acc = this.state.accounts.find((a) => a.id === id);
    if (this.closed || !acc) return false;
    this.state = { ...this.state, me: id, acc };
    return true;
  }

  close() { this.closed = true; }
}

/** A refreshed/back-navigation page must never send a leftover practice ID to the server. */
const referenceFields = new Set(["id", "itemId", "eventId", "parentId", "owner", "assignee", "assignees", "verifiers", "members", "attachmentIds", "checkId", "defectId", "caseId", "iterationId", "iteration", "moveTo", "projects"]);
export function hasPracticeReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    if (referenceFields.has(key)) {
      const ids = Array.isArray(entry) ? entry : [entry];
      if (ids.some((id) => typeof id === "string" && id.startsWith("practice-"))) return true;
    }
    return hasPracticeReference(entry);
  });
}
