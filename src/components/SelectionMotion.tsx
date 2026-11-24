"use client";

import { useCallback, useId, useLayoutEffect, useRef, type ComponentProps, type PointerEvent } from "react";
import { bindLiquidSelection, dragLiquidShape, paintLiquidSelection, selectionBounds, type LiquidShape, type SelectionAxis } from "./liquidSelection";
import { cx } from "./ui";

const optionSelector = "[data-selection-value]";

function options(parent: HTMLDivElement) {
  return [...parent.children].filter((element): element is HTMLElement =>
    element instanceof HTMLElement && element.matches(optionSelector) &&
    !element.matches(':disabled,[aria-disabled="true"],[hidden]') && element.offsetWidth > 0 && element.offsetHeight > 0,
  );
}

function pointerPosition(event: PointerEvent<HTMLDivElement>, rect: DOMRect, axis: SelectionAxis) {
  const parent = event.currentTarget;
  return axis === "y"
    ? (event.clientY - rect.top) * parent.offsetHeight / rect.height + parent.scrollTop
    : (event.clientX - rect.left) * parent.offsetWidth / rect.width + parent.scrollLeft;
}

type Option = ReturnType<typeof selectionBounds> & { element: HTMLElement; center: number };
type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  options: Option[];
  grabOffset: number;
  active: boolean;
  target: HTMLElement | null;
  frame: number;
  velocity: number;
  lastPointer: number;
  lastTime: number;
  reducedMotion: boolean;
};

export function SelectionMotion({ value, axis = "x", className, children, ...props }: ComponentProps<"div"> & {
  value: string;
  axis?: SelectionAxis;
}) {
  const group = useRef<HTMLDivElement>(null);
  const liquid = useRef<SVGPathElement>(null);
  const liquidShape = useRef<LiquidShape | null>(null);
  const cancelMotion = useRef<(() => void) | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const id = useId();
  const outlineId = `${id}-outline`;
  const glossId = `${id}-gloss`;

  const settle = useCallback(() => {
    cancelMotion.current?.();
    cancelMotion.current = null;
    const parent = group.current;
    const path = liquid.current;
    if (!parent || !path) return;
    const selected = [...parent.children].find((child) =>
      child instanceof HTMLElement && child.dataset.selectionValue === value,
    );
    if (selected instanceof HTMLElement) {
      cancelMotion.current = bindLiquidSelection(parent, selected, path, liquidShape, axis);
      return;
    }
    // Each group starts from the first selection it can display.
    path.removeAttribute("d");
    liquidShape.current = null;
  }, [value, axis]);

  useLayoutEffect(() => {
    if (!gesture.current?.active) settle();
    return () => { cancelMotion.current?.(); };
  }, [settle]);
  useLayoutEffect(() => () => {
    if (gesture.current) cancelAnimationFrame(gesture.current.frame);
  }, []);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    props.onPointerDown?.(event);
    suppressClick.current = false;
    if (event.defaultPrevented || gesture.current || event.button !== 0 ||
        !event.isPrimary || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const parent = event.currentTarget;
    const origin = event.target instanceof Element ? event.target.closest(optionSelector) : null;
    if (!(origin instanceof HTMLElement) || origin.parentElement !== parent) return;
    if (event.pointerType === "touch" && (axis === "y" || origin.dataset.selectionValue !== value)) return;
    const choices = options(parent).map((element) => {
      const bounds = selectionBounds(element, axis);
      return { ...bounds, element, center: (bounds.left + bounds.right) / 2 };
    }).sort((a, b) => a.center - b.center);
    const from = choices.find(({ element }) => element === origin);
    if (!from || choices.length < 2) return;
    const rect = parent.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pointer = pointerPosition(event, rect, axis);
    gesture.current = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      options: choices, grabOffset: pointer - from.center, active: false, target: null,
      frame: 0, velocity: 0, lastPointer: pointer, lastTime: performance.now(),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    origin.setPointerCapture(event.pointerId);
  };

  const paintDrag = (event: PointerEvent<HTMLDivElement>, drag: Gesture, drawShape = true) => {
    const parent = event.currentTarget;
    const path = liquid.current;
    if (!path) return;
    const rect = parent.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pointer = pointerPosition(event, rect, axis);
    const first = drag.options[0];
    const last = drag.options[drag.options.length - 1];
    const travel = Math.abs(axis === "y" ? event.clientY - drag.startY : event.clientX - drag.startX);
    const grabOffset = drag.grabOffset * Math.max(0, 1 - travel / 32);
    const center = Math.max(first.center, Math.min(last.center, pointer - grabOffset));
    const nextIndex = drag.options.findIndex((option) => option.center >= center);
    const next = drag.options[nextIndex] ?? last;
    const previous = drag.options[Math.max(0, nextIndex - 1)] ?? first;
    const blend = next.center === previous.center ? 0 : (center - previous.center) / (next.center - previous.center);
    const inside = axis === "y"
      ? event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.left - 12 && event.clientX <= rect.right + 12
      : event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top - 12 && event.clientY <= rect.bottom + 12;
    // Use the visible pill center so its destination matches what is shown while dragging.
    drag.target = inside ? (blend < .5 ? previous.element : next.element) : null;
    if (!drawShape) return;

    const width = (previous.right - previous.left) * (1 - blend) + (next.right - next.left) * blend;
    const top = previous.top * (1 - blend) + next.top * blend;
    const height = previous.height * (1 - blend) + next.height * blend;
    const bounds = { left: center - width / 2, right: center + width / 2, top, height };
    const now = performance.now();
    const elapsed = Math.max(8, now - drag.lastTime);
    const speed = (pointer - drag.lastPointer) / elapsed;
    const momentum = drag.velocity * Math.exp(-elapsed / 45);
    const velocity = drag.reducedMotion ? 0 : Math.max(-2.4, Math.min(2.4, .35 * momentum + .65 * speed));
    drag.velocity = velocity;
    drag.lastPointer = pointer;
    drag.lastTime = now;
    cancelAnimationFrame(drag.frame);

    const draw = (speed: number) => {
      const shape = dragLiquidShape(bounds, speed, axis);
      liquidShape.current = shape;
      paintLiquidSelection(path, shape, axis);
    };
    draw(velocity);
    if (Math.abs(velocity) > .02) {
      // The leading edge stays with the pointer; the tail settles if it stops.
      const relax = (time: number) => {
        const progress = Math.max(0, Math.min(1, (time - now) / 120));
        draw(velocity * (1 - progress) ** 2);
        if (progress < 1) drag.frame = requestAnimationFrame(relax);
      };
      drag.frame = requestAnimationFrame(relax);
    }
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    props.onPointerMove?.(event);
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const dx = Math.abs(event.clientX - drag.startX);
      const dy = Math.abs(event.clientY - drag.startY);
      const along = axis === "y" ? dy : dx;
      const across = axis === "y" ? dx : dy;
      if (across > 8 && across > along) {
        gesture.current = null;
        suppressClick.current = true;
        return;
      }
      if (along < 5 || along < across) return;
      drag.active = true;
      suppressClick.current = true;
      cancelMotion.current?.();
      cancelMotion.current = null;
      event.currentTarget.setAttribute("data-selection-dragging", "");
    }
    event.preventDefault();
    paintDrag(event, drag);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!drag.active) return;
    event.currentTarget.removeAttribute("data-selection-dragging");
    if (commit) paintDrag(event, drag, false);
    cancelAnimationFrame(drag.frame);
    settle();
    if (commit && drag.target?.parentElement === event.currentTarget &&
        drag.target.dataset.selectionValue !== value && !drag.target.matches(':disabled,[aria-disabled="true"]')) {
      drag.target.focus({ preventScroll: true });
      drag.target.click();
    }
  };

  return (
    <div {...props} ref={group} className={cx("selection-motion", className)} data-axis={axis}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={(event) => { props.onPointerUp?.(event); finish(event, !event.defaultPrevented); }}
      onPointerCancel={(event) => { props.onPointerCancel?.(event); finish(event, false); }}
      onLostPointerCapture={(event) => { props.onLostPointerCapture?.(event); finish(event, false); }}
      onDragStart={(event) => {
        props.onDragStart?.(event);
        if (gesture.current) event.preventDefault();
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== "Escape" || !gesture.current?.active) return;
        cancelAnimationFrame(gesture.current.frame);
        gesture.current = null;
        event.currentTarget.removeAttribute("data-selection-dragging");
        event.preventDefault();
        event.stopPropagation();
        settle();
      }}
      onClickCapture={(event) => {
        if (suppressClick.current && event.detail > 0) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        props.onClickCapture?.(event);
      }}
    >
      <svg className="selection-liquid" aria-hidden="true" focusable="false">
        <defs>
          <path id={outlineId} ref={liquid} />
          <linearGradient id={glossId} x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="white" stopOpacity=".28" />
            <stop offset="26%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <use href={`#${outlineId}`} />
        <use href={`#${outlineId}`} fill="none" stroke={`url(#${glossId})`} strokeWidth=".75" />
      </svg>
      {children}
    </div>
  );
}
