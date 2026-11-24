"use client";

import { useState, type ReactNode } from "react";
import { canAddChild, canAddItemScreenshots, canEditPlan, verifierAllowed } from "@/lib/access";
import { diffPatch, editFormFields } from "@/lib/changes";
import type { CommandResult } from "@/lib/commands";
import { PEOPLE, usesAcceptanceCriteria, workingDays, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { isInactive, isLeaf, levelLabel, verifiersOf } from "@/lib/tree";
import { AttachmentList } from "./Attachments";
import { DraftScreenshots, useScreenshotDraft } from "./DraftScreenshots";
import { Modal, ModalFooter, useModalExit } from "./kit";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { DateField, PersonSelect } from "./pickers";
import { btn, btnGhost, cx, field } from "./ui";

type Draft = { screenshots?: File[] } & Pick<WorkItem, "parentId" | "kind" | "title" | "owner" | "assignee" | "start" | "due" | "verifiers"> & Pick<Partial<WorkItem>, "iteration" | "assignees">;

type EditFields = Omit<ReturnType<typeof editFormFields>, "ai" | "assignee" | "deliveryChecks">;
type FormFields = Omit<EditFields, "acceptance"> & { acceptance: string };

function formFields(values: EditFields): FormFields {
  return { ...values, acceptance: values.acceptance.join("\n") };
}

function toPatch(form: FormFields): EditFields {
  return {
    ...form, title: form.title.trim(), desc: form.desc.trim(),
    acceptance: form.acceptance.split("\n").map((line) => line.trim()).filter(Boolean),
  };
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={cx("block text-xs text-fg-3", wide && "sm:col-span-2")}>{label}<div className="mt-1">{children}</div></label>;
}

export default function WorkItemForm(props: ({ item: WorkItem; draft?: never } | { item?: never; draft: Draft }) & { onDone: (saved?: boolean) => void }) {
  const { item } = props;
  const { open, dismiss } = useModalExit(props.onDone);
  const initial = props.item ?? props.draft;
  const { items, edit, addItem, acc, practice } = useStore();
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const parent = items.find((entry) => entry.id === initial.parentId);
  const type = levelLabel(items, initial);
  const [baseline, setBaseline] = useState(() => {
    const { ai: _ai, assignee: _assignee, deliveryChecks: _deliveryChecks, ...editable } = editFormFields(initial);
    void _ai; void _assignee; void _deliveryChecks;
    return editable;
  });
  const [form, setForm] = useState(() => formFields(baseline));
  const [busy, setBusy] = useState(false);
  const screenshotIds = item?.screenshotIds ?? [];
  const screenshots = useScreenshotDraft(props.draft?.screenshots, screenshotIds.length);
  const canEditFields = !item || (!isInactive(items, item) && canEditPlan(items, item, acc));
  const canAddScreenshots = !practice && (item ? canAddItemScreenshots(items, item, acc) : initial.kind !== "project");
  const [conflict, setConflict] = useState<CommandResult>();
  const active = item ? canEditFields || canAddScreenshots
    : !!parent && !isInactive(items, parent) && levelLabel(items, parent) !== "子任务" && canAddChild(items, parent, acc, initial.kind);
  const inherited = parent ? verifiersOf(items, parent) : [];
  const availableVerifiers = form.verifiers.length ? form.verifiers : inherited;
  const verification = { kind: initial.kind, assignee: initial.assignee, assignees: form.assignees };
  const error = !form.assignees.length ? "请至少选择一位执行人"
    : form.start && form.due && form.start > form.due ? "截止日期不能早于开始日期"
    : (form.verifiers.length > 0 || (!item && initial.kind === "feature")) && !availableVerifiers.some((id) => verifierAllowed(verification, id))
      ? (initial.kind === "project" ? "请选择执行人以外的验证人" : "请选择验证人") : "";
  const needsCriteria = item ? usesAcceptanceCriteria(item) : initial.kind === "feature";
  const valid = canEditFields ? !!(form.title.trim() && form.start && form.due && !error) : screenshots.files.length > 0;

  const loadConflictFields = () => {
    if (!conflict?.conflicts) return;
    const { acceptance, ...current } = conflict.conflicts;
    setBaseline((before) => ({ ...before, ...conflict.conflicts }));
    setForm((draft) => ({ ...draft, ...current, ...(acceptance ? { acceptance: acceptance.join("\n") } : {}) }));
    setConflict(undefined);
  };

  const save = async () => {
    if (!valid || busy || conflict) return;
    const plan = toPatch(form);
    setBusy(true);
    try {
      if (item) {
        const changes = canEditFields ? diffPatch(toPatch(formFields(baseline)), plan) : [];
        const images = canAddScreenshots ? screenshots.files : [];
        if (changes.length || images.length) {
          const updated = Object.fromEntries(changes.map(({ key, to }) => [key, to]));
          const expected = Object.fromEntries(changes.map(({ key }) => [key, baseline[key as keyof EditFields]]));
          const result = await edit(item.id, updated, canEditFields ? "编辑属性" : "编辑截图", expected, images);
          if (!result.ok) {
            if (result.conflicts) setConflict(result);
            return;
          }
          await acknowledge();
        }
      } else {
        const id = await addItem({
          ...plan, parentId: initial.parentId, kind: initial.kind,
          ...(initial.iteration ? { iteration: initial.iteration } : {}),
        }, canAddScreenshots ? screenshots.files : []);
        if (!id) return;
        await acknowledge();
      }
      dismiss(true);
    } finally {
      clearFeedback(); setBusy(false);
    }
  };

  if (!active) return null;
  return (
    <Modal open={open} onOpenChange={(next) => { if (!next && !busy) dismiss(); }} title={canEditFields ? item ? `编辑${type}` : `新建${type}` : "编辑截图"} desc={item ? undefined : parent?.title} className="max-w-2xl">
      <form onPaste={canAddScreenshots && !busy ? screenshots.onPaste : undefined} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} className="grid gap-3 px-5 pb-4 pt-3 sm:grid-cols-2">
          {canEditFields && <>
            <Field label="标题" wide><input required maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={field} /></Field>
            <Field label="说明" wide><textarea rows={3} maxLength={20000} value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} className={field} /></Field>
            <Field label="负责人">
              <PersonSelect label="负责人" value={form.owner} onPick={(owner) => setForm((current) => ({ ...current, owner }))}
                people={PEOPLE.filter((person) => person.active !== false || person.id === form.owner)} />
            </Field>
            <Field label="执行人">
              <PersonSelect multiple keepOpen requireProjectAccess label="执行人" value={form.assignees} placeholder="选择一位或多位"
                onPick={(assignees) => setForm((current) => ({ ...current, assignees }))} />
            </Field>
            <Field label="开始"><DateField label="开始日期" value={form.start} disabled={busy} onPick={(start) => setForm((current) => ({ ...current, start }))} /></Field>
            <Field label="截止"><DateField label="截止日期" value={form.due} min={form.start} disabled={busy} onPick={(due) => setForm((current) => ({ ...current, due }))} /></Field>
            {initial.kind !== "project" && (!item || isLeaf(items, item.id)) && (
              <p className="text-xs text-fg-3 sm:col-span-2">工作量 <output className="ml-1 tabular-nums text-fg-2">{form.start && form.due && form.start <= form.due ? `${workingDays(form.start, form.due)} 人天` : "—"}</output></p>
            )}
            <Field label="验证人" wide>
              <PersonSelect multiple keepOpen label="验证人" value={form.verifiers} placeholder={parent ? "沿用上级" : "请选择验证人"}
                onPick={(verifiers) => setForm((current) => ({ ...current, verifiers }))}
                people={PEOPLE.filter((person) => form.verifiers.includes(person.id) || (person.active !== false && verifierAllowed(verification, person.id)))} />
            </Field>
            <Field label={needsCriteria ? "验收标准 · 提交验收前填写，每行一条" : "验收标准 · 每行一条"} wide><textarea rows={3} value={form.acceptance} onChange={(e) => setForm({ ...form, acceptance: e.target.value })} className={field} /></Field>
            {error && <p role="alert" className="text-xs text-danger sm:col-span-2">{error}</p>}
          </>}
          {canAddScreenshots && <div className="space-y-2 sm:col-span-2">
            <AttachmentList ids={screenshotIds} />
            <DraftScreenshots draft={screenshots} busy={busy} />
          </div>}
          {conflict && <div className="rounded-md bg-warn-soft px-3 py-2 text-xs text-fg sm:col-span-2">
            <p role="alert">{conflict.reason} 可载入这些字段的最新值，其他编辑会保留。</p>
            <button type="button" className={cx(btnGhost, "mt-1 text-accent-fg")} onClick={loadConflictFields}>载入冲突字段的最新值</button>
          </div>}
        </fieldset>
        <ModalFooter>
          <button type="button" onClick={() => dismiss()} disabled={busy} className={btnGhost}>取消</button>
          <button data-action-feedback="local" type="submit" disabled={!valid || busy || !!conflict} className={cx(btn, "liquid-button min-w-24", confirmed && "disabled:opacity-100")} aria-busy={busy && !confirmed}><LiquidButtonFace>{item ? "保存" : "创建"}</LiquidButtonFace>{confirmed && <ActionFeedback message={item ? "已保存" : "已创建"} />}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
