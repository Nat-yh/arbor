import type { Account, RoleTemplate } from "./access";
import type { Alert, Rule } from "./alerts";
import type { Person, WorkItem } from "./model";
import type { Attachment } from "./model";
import type { RepoProvider } from "./repo-providers";
import type { SyncRecord } from "./repo-sync";

export interface Activity { id: string; itemId: string; projectId: string; title: string; date: string; by: string; text: string; at?: string }

export interface AppState {
  attachments?: Attachment[];
  activities?: Activity[];
  items: WorkItem[];
  accounts: Account[];
  roleTemplates?: RoleTemplate[];
  people: Person[];
  rules: Rule[];
  repoEvents: SyncRecord[];
}

export interface ClientState extends AppState {
  defectOwnerCandidates?: Record<string, string[]>;
  mentionCandidates?: Record<string, string[]>;
  me: string;
  acc: Account;
  myRoleLabel?: string;
  alerts: Alert[];
  demoMode: boolean;
  localAuthEnabled?: boolean;
  timezone: string;
  repoConfigured: boolean;
  repoProviders?: Record<RepoProvider, boolean>;
}
