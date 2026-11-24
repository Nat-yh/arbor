export const REPO_PROVIDERS = ["github", "gitlab", "gitee", "gitea"] as const;
export type RepoProvider = typeof REPO_PROVIDERS[number];
export type RepoLogins = Partial<Record<Exclude<RepoProvider, "gitea">, string>>;
export const REPO_PROVIDER_LABELS: Record<RepoProvider, string> = {
  github: "GitHub", gitlab: "GitLab", gitee: "Gitee", gitea: "Gitea",
};

export const isRepoProvider = (value: string): value is RepoProvider =>
  (REPO_PROVIDERS as readonly string[]).includes(value);

export function repoParts(value: string): { provider: RepoProvider; path: string } {
  const [prefix] = value.split(":", 1);
  if (isRepoProvider(prefix) && value.startsWith(`${prefix}:`)) {
    return { provider: prefix, path: value.slice(prefix.length + 1) };
  }
  return { provider: "gitea", path: value };
}

export function repoKey(provider: RepoProvider, input: string) {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (url.username || url.password) return null;
      const hosts: Record<string, RepoProvider> = {
        "github.com": "github", "gitlab.com": "gitlab", "gitee.com": "gitee", "gitea.com": "gitea",
      };
      if (Object.hasOwn(hosts, url.hostname) && hosts[url.hostname] !== provider) return null;
      path = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  const segments = path.split("/");
  if (segments.length < 2 || (provider !== "gitlab" && segments.length !== 2) ||
      segments.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) return null;
  return provider === "gitea" ? path : `${provider}:${path}`;
}

export function sameRepo(a: string, b: string) {
  const left = repoParts(a.trim().toLowerCase());
  const right = repoParts(b.trim().toLowerCase());
  return left.provider === right.provider && left.path === right.path;
}

export function repoLabel(value: string) {
  const { provider, path } = repoParts(value);
  return `${REPO_PROVIDER_LABELS[provider]} · ${path}`;
}
