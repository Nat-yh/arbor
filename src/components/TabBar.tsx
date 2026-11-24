"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SelectionMotion } from "./SelectionMotion";
import { cx } from "./ui";

interface TabItem<Value extends string> {
  value: Value;
  label: string;
  icon: LucideIcon;
  suffix?: ReactNode;
  id?: string;
  controls?: string;
}

export function TabBar<Value extends string>({ value, items, onChange, label, className, action }: {
  value: Value;
  items: readonly TabItem<Value>[];
  onChange: (value: Value) => void;
  label: string;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cx("flex min-w-0 items-start gap-2 border-b border-line", className)}>
      <SelectionMotion value={value} role="tablist" aria-label={label}
        className="selection-tabs flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1.5">
        {items.map(({ value: key, label, icon: Icon, suffix, id, controls }) => {
          const selected = key === value;
          return (
            <button key={key} id={id} type="button" role="tab" aria-selected={selected} aria-controls={controls}
              data-selection-value={key} onClick={() => onChange(key)}
              className={cx("page-tab flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-[13px] font-medium transition-[color] sm:px-3", selected ? "text-fg" : "text-fg-3 hover:text-fg")}>
              <Icon size={15} className={selected ? "text-accent-fg" : undefined} aria-hidden="true" />
              {label}
              {suffix}
            </button>
          );
        })}
      </SelectionMotion>
      {action}
    </div>
  );
}
