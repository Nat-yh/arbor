"use client";

import { ArrowRight, ClipboardCheck, FolderPlus, ListTodo } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useStore } from "@/lib/store";
import type { PracticeTrack } from "@/lib/practice";
import { Modal } from "./kit";
import { btn } from "./ui";

export default function GettingStarted({ onClose }: { onClose: () => void }) {
  const { startPractice } = useStore();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const start = (track: PracticeTrack, fullGuide = false) => {
    const query = params.toString();
    if (startPractice(track, `${path}${query ? `?${query}` : ""}`, fullGuide)) { onClose(); router.replace("/"); }
  };
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="使用指南" desc="直接在当前页面练习。练习不会保存，也不会通知同事。">
    <div className="space-y-2 px-5 pb-5 pt-4">
      <p className="pb-1 text-[13px] leading-5 text-fg-2">处理任务 → 创建并拆分任务 → 验收与打回</p>
      <button type="button" onClick={() => start("work", true)} className={`${btn} w-full`}>开始完整指南 <ArrowRight size={15} /></button>
      <details className="pt-3 text-xs text-fg-3">
        <summary className="w-fit cursor-pointer py-1 hover:text-fg">单独练习一段</summary>
        <div className="mt-2 space-y-2">
          {([
            ["work", ListTodo, "处理一项任务", "从找到待办，到更新进展、提交和验收。"],
            ["create", FolderPlus, "创建并拆分任务", "选好所属项目，安排执行人，再拆成子任务。"],
            ["review", ClipboardCheck, "验收与打回", "写清修改意见，重新提交后再验收。"],
          ] as const).map(([track, Icon, title, desc]) => <button key={track} onClick={() => start(track)} className="group flex w-full items-center gap-3 rounded-lg border border-line px-3 py-3 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40">
            <Icon size={19} className="shrink-0 text-accent-fg" />
            <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{title}</span><span className="mt-0.5 block text-xs leading-5 text-fg-3">{desc}</span></span>
            <ArrowRight size={15} className="shrink-0 text-fg-4 group-hover:text-accent-fg" />
          </button>)}
        </div>
      </details>
      <details className="pt-3 text-xs text-fg-3">
        <summary className="w-fit cursor-pointer py-1 hover:text-fg">先了解几个常见问题</summary>
        <dl className="mt-3 space-y-3 leading-5">
          <div><dt className="font-medium text-fg-2">项目、需求和任务怎么选？</dt><dd>项目组织整体工作；需求描述要交付的功能；任务安排具体工作，可以继续拆分。</dd></div>
          <div><dt className="font-medium text-fg-2">进度 100% 就算完成了吗？</dt><dd>还需要提交给验证人验收。不需要验收的小任务可以「直接完成」，动态会注明未经验收。</dd></div>
          <div><dt className="font-medium text-fg-2">为什么不能修改或验收？</dt><dd>执行人更新工作，验证人检查结果。需求和任务可以指定执行人为验证人。有子任务时，上级进度自动汇总。</dd></div>
          <div><dt className="font-medium text-fg-2">找不到项目怎么办？</dt><dd>联系项目负责人或管理员确认成员和访问权限。</dd></div>
        </dl>
      </details>
    </div>
  </Modal>;
}
