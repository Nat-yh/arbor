import Link from "next/link";
import type { Report, ReportLine } from "@/lib/report";
import { progressDifference } from "@/lib/feishu/card-format";
import { cx } from "./ui";

const tones = {
  neutral: "bg-linear-to-r from-sky-100 to-blue-50 text-blue-900 dark:from-sky-950 dark:to-blue-950 dark:text-sky-100",
  blue: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  purple: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  orange: "bg-warn-soft text-warn",
  red: "bg-danger-soft text-danger",
};

export default function MessagePreview({ report, quiet = false, sample = false, inApp = false }: { report: Report; quiet?: boolean; sample?: boolean; inApp?: boolean }) {
  const action = report.action;
  const actionStyle = "inline-flex rounded-md border border-accent/30 px-2.5 py-1 text-xs font-medium text-accent-fg";
  return (
    <article className="overflow-hidden rounded-lg border border-line bg-surface text-[13px]">
      <header className={cx("border-b border-line px-3.5 py-2.5", tones[report.tone ?? "blue"])}>
        <h3 className="break-words text-sm font-semibold">{report.title}</h3>
        {report.subtitle && <p className="mt-0.5 text-xs text-fg-3">{report.subtitle}</p>}
      </header>
      <div className="space-y-3 px-3.5 py-3">
        {report.sections.map((section) => {
          if (section.progress) return <ProgressSummary key={section.heading} heading={section.heading} {...section.progress} />;
          if (section.variant === "focus") return (
            <section key={section.heading} className="rounded-md bg-accent-soft px-3 py-2.5">
              {section.lines.map((line, index) => <Line key={index} line={line} focus />)}
            </section>
          );
          if (section.variant === "handoff") return (
            <section key={section.heading} className="space-y-2">
              {section.heading !== report.title && <h4 className="text-xs font-semibold text-fg-3">{section.heading}</h4>}
              {section.lines.map((line, index) => <Line key={index} line={sample ? { ...line, itemId: undefined } : line} handoff />)}
            </section>
          );
          return (
            <section key={section.heading} className="border-b border-line pb-2">
              <h4 className="font-semibold">{section.heading}</h4>
              {section.lines.length ? (
                <ul className="mt-1 divide-y divide-line">
                  {section.lines.map((line, i) => (
                    <li key={i} className="py-1.5"><Line line={line} quiet={quiet} inApp={inApp} /></li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-xs text-fg-4">暂无</p>}
            </section>
          );
        })}
        {!report.sections.length && <p className="text-fg-3">{inApp ? "本周暂无可汇总的进展" : "今天没有需要推送的待办"}</p>}
        {action && (sample ? <span className={actionStyle}>{action.label}</span>
          : <Link href={action.itemId ? `/item/${action.itemId}` : "/"} className={cx(actionStyle, "hover:bg-hover")}>{action.label}</Link>)}
      </div>
      {!inApp && (
        <div className="flex flex-wrap items-center justify-between gap-1 border-t border-line px-3.5 py-2 text-xs text-fg-4">
          <span>发送至：{report.to}</span>
          <span>Arbor 机器人</span>
        </div>
      )}
    </article>
  );
}

function Line({ line, focus, handoff, quiet, inApp }: { line: ReportLine; focus?: boolean; handoff?: boolean; quiet?: boolean; inApp?: boolean }) {
  const title = line.itemId ? <Link href={`/item/${line.itemId}`} className="wrap-anywhere hover:underline">{line.text}</Link> : line.text;
  if (focus || handoff) return (
    <div className="space-y-1">
      {focus && line.status && <span className="inline-flex rounded bg-warn-soft px-1.5 py-0.5 text-xs text-warn">{line.status}</span>}
      {handoff && line.context && <p className="text-xs text-fg-3">{line.context}</p>}
      <p className="wrap-anywhere font-semibold text-fg">{title}</p>
      {focus && line.context && <p className="text-xs text-fg-3">{line.context}</p>}
      {line.detail && <p className="wrap-anywhere text-fg-2">{handoff && line.status && <strong className="mr-1 font-medium">{line.status}</strong>}{line.detail}</p>}
    </div>
  );
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <div className="min-w-0 flex-1">
        <p className={cx("wrap-anywhere text-fg-2", !quiet && line.tone === "red" && "text-danger")}>{title}</p>
        {(line.detail || line.context) && <p className={cx("wrap-anywhere text-xs text-fg-3", inApp && "whitespace-pre-line")}>{[line.context, line.detail].filter(Boolean).join(" · ")}</p>}
      </div>
      {line.status && <span className="text-xs text-fg-3">{line.status}</span>}
    </div>
  );
}

function ProgressSummary({ heading, actual, plan }: { heading: string; actual: number; plan: number }) {
  return (
    <section className="space-y-2">
      <h4 className="font-semibold">{heading}</h4>
      <dl className="grid grid-cols-2 divide-x divide-line rounded-md bg-accent-soft px-3 py-2.5">
        <div className="pr-2"><dt className="text-xs text-fg-3">实际进度</dt><dd className="text-[25px] font-semibold leading-tight tabular-nums">{actual}<span className="text-sm">%</span></dd></div>
        <div className="pl-3"><dt className="text-xs text-fg-3">计划进度</dt><dd className="text-[25px] font-semibold leading-tight tabular-nums">{plan}<span className="text-sm">%</span></dd></div>
      </dl>
      <p className={cx("text-xs", actual < plan ? "text-warn" : "text-fg-3")}>{progressDifference(actual, plan)}</p>
    </section>
  );
}
