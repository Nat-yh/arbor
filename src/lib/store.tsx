"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCommandFeedback } from "@/components/ActionFeedback";
import { useToast } from "@/components/Toast";
import { canUseTeam, isAdmin, visibleProjects, type Account, type MenuKey, type RoleTemplate } from "./access";
import type { Rule } from "./alerts";
import type { Command, CommandResult } from "./commands";
import { setAppTimezone, setPeople, today, type BadCase, type DefectInput, type DeliveryCheck, type Iteration, type Status, type WorkItem } from "./model";
import { attachmentMime } from "./attachments";
import type { RepoLogins, RepoProvider } from "./repo-providers";
import type { ClientState } from "./state";
import { hasPracticeReference, PracticeSession, type PracticeTrack } from "./practice";

type Result = Promise<CommandResult>;
type DeliveryPlan = Partial<WorkItem> & { deliveryChecks?: DeliveryCheck[] };
type LifecycleCommand = (id: string, reason: string, onSuccess?: () => Promise<void>) => Result;
interface Store extends ClientState {
  practice: PracticeSession | null;
  workspaceKey: string;
  startPractice: (track: PracticeTrack, returnTo: string, fullGuide?: boolean) => boolean;
  endPractice: () => void;
  switchPracticeActor: (id: string) => void;
  visible: WorkItem[];
  admin: boolean;
  can: (menu: MenuKey) => boolean;
  projects: WorkItem[];
  saveRoleTemplate: (template: Omit<RoleTemplate, "id" | "revision">, existing?: RoleTemplate) => Result;
  deleteRoleTemplate: (id: string) => Result;
  moveRoleMembers: (roleId: string, members: { id: string; fromRoleId: string }[]) => Result;
  setMember: (id: string, member: { active: boolean; gitee?: string; repoLogins?: RepoLogins; roleId?: string }) => Result;
  setAccount: (id: string, a: Account) => Result;
  setMe: (id: string) => Result;
  logout: () => Result;
  linkRepoEvent: (eventId: string, itemId: string) => Result;
  ignoreRepoEvent: (eventId: string) => Result;
  bindRepo: (projectId: string, repo: string, provider?: RepoProvider) => Result;
  unbindRepo: (projectId: string, repo: string) => Result;
  get: (id: string) => WorkItem | undefined;
  addItem: (p: DeliveryPlan & Pick<WorkItem, "parentId" | "kind" | "title" | "owner" | "due">, screenshots?: File[]) => Promise<string | undefined>;
  moveItem: (move: Omit<Extract<Command, { type: "moveItem" }>, "type">) => Result;
  edit: (id: string, p: DeliveryPlan, what: string, expected?: CommandResult["conflicts"], screenshots?: File[]) => Result;
  patch: (id: string, p: Partial<WorkItem>) => Result;
  cancel: LifecycleCommand;
  restore: LifecycleCommand;
  unarchive: LifecycleCommand;
  archive: LifecycleCommand;
  deleteItem: LifecycleCommand;
  toggleCheck: (itemId: string, checkId: string) => Result;
  saveProjectCheck: (id: string, label: string, checkId?: string) => Result;
  deleteProjectCheck: (id: string, checkId: string) => Result;
  setStatus: (id: string, s: Status, reason?: string, onSuccess?: () => Promise<void>) => Result;
  submit: (id: string, deliverable: string, note: string, verifiers?: string[], onSuccess?: () => Promise<void>) => Result;
  verify: (id: string, pass: boolean, note: string, onSuccess?: () => Promise<void>) => Result;
  productionAction: (command: Extract<Command, { type: "publish" | "verifyProduction" | "recordReleaseIssue" }>) => Result;
  deferProgress: (id: string, until: string) => Result;
  confirmDirectDelivery: (id: string) => Result;
  postUpdate: (id: string, text: string, progress?: number, attachmentIds?: string[], mentionIds?: string[]) => Result;
  editUpdate: (id: string, updateId: string, text: string, mentionIds: string[], expected: string | null) => Result;
  retractUpdate: (id: string, updateId: string, expected: string | null) => Result;
  uploadAttachment: (id: string, file: File) => Result;
  addDefect: (id: string, defect: DefectInput, requestId: string) => Result;
  editDefect: (id: string, defectId: string, defect: DefectInput, expected: number) => Result;
  fixDefect: (id: string, defectId: string) => Result;
  reopenDefect: (id: string, defectId: string) => Result;
  addBadCase: (id: string, b: Omit<BadCase, "id" | "by" | "status">) => Result;
  setBadCase: (id: string, caseId: string, status: BadCase["status"]) => Result;
  setRule: (id: string, p: Partial<Rule>, onSuccess?: () => Promise<void>) => Result;
  saveIteration: (projectId: string, iteration: Pick<Iteration, "name" | "start" | "end" | "goal">, iterationId?: string) => Result;
  deleteIteration: (projectId: string, iterationId: string) => Result;
  closeIteration: (projectId: string, iterationId: string, moveTo: string | null) => Result;
  reset: () => Result;
}
const Ctx = createContext<Store | null>(null);
const LoadingCtx = createContext<{ error: string; retry: () => void } | null>(null);
// 登录身份变动时重新加载整个页面，清除前一账号的表单和页面状态。
const navigate = (path: string) => window.location.assign(new URL(path, window.location.origin).href);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ClientState | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const [mode, setMode] = useState<{ generation: number; practice: PracticeSession | null }>({ generation: 0, practice: null });
  const busy = useRef(0);
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const queue = useRef(Promise.resolve());
  const screenshotDrafts = useRef(new WeakMap<File, { id: string; expiresAt: string; origin: number }>());
  const practice = useRef<PracticeSession | null>(null);
  const realSnapshot = useRef<ClientState | null>(null);
  const workspace = useRef(0);
  const toast = useToast();
  const { trigger, showSuccess, feedback } = useCommandFeedback();
  const accept = useCallback((state: ClientState) => {
    if (!practice.current) realSnapshot.current = state;
    setPeople(state.people); setAppTimezone(state.timezone);
    setSnapshot(state); setError("");
  }, []);
  const refresh = useCallback(async () => {
    if (busy.current || practice.current) return;
    const revision = epoch.current;
    const sequence = ++readSequence.current;
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (revision !== epoch.current || practice.current) return;
      if (res.status === 401) { navigate("/login"); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.reason ?? "加载失败");
      if (revision === epoch.current && sequence === readSequence.current && !busy.current) accept(data);
    } catch (err) { if (revision === epoch.current && !practice.current) setError(err instanceof Error ? err.message : "加载失败"); }
  }, [accept]);
  useEffect(() => {
    void refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- fetch 完成后才更新状态
    const timer = setInterval(() => void refresh(), 15000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);

  const startPractice = useCallback((track: PracticeTrack, returnTo: string, fullGuide = false) => {
    if (busy.current || !realSnapshot.current) { toast("请等当前操作保存完成后再开始练习", undefined, "info"); return false; }
    practice.current?.close();
    epoch.current++; workspace.current++;
    practice.current = new PracticeSession(track, returnTo, today(), realSnapshot.current.timezone, fullGuide);
    setMode({ generation: workspace.current, practice: practice.current });
    accept(practice.current.snapshot);
    return true;
  }, [accept, toast]);
  const endPractice = useCallback(() => {
    if (!practice.current) return;
    practice.current.close(); practice.current = null;
    epoch.current++; workspace.current++;
    setMode({ generation: workspace.current, practice: null });
    if (realSnapshot.current) accept(realSnapshot.current);
    void refresh();
  }, [accept, refresh]);
  const switchPracticeActor = useCallback((id: string) => {
    if (practice.current?.switchActor(id)) accept(practice.current.snapshot);
  }, [accept]);

  const send = useCallback((origin: number, command?: Command, endpoint = "/api/commands", body: unknown = command, file?: File, onSuccess?: () => Promise<void>): Result => {
    if (origin !== workspace.current) return Promise.resolve({ ok: false, reason: "工作区已切换，请重新操作。" });
    const anchor = command && !onSuccess ? trigger.current : null;
    const variant = command?.type === "delete" || command?.type === "deleteIteration" || command?.type === "deleteProjectCheck" ? "danger" : "complete";
    if (practice.current) {
      const result = practice.current.dispatch(command, endpoint, file);
      if (result.ok) {
        const session = practice.current;
        if (onSuccess) return onSuccess().then(() => {
          if (practice.current === session) accept(session.snapshot);
          return result;
        });
        if (anchor) showSuccess(anchor, variant);
        accept(session.snapshot);
      } else toast("练习提示", result.reason, "info");
      return Promise.resolve(result);
    }
    if (hasPracticeReference(command) || hasPracticeReference(body) || endpoint.includes("practice-")) {
      toast("练习已结束", "请返回工作台，练习记录不会保存。", "info");
      return Promise.resolve({ ok: false, reason: "练习记录不能保存到真实工作区。" });
    }
    busy.current++; epoch.current++; setPending((n) => n + 1);
    const operation = queue.current.then(async (): Promise<CommandResult> => {
      try {
        const res = await fetch(endpoint, { method: "POST", headers: file ? { "Content-Type": attachmentMime(file.name, file.type), "X-File-Name": encodeURIComponent(file.name) } : { "Content-Type": "application/json" }, body: file ?? JSON.stringify(body ?? {}) });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) navigate("/login");
          if (res.status === 409 && data.conflicts) return data as CommandResult;
          if (res.status === 409 && data.retryScreenshots) {
            toast("操作未保存", data.reason, "warn");
            return data as CommandResult;
          }
          throw new Error(data.reason ?? "操作失败");
        }
        if (data.result?.ok && origin === workspace.current) {
          if (onSuccess) await onSuccess();
          else if (anchor) showSuccess(anchor, variant);
        }
        if (data.state) accept(data.state);
        if (data.loggedOut) navigate("/login");
        return data.result ?? { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : "操作失败";
        toast("操作未保存", reason, "warn");
        return { ok: false, reason };
      } finally { busy.current--; setPending((n) => n - 1); }
    });
    queue.current = operation.then(() => {});
    return operation;
  }, [accept, showSuccess, toast, trigger]);

  const store = useMemo<Store | null>(() => {
    if (!snapshot) return null;
    const { items, acc } = snapshot;
    // Bind callbacks to this workspace so delayed handlers cannot cross the practice boundary.
    const origin = mode.generation;
    const dispatch = (command?: Command, endpoint?: string, body?: unknown, file?: File) => send(origin, command, endpoint, body ?? command, file);
    const withScreenshots = async (command: Extract<Command, { type: "addItem" | "edit" }>, screenshots: File[] = []) => {
      const screenshotDraftIds: string[] = [];
      for (const file of screenshots) {
        const cached = screenshotDrafts.current.get(file);
        if (cached?.origin === origin && Date.parse(cached.expiresAt) > Date.now()) {
          screenshotDraftIds.push(cached.id);
          continue;
        }
        const upload = await dispatch(undefined, "/api/attachments/draft", undefined, file);
        if (!upload.ok || !upload.id || !upload.expiresAt) return upload.ok ? { ok: false, reason: "截图上传结果不完整" } : upload;
        screenshotDrafts.current.set(file, { id: upload.id, expiresAt: upload.expiresAt, origin });
        screenshotDraftIds.push(upload.id);
      }
      const result = await dispatch(screenshotDraftIds.length ? { ...command, screenshotDraftIds } : command);
      if (result.ok || result.retryScreenshots) screenshots.forEach((file) => screenshotDrafts.current.delete(file));
      return result;
    };
    const lifecycle = (type: "cancel" | "restore" | "unarchive" | "archive" | "delete"): LifecycleCommand =>
      (id, reason, onSuccess) => {
        const command = { type, id, reason };
        return send(origin, command, undefined, command, undefined, onSuccess);
      };
    const plan = (p: DeliveryPlan) => ({ ...p, ...(Object.hasOwn(p, "aiTool") ? { aiTool: p.aiTool ?? null } : {}), ...(Object.hasOwn(p, "iteration") ? { iteration: p.iteration ?? null } : {}) });
    return {
      ...snapshot, practice: mode.practice, workspaceKey: `${origin}-${snapshot.me}`, startPractice, endPractice, switchPracticeActor,
      visible: items, admin: acc.active && isAdmin(acc), can: (m) => m === "team" ? canUseTeam(items, acc) : acc.active && acc.menus.includes(m),
      projects: visibleProjects(items, acc), get: (id) => items.find((x) => x.id === id),
      saveRoleTemplate: (template, existing) => dispatch({ type: "saveRoleTemplate", id: existing?.id, expectedRevision: existing?.revision, template }),
      deleteRoleTemplate: (id) => dispatch({ type: "deleteRoleTemplate", id }),
      moveRoleMembers: (roleId, members) => dispatch({ type: "moveRoleMembers", roleId, members }),
      setMember: (id, member) => dispatch({ type: "setMember", id, ...member }),
      setAccount: (id, account) => dispatch({ type: "setAccount", id, account }),
      setMe: async (id) => { const r = await dispatch(undefined, "/api/auth/demo", { id }); if (r.ok) navigate("/"); return r; },
      logout: async () => { const r = await dispatch(undefined, "/api/auth/logout"); if (r.ok) navigate("/login"); return r; },
      reset: async () => { const r = await dispatch(undefined, "/api/demo/reset"); if (r.ok) navigate("/"); return r; },
      addItem: async (p, screenshots) => {
        // 完成检查项由服务端生成，截图在创建事务内从暂存区移入。
        const { checklist: _checklist, ...item } = p; void _checklist;
        const result = await withScreenshots({ type: "addItem", item } as Extract<Command, { type: "addItem" }>, screenshots);
        return result.ok ? result.id : undefined;
      },
      moveItem: (move) => dispatch({ type: "moveItem", ...move }),
      edit: (id, p, what, expected, screenshots) => withScreenshots({ type: "edit", id, patch: plan(p), what, expected } as Extract<Command, { type: "edit" }>, screenshots),
      patch: (id, p) => dispatch({ type: "edit", id, patch: plan(p) } as Command),
      cancel: lifecycle("cancel"),
      restore: lifecycle("restore"),
      unarchive: lifecycle("unarchive"),
      archive: lifecycle("archive"),
      deleteItem: lifecycle("delete"),
      toggleCheck: (id, checkId) => dispatch({ type: "toggleCheck", id, checkId }),
      saveProjectCheck: (id, label, checkId) => dispatch({ type: "saveProjectCheck", id, label, checkId }),
      deleteProjectCheck: (id, checkId) => dispatch({ type: "deleteProjectCheck", id, checkId }),
      setStatus: (id, status, reason, onSuccess) => {
        const command = { type: "setStatus", id, status, reason } as Command;
        return send(origin, command, undefined, command, undefined, onSuccess);
      },
      submit: (id, deliverable, note, verifiers, onSuccess) => {
        const command = { type: "submit", id, deliverable, note, verifiers } as const;
        return send(origin, command, undefined, command, undefined, onSuccess);
      },
      verify: (id, pass, note, onSuccess) => {
        const command = { type: "verify", id, pass, note } as const;
        return send(origin, command, undefined, command, undefined, onSuccess);
      },
      productionAction: (command) => dispatch(command),
      deferProgress: (id, until) => dispatch({ type: "deferProgress", id, until }),
      confirmDirectDelivery: (id) => dispatch({ type: "confirmDirectDelivery", id }),
      postUpdate: (id, text, progress, attachmentIds, mentionIds) => dispatch({ type: "postUpdate", id, text, progress, attachmentIds, mentionIds }),
      editUpdate: (id, updateId, text, mentionIds, expected) => dispatch({ type: "editUpdate", id, updateId, text, mentionIds, expected }),
      retractUpdate: (id, updateId, expected) => dispatch({ type: "retractUpdate", id, updateId, expected }),
      uploadAttachment: (id, file) => dispatch(undefined, `/api/attachments?itemId=${encodeURIComponent(id)}`, undefined, file),
      addDefect: (id, defect, requestId) => dispatch({ type: "addDefect", id, defect, requestId }),
      editDefect: (id, defectId, defect, expected) => dispatch({ type: "editDefect", id, defectId, defect, expected }),
      fixDefect: (id, defectId) => dispatch({ type: "fixDefect", id, defectId }),
      reopenDefect: (id, defectId) => dispatch({ type: "reopenDefect", id, defectId }),
      addBadCase: (id, badCase) => dispatch({ type: "addBadCase", id, badCase }),
      setBadCase: (id, caseId, status) => dispatch({ type: "setBadCase", id, caseId, status }),
      setRule: (id, patch, onSuccess) => {
        const command = { type: "setRule", id, patch } as const;
        return send(origin, command, undefined, command, undefined, onSuccess);
      },
      saveIteration: (id, iteration, iterationId) => dispatch({ type: "saveIteration", id, iteration: { name: iteration.name, start: iteration.start, end: iteration.end, ...(iteration.goal ? { goal: iteration.goal } : {}) }, ...(iterationId ? { iterationId } : {}) }),
      deleteIteration: (id, iterationId) => dispatch({ type: "deleteIteration", id, iterationId }),
      closeIteration: (id, iterationId, moveTo) => dispatch({ type: "closeIteration", id, iterationId, moveTo }),
      bindRepo: (id, repo, provider) => dispatch({ type: "bindRepo", id, repo, provider }),
      unbindRepo: (id, repo) => dispatch({ type: "unbindRepo", id, repo }),
      linkRepoEvent: (eventId, itemId) => dispatch({ type: "linkRepoEvent", eventId, itemId }),
      ignoreRepoEvent: (eventId) => dispatch({ type: "ignoreRepoEvent", eventId }),
    };
  }, [snapshot, mode, send, startPractice, endPractice, switchPracticeActor]);

  return <Ctx.Provider value={store}><LoadingCtx.Provider value={{ error, retry: refresh }}>{children}</LoadingCtx.Provider>{feedback}{error && snapshot && <div role="alert" className="fixed right-4 top-4 z-50 rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger shadow-pop">刷新失败：{error}</div>}{pending > 0 && <div role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-xs text-fg-3 shadow-pop"><span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-line-strong border-t-accent" />保存中</div>}</Ctx.Provider>;
}

export function useStore() {
  const store = useContext(Ctx);
  if (!store) throw new Error("useStore must be used inside StoreProvider");
  return store;
}

export function useOptionalStore() {
  return useContext(Ctx);
}

export function useStoreLoading() {
  return useContext(LoadingCtx);
}

/** Optional for shared UI primitives that can also render outside the workspace. */
export function usePracticeActive() {
  return !!useContext(Ctx)?.practice;
}
