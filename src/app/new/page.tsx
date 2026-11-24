"use client";

import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "@/components/ActionFeedback";
import { DraftScreenshots, useScreenshotDraft } from "@/components/DraftScreenshots";
import { SelectionMotion } from "@/components/SelectionMotion";
import StateBoundary from "@/components/StateBoundary";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Select } from "@/components/kit";
import { Avatar, Badge, PageHeader, btn, cx, field } from "@/components/ui";
import { buildNewChecklist, dateOffset, today } from "@/lib/model";
import { DateField, PersonSelect, useAssignable } from "@/components/pickers";
import { useStore } from "@/lib/store";

export default function NewPage() {
  return <StateBoundary><NewPageContent /></StateBoundary>;
}

function NewPageContent() {
  const { me } = useStore();
  return <NewItem key={me} />;
}

function NewItem() {
  const { me, addItem, practice } = useStore();
  const assignable = useAssignable();
  const executors = useAssignable(true);
  const router = useRouter();
  const { projects, acc } = useStore();
  const [kind, setKind] = useState<"project" | "feature">(projects.length ? "feature" : "project");
  const [parentId, setParentId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [ai, setAi] = useState(false);
  const [owner, setOwner] = useState(me);
  const [assignees, setAssignees] = useState<string[]>([me]);
  const [verifiers, setVerifiers] = useState<string[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [due, setDue] = useState(dateOffset(today(), 14));
  const [group, setGroup] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const screenshots = useScreenshotDraft();
  const canAddScreenshots = kind === "feature" && !practice;
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();

  const checklist = buildNewChecklist(kind, ai).filter((check) => check.source === "AI 应用");
  const errors: string[] = [];
  if (!title.trim()) errors.push("请填写标题");
  if (!assignees.length) errors.push("请至少选择一位执行人");
  if (kind === "feature" && !verifiers.length) errors.push("需求至少指定一位验证人");
  if (kind === "project" && verifiers.length && verifiers.every((id) => assignees.includes(id))) errors.push("请选择一位执行人以外的项目验证人");

  const submit = async () => {
    setTried(true);
    if (errors.length || busy) return;
    setBusy(true);
    try {
      const id = await addItem({
        parentId: kind === "project" ? null : parentId,
        kind,
        title: title.trim(),
        desc: desc.trim() || undefined,
        owner,
        assignees,
        due,
        verifiers,
        ai,
        feishuGroup: kind === "project" ? group.trim() || undefined : undefined,
        acceptance: acceptance.split("\n").map((s) => s.trim()).filter(Boolean),
        ...(kind === "project" ? { members: [...new Set([me, owner, ...verifiers, ...members])] } : {}),
      }, canAddScreenshots ? screenshots.files : []);
      if (!id) return;
      await acknowledge();
      router.push(`/item/${id}`);
    } finally {
      clearFeedback();
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl text-[13px]">
      <PageHeader title="新建" desc="先建项目或需求，再在详情页里逐层拆分任务和子任务" />
      <div className="space-y-6">
        <div className="space-y-5" onPaste={canAddScreenshots && !busy ? screenshots.onPaste : undefined}>
          <SelectionMotion value={kind} className="selection-segment inline-flex rounded-md bg-sunken p-0.5" role="group" aria-label="新建类型">
            {(acc.canCreate ? (["feature", "project"] as const) : (["feature"] as const)).map((k) => (
              <button key={k} data-selection-value={k} aria-pressed={kind === k} disabled={busy} onClick={() => setKind(k)} className={cx("h-7 rounded px-5 text-[13px]", kind === k ? "text-fg" : "text-fg-3 hover:text-fg")}>
                {k === "feature" ? "需求" : "项目"}
              </button>
            ))}
          </SelectionMotion>

          <p className="text-xs text-fg-3">{kind === "feature" ? "需求归属项目，创建后可继续拆分任务。" : "项目用于组织需求、任务和协作成员。"}</p>

          {kind === "feature" && (
            <label className="block text-[13px] font-medium">
              所属项目
              <Select value={parentId} onValueChange={setParentId} className="mt-1"
                options={projects.map((p) => ({ value: p.id, label: p.title }))} />
            </label>
          )}

          <label className="block text-[13px] font-medium">
            标题
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "project" ? "项目名称" : "需求名称"} className={cx(field, "mt-1")} />
          </label>
          <label className="block text-[13px] font-medium">
            背景 / 目标
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} className={cx(field, "mt-1")} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[13px] font-medium">
              负责人
              <PersonSelect label="负责人" value={owner} onPick={setOwner} className="mt-1" people={assignable} />
            </label>
            <label className="block text-[13px] font-medium">
              截止日期
              <DateField label="截止日期" value={due} onPick={setDue} disabled={busy} className="mt-1" />
            </label>
          </div>

          <div className="text-[13px] font-medium">
            执行人
            <PersonSelect multiple keepOpen label="执行人" value={assignees} onPick={setAssignees} className="mt-1" people={executors} />
          </div>

          <div>
            <div className="text-[13px] font-medium">验证人 <span className="font-normal text-fg-4">· 负责评审和验收{kind === "project" ? "，不能只有执行人自己" : ""}</span></div>
            <PersonSelect multiple keepOpen label="验证人" value={verifiers} onPick={setVerifiers} className="mt-1"
              people={assignable.filter(({ id }) => kind !== "project" || verifiers.includes(id) || !assignees.includes(id))} />
          </div>

          {kind === "project" && (
            <div>
              <div className="text-[13px] font-medium">成员 <span className="font-normal text-fg-4">· 你、负责人、执行人和验证人会自动加入</span></div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {assignable.map((p) => {
                  const auto = p.id === me || p.id === owner || assignees.includes(p.id) || verifiers.includes(p.id);
                  const on = auto || members.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      aria-pressed={on}
                      disabled={auto}
                      title={auto ? "自动加入" : undefined}
                      onClick={() => setMembers((v) => (v.includes(p.id) ? v.filter((x) => x !== p.id) : [...v, p.id]))}
                      className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1", on ? "bg-accent-soft text-accent-fg ring-accent/40" : "text-fg-2 ring-line-strong hover:bg-hover", auto && "cursor-default opacity-70")}
                    >
                      <Avatar id={p.id} size={4} />{p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {kind === "project" ? (
            <label className="block text-[13px] font-medium">
              绑定飞书群 <span className="font-normal text-fg-4">· 项目风险和周报会发到这个群</span>
              <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="项目群名称" className={cx(field, "mt-1")} />
            </label>
          ) : (
            <label className="block text-[13px] font-medium">
              验收标准 <span className="font-normal text-fg-4">· 提交验收前填写，每行一条</span>
              <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} className={cx(field, "mt-1")} />
            </label>
          )}

          {canAddScreenshots && <DraftScreenshots draft={screenshots} busy={busy} />}

          <label className="flex items-start gap-2 rounded-lg border border-line p-3">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="text-[13px] font-semibold">AI 应用</span>
              <span className="block text-xs text-fg-3">需要验证 Prompt 效果、Bad Case 和调用成本</span>
            </span>
          </label>

          {tried && errors.length > 0 && <ul className="rounded-lg bg-danger-soft px-4 py-3 text-[13px] text-danger">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <button data-action-feedback="local" onClick={submit} className={cx(btn, "liquid-button")} disabled={busy} aria-busy={busy && !confirmed}>
            <LiquidButtonFace>创建并开始拆分任务</LiquidButtonFace>
            {confirmed && <ActionFeedback message={kind === "project" ? "项目已创建" : "需求已创建"} />}
          </button>
        </div>

        {checklist.length > 0 && (
          <details className="border-t border-line py-4">
            <summary className="cursor-pointer text-[13px] font-medium text-fg-2">AI 应用检查项 · {checklist.length} 项</summary>
            <ul className="mt-3 space-y-1.5">
              {checklist.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-[13px]">
                  <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border border-line-strong" />
                  <span className="flex-1">{c.label}</span>
                  {c.source === "AI 应用" && <Badge>{c.source}</Badge>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
