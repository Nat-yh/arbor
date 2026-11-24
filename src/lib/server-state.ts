import { canSee, canSeeProject, isAdmin, membersOf, roleLabel, roleOf } from "./access";
import { computeAlerts } from "./alerts";
import { CommandError } from "./commands";
import { appTimezone, setPeople } from "./model";
import { projectOfRepo } from "./repo-sync";
import type { AppState, ClientState } from "./state";
import { demoEnabled, isDemoIdentity, localAuthEnabled } from "./auth-config";
import { ownRootDeletion } from "./lifecycle";

export const demoMode = demoEnabled;

/** 所有命令响应与 GET 都从完整状态重新投影，避免客户端收到隐藏项目。 */
export function clientState(state: AppState, accountId: string): ClientState {
  const acc = state.accounts.find((a) => a.id === accountId);
  if (!acc?.active) throw new CommandError("账号已停用，请重新登录", 401);
  setPeople(state.people);
  const items = state.items.filter((x) => canSee(state.items, x, acc));
  const visible = new Set(items.map((x) => x.id));
  const admin = isAdmin(acc);
  const demo = demoMode() && state.accounts.every(({ id }) => isDemoIdentity(id));
  const assignable = items.filter((item) => item.kind === "project").map((project) => {
    const members = new Set(membersOf(state.items, project));
    const eligible = state.accounts.filter((account) => canSeeProject(state.items, project, account, members));
    return { id: project.id, eligible, members };
  });
  return {
    defectOwnerCandidates: Object.fromEntries(assignable.map(({ id, eligible }) => [id, eligible.map((account) => account.id)])),
    mentionCandidates: Object.fromEntries(assignable.map(({ id, eligible, members }) =>
      [id, eligible.filter((account) => account.id !== acc.id && members.has(account.id)).map((account) => account.id)])),
    attachments: (state.attachments ?? []).filter((a) => visible.has(a.itemId)),
    activities: (state.activities ?? []).filter((a) => (admin && acc.scope === "all" && acc.menus.includes("projects")) || visible.has(a.projectId) || ownRootDeletion(a, acc.id)),
    items, people: state.people.map((p) => {
      const account = state.accounts.find((a) => a.id === p.id);
      return { ...p, active: account?.active ?? p.active, canReceiveAssignment: !!account?.active && account.menus.includes("projects") && roleOf(account) !== "guest" };
    }), rules: state.rules, me: acc.id, acc,
    accounts: admin || demo ? state.accounts : [acc],
    roleTemplates: admin ? state.roleTemplates : undefined, myRoleLabel: roleLabel(acc, state.roleTemplates),
    repoEvents: admin ? state.repoEvents : state.repoEvents.filter((e) => {
      const project = projectOfRepo(state.items, e.repo);
      return project && visible.has(project.id) && (!e.itemId || visible.has(e.itemId));
    }),
    alerts: computeAlerts(items, state.rules).filter((a) => visible.has(a.itemId)),
    repoProviders: {
      github: !!process.env.GITHUB_WEBHOOK_SECRET, gitlab: !!process.env.GITLAB_WEBHOOK_SECRET,
      gitee: !!process.env.GITEE_WEBHOOK_SECRET, gitea: !!process.env.GITEA_WEBHOOK_SECRET,
    },
    demoMode: demo, localAuthEnabled: localAuthEnabled(), timezone: appTimezone(), repoConfigured: !!process.env.GITEA_WEBHOOK_SECRET,
  };
}
