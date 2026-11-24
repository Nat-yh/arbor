"use client";

/**
 * 基础交互组件：Radix 原语 + Arbor token 样式。
 * 只做外观和常用组合，行为（焦点、键盘、定位）交给 Radix。
 */
import * as DM from "@radix-ui/react-dropdown-menu";
import * as PO from "@radix-ui/react-popover";
import * as DG from "@radix-ui/react-dialog";
import * as TT from "@radix-ui/react-tooltip";
import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { cx, field, iconBtn } from "./ui";
import { usePracticeActive } from "@/lib/store";

const surface = "z-50 rounded-lg bg-surface shadow-pop outline-none arbor-menu";

// ───────── 下拉菜单 ─────────

/** 非模态：打开菜单不锁页面滚动，避免滚动条消失导致页面和右侧抽屉横向跳动 */
export function Menu(p: ComponentProps<typeof DM.Root>) {
  return <DM.Root modal={false} {...p} />;
}
export const MenuTrigger = DM.Trigger;

export function MenuContent({ className, children, align = "start", ...p }: ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={4} align={align} collisionPadding={8} className={cx(surface, "max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto min-w-44 p-1", className)} {...p}>
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({ className, children, icon, hint, checked, danger, ...p }: ComponentProps<typeof DM.Item> & { icon?: ReactNode; hint?: ReactNode; checked?: boolean; danger?: boolean }) {
  return (
    <DM.Item
      className={cx(
        "arbor-menu-item flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-40",
        danger ? "text-danger" : "text-fg",
        className,
      )}
      {...p}
    >
      {icon && <span className="flex w-4 shrink-0 justify-center text-fg-3 [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[11px] text-fg-4">{hint}</span>}
      {checked && <Check className="h-3.5 w-3.5 text-accent" />}
    </DM.Item>
  );
}

type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({ id, label, value, options, onValueChange, className, placeholder = "请选择" }: {
  id?: string;
  label?: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Menu>
      <MenuTrigger id={id} type="button" aria-label={label ? `${label}：${selected?.label ?? placeholder}` : undefined}
        disabled={!options.length}
        className={cx(field, "arbor-control flex min-w-0 items-center justify-between gap-2 text-left hover:border-fg-4 focus:hover:border-focus disabled:opacity-50", className)}>
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
      </MenuTrigger>
      <MenuContent className="max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))]! w-[var(--radix-dropdown-menu-trigger-width)] min-w-[min(9rem,calc(100vw-16px))]! overscroll-contain border border-line">
        <DM.RadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option) => (
            <DM.RadioItem key={option.value} value={option.value} disabled={option.disabled} textValue={option.label}
              className="arbor-menu-item flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1 text-[13px] text-fg outline-none data-[state=checked]:bg-accent-soft data-[state=checked]:text-accent data-[highlighted]:bg-hover data-[disabled]:opacity-40">
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              <span aria-hidden="true" className="size-3.5 shrink-0">
                <DM.ItemIndicator><Check className="size-3.5" /></DM.ItemIndicator>
              </span>
            </DM.RadioItem>
          ))}
        </DM.RadioGroup>
      </MenuContent>
    </Menu>
  );
}

export const MenuSeparator = () => <DM.Separator className="-mx-1 my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <DM.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-fg-4">{children}</DM.Label>;

// ───────── 弹出层 ─────────

export const Pop = PO.Root;
export const PopTrigger = PO.Trigger;
export const PopClose = PO.Close;
export const PopAnchor = PO.Anchor;

export function PopContent({ className, children, align = "start", ...p }: ComponentProps<typeof PO.Content>) {
  return (
    <PO.Portal>
      <PO.Content sideOffset={4} align={align} collisionPadding={8} className={cx(surface, "max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-16px)] overflow-y-auto p-1", className)} {...p}>
        {children}
      </PO.Content>
    </PO.Portal>
  );
}

// ───────── 对话框 ─────────

export function useModalExit<T extends unknown[]>(onDismiss: (...args: T) => void) {
  const [open, setOpen] = useState(true);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeout.current !== null) clearTimeout(timeout.current); }, []);

  function dismiss(...args: T) {
    if (timeout.current !== null) return;
    setOpen(false);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    timeout.current = setTimeout(() => onDismiss(...args), reduced ? 0 : 150);
  }
  return { open, dismiss };
}

export const modalBackdrop = "fixed inset-0 arbor-overlay bg-[rgb(15_15_30/0.28)]";

export function Modal({ open, onOpenChange, title, desc, children, className, hideClose }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; desc?: ReactNode; children: ReactNode; className?: string; hideClose?: boolean }) {
  const practice = usePracticeActive();
  return (
    <DG.Root open={open} onOpenChange={onOpenChange} modal={!practice}>
      <DG.Portal>
        <DG.Overlay className={cx(modalBackdrop, "z-50")} />
        <DG.Content
          onOpenAutoFocus={(e) => {
            // 优先聚焦输入框（原因、标题等），而不是右上角的关闭按钮
            const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("[autofocus], textarea, [contenteditable=true], input:not([type=hidden]):not([type=checkbox])");
            if (el) { e.preventDefault(); el.focus(); }
          }}
          className={cx("fixed left-1/2 top-[max(16px,4dvh)] flex max-h-[92dvh] flex-col overflow-hidden md:top-[12vh] md:max-h-[80dvh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 arbor-dialog rounded-xl bg-surface shadow-pop outline-none", className)}
        >
          <div className="flex shrink-0 items-start justify-between gap-3 px-5 pb-1 pt-4">
            <div className="min-w-0">
              <DG.Title className="text-[15px] font-semibold text-fg">{title}</DG.Title>
              {desc ? <DG.Description className="mt-1 text-[13px] text-fg-3">{desc}</DG.Description> : <DG.Description className="sr-only">{typeof title === "string" ? title : "对话框"}</DG.Description>}
            </div>
            {!hideClose && <DG.Close className={cx(iconBtn, "-mr-2 -mt-0.5")} aria-label="关闭"><X /></DG.Close>}
          </div>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">{children}</div>
        </DG.Content>
      </DG.Portal>
    </DG.Root>
  );
}

/** 需要填写原因的确认框（取消、阻塞、打回、删除等） */
export function ModalFooter({ children, left }: { children: ReactNode; left?: ReactNode }) {
  return <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-5 py-3"><div className="min-w-0 flex-1 text-xs text-fg-4">{left}</div>{children}</div>;
}

// ───────── 提示 ─────────

export function TipProvider({ delayDuration = 350, skipDelayDuration = 150, ...props }: ComponentProps<typeof TT.Provider>) {
  return <TT.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

export function Tip({ content, children, side = "top", widthClass = "max-w-64" }: {
  content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right"; widthClass?: string;
}) {
  if (!content) return <>{children}</>;
  return (
    <TT.Root>
      <TT.Trigger asChild>{children}</TT.Trigger>
      <TT.Portal>
        <TT.Content side={side} sideOffset={6} className={cx("z-[60] arbor-menu rounded-md bg-fg px-2 py-1 text-xs text-white shadow-pop", widthClass)}>
          {content}
        </TT.Content>
      </TT.Portal>
    </TT.Root>
  );
}
