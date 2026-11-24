"use client";

import { Check } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Effect = "start" | "ripple" | "complete" | "publish" | "submit" | "danger";
const duration: Record<Effect, number> = { start: 620, ripple: 580, complete: 580, publish: 720, submit: 620, danger: 580 };
const particles = [
  [7, 15, -24, -17, 4], [24, 0, -12, -29, 5], [45, 0, -3, -22, 3],
  [64, 0, 8, -30, 5], [87, 7, 23, -21, 4], [100, 38, 30, -7, 4],
  [96, 74, 26, 13, 5], [81, 100, 15, 19, 3], [57, 100, 5, 22, 4],
  [33, 100, -9, 19, 3], [11, 90, -24, 15, 5], [0, 55, -29, 3, 4],
];

export function useActionFeedback() {
  const [confirmed, setConfirmed] = useState(false);

  const acknowledge = async (effect: Effect = "ripple") => {
    setConfirmed(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    await new Promise<void>((resolve) => window.setTimeout(resolve, reduced ? (effect === "start" ? 400 : 120) : duration[effect]));
  };
  return { confirmed, acknowledge, clearFeedback: () => setConfirmed(false) };
}

export function LiquidButtonFace({ children }: { children: ReactNode }) {
  return (
    <span className="liquid-button-face">
      <span className="liquid-button-label">{children}</span>
      <span className="liquid-button-fill" aria-hidden="true">
        <span className="liquid-button-label">{children}</span>
      </span>
    </span>
  );
}

export function ActionFeedback({ variant = "ripple", message }: {
  variant?: Effect;
  message: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [origin, setOrigin] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setOrigin(anchor.current); }, []);

  return (
    <span ref={anchor} className={`action-feedback action-feedback--${variant}`}>
      <span role="status" className="sr-only">{message}</span>
      <span aria-hidden="true" className="action-feedback-label"><Check />{message}</span>
      {origin && <ActionBurst anchor={origin} variant={variant} />}
    </span>
  );
}

function ActionBurst({ anchor, variant, showCheck = false }: {
  anchor: HTMLElement;
  variant: Effect;
  showCheck?: boolean;
}) {
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!visibleActionAnchor(anchor)) return;
    if (!showCheck && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Measure before paint so the first particle frame is aligned with the button.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBounds(rect);
    const hide = () => {
      observer.disconnect();
      setBounds(null);
    };
    const observer = new MutationObserver(() => {
      if (!visibleActionAnchor(anchor)) hide();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state", "inert", "hidden"] });
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [anchor, showCheck]);

  if (!bounds) return null;
  return createPortal(
    <span className={`action-burst-layer action-burst-layer--${variant}`} aria-hidden="true">
      <span className="action-burst-origin" style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}>
        {showCheck && <span className="action-burst-check"><Check /></span>}
        {particles.map(([x, y, dx, dy, size]) => (
          <span key={x + ":" + y} className="action-particle" style={{
            "--particle-x": `${x}%`, "--particle-y": `${y}%`,
            "--particle-dx": `${dx}px`, "--particle-dy": `${dy}px`,
            "--particle-size": `${size}px`,
          } as CSSProperties} />
        ))}
      </span>
    </span>, document.body,
  );
}

const closedSurface = '[inert], [hidden], :is(.arbor-dialog, .arbor-drawer, .arbor-menu)[data-state="closed"]';
const passiveControl = '[role="switch"], [aria-haspopup], [aria-pressed], [aria-expanded], .arbor-menu';

function visibleActionAnchor(anchor: HTMLElement) {
  return anchor.isConnected && !anchor.closest(closedSurface);
}

export function useCommandFeedback() {
  const trigger = useRef<HTMLElement | null>(null);
  const sequence = useRef(0);
  const timers = useRef(new Map<number, number>());
  const [bursts, setBursts] = useState<{ id: number; anchor: HTMLElement; variant: Effect }[]>([]);

  useEffect(() => {
    let clearTimer: number | undefined;
    function capture(event: Event) {
      const control = event instanceof SubmitEvent
        ? event.submitter
        : event.target instanceof Element ? event.target.closest("button") : null;
      if (event.type === "submit" && !control) return;
      window.clearTimeout(clearTimer);
      trigger.current = control instanceof HTMLButtonElement && !control.closest(passiveControl) && !control.hasAttribute("data-action-feedback") ? control : null;
      // Only commands dispatched by this interaction can use its anchor.
      clearTimer = window.setTimeout(() => { trigger.current = null; }, 0);
    }

    window.addEventListener("click", capture, true);
    window.addEventListener("submit", capture, true);
    const activeTimers = timers.current;
    return () => {
      window.removeEventListener("click", capture, true);
      window.removeEventListener("submit", capture, true);
      window.clearTimeout(clearTimer);
      for (const timer of activeTimers.values()) window.clearTimeout(timer);
      activeTimers.clear();
    };
  }, []);

  const showSuccess = useCallback((anchor: HTMLElement, variant: Effect) => {
    if (!visibleActionAnchor(anchor)) return;
    const id = ++sequence.current;
    setBursts((current) => [...current, { id, anchor, variant }]);
    timers.current.set(id, window.setTimeout(() => {
      timers.current.delete(id);
      setBursts((current) => current.filter((burst) => burst.id !== id));
    }, duration.ripple));
  }, []);

  return {
    trigger,
    showSuccess,
    feedback: bursts.map(({ id, anchor, variant }) => <ActionBurst key={id} anchor={anchor} variant={variant} showCheck />),
  };
}

export function UpdateActionButton({ onActivate, className, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { onActivate: () => void }) {
  function activate(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onActivate();
  }

  return (
    <button type="button" {...props} className={`${className ?? ""} form-trigger`} onClick={activate} />
  );
}

export function StartActionButton({ onStart, children, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onStart: (feedback: () => Promise<void>) => Promise<void>;
}) {
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const [starting, setStarting] = useState(false);

  async function start(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (starting) return;
    setStarting(true);
    try {
      await onStart(() => acknowledge("start"));
    } finally {
      clearFeedback();
      setStarting(false);
    }
  }

  return (
    <button type="button" {...props} className={`${props.className ?? ""} liquid-button`} onClick={start} disabled={starting || props.disabled} aria-busy={starting && !confirmed}>
      <LiquidButtonFace>{children}</LiquidButtonFace>
      {confirmed && <ActionFeedback variant="start" message="已开始" />}
    </button>
  );
}
