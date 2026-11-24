"use client";

import { Check, Copy, Info, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { canManage } from "@/lib/access";
import { scheduleLabel } from "@/lib/alerts";
import { person, today, type WorkItem } from "@/lib/model";
import { personalWeeklyActivity, personalWeeklyReport, projectWeeklyPreview, reportPlainText } from "@/lib/report";
import { useStore } from "@/lib/store";
import { Modal, ModalFooter, Select } from "./kit";
import MessagePreview from "./MessagePreview";
import { SelectionMotion } from "./SelectionMotion";
import { btn, cx, field, iconBtn } from "./ui";

const shownThisSession = new Set<string>();

export function WeeklyReportNotice({ accountId }: { accountId: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const key = `arbor:weekly-report-scopes:v1:${accountId}`;
    const frame = requestAnimationFrame(() => {
      if (shownThisSession.has(key)) return;
      shownThisSession.add(key);
      try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, "1");
      } catch {
        // If browser storage is blocked, keep the once-per-session behavior.
      }
      setShow(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [accountId]);
  if (!show) return null;
  return (
    <div className="mb-5 flex items-center gap-2 rounded-lg border border-accent/20 bg-accent-soft/55 px-3 py-1.5 text-xs text-fg-2">
      <Info aria-hidden="true" className="size-4 shrink-0 text-accent-fg" />
      <p className="min-w-0 flex-1"><strong className="font-medium text-fg">周报已更新。</strong>打开「我的周报」，就能按项目汇总本周进展并复制文字。</p>
      <button type="button" aria-label="关闭周报更新提示" className={iconBtn} onClick={() => setShow(false)}><X /></button>
    </div>
  );
}

export function WeeklyReportDialog({ project, onClose }: { project?: WorkItem; onClose: () => void }) {
  const { items, acc, alerts, rules } = useStore();
  const canSeeProjectReport = !!project && canManage(items, project, acc);
  const [dimension, setDimension] = useState<"personal" | "project">(canSeeProjectReport ? "project" : "personal");
  const [scope, setScope] = useState(project?.id ?? "all");
  const [copyFeedback, setCopyFeedback] = useState<{ text: string; manual: boolean } | null>(null);
  const asOf = today();
  const activity = useMemo(() => personalWeeklyActivity(items, acc, asOf), [items, acc, asOf]);
  const options = [
    ...(project ? [{ value: project.id, label: `当前项目 · ${project.title}` }] : []),
    { value: "all", label: "全部有进度的项目" },
    ...(!project ? activity.map(({ id, title }) => ({ value: id, label: title })) : []),
  ];
  const selectedScope = options.some(({ value }) => value === scope) ? scope : "all";
  const selectedProject = selectedScope === "all" ? undefined : project ?? activity.find(({ id }) => id === selectedScope);
  const projectMode = dimension === "project" && canSeeProjectReport && !!project;
  const report = projectMode
    ? projectWeeklyPreview(items, project, alerts, asOf)
    : personalWeeklyReport(activity, person(acc.id).name, selectedProject, asOf);
  const text = reportPlainText(report);
  const feedback = copyFeedback?.text === text ? copyFeedback : null;
  const weekly = rules.find((rule) => rule.id === "weekly");
  const schedule = projectMode && (!weekly?.enabled || !weekly.channels.includes("飞书项目群")
    ? "未启用项目周报推送"
    : project.feishuChatId ? scheduleLabel("weekly", weekly.scheduleTime) : "项目尚未绑定飞书群");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback({ text, manual: false });
    } catch {
      setCopyFeedback({ text, manual: true });
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title={project ? "周报" : "我的周报"} className="max-w-xl">
      <div className="space-y-3 px-5 pb-4 pt-2">
        {canSeeProjectReport && (
          <SelectionMotion value={dimension} className="selection-segment flex w-fit bg-sunken p-0.5" role="group" aria-label="周报维度">
            {(["project", "personal"] as const).map((value) => (
              <button key={value} type="button" data-selection-value={value} aria-pressed={dimension === value}
                className={cx("h-7 px-3 text-xs font-medium", dimension === value ? "text-fg" : "text-fg-3 hover:text-fg")}
                onClick={() => { setDimension(value); setCopyFeedback(null); }}>
                {value === "project" ? "项目周报" : "个人周报"}
              </button>
            ))}
          </SelectionMotion>
        )}
        {!projectMode && (
          <Select label="周报范围" className="max-w-full sm:w-64" value={selectedScope} options={options}
            onValueChange={(value) => { setScope(value); setCopyFeedback(null); }} />
        )}
        <MessagePreview report={report} inApp />
        {feedback?.manual && (
          <label className="block space-y-1 text-xs text-fg-3">
            <span role="status">自动复制失败。请选择下方文字手动复制。</span>
            <textarea aria-label="周报文字" autoFocus readOnly rows={5} className={field} value={text} onFocus={(event) => event.currentTarget.select()} />
          </label>
        )}
      </div>
      <ModalFooter left={feedback && !feedback.manual ? <span role="status" className="text-ok">已复制到剪贴板</span> : schedule || undefined}>
        <button type="button" className={btn} disabled={!report.sections.some(({ lines }) => lines.length > 0)} onClick={() => void copy()}>
          {feedback && !feedback.manual ? <Check /> : <Copy />}复制文字
        </button>
      </ModalFooter>
    </Modal>
  );
}
