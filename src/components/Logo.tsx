import { useId } from "react";

/** Arbor 系统图标：靛蓝渐变底 + 白色工作树，与 public/brand/arbor-icon.svg、浏览器标签图标一致。 */
export function Logo({ size = 24, className, markOnly = false }: { size?: number; className?: string; markOnly?: boolean }) {
  const id = useId();
  const mark = markOnly ? "currentColor" : "#fff";
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden focusable="false">
      {!markOnly && (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#6461F0" />
              <stop offset="1" stopColor="#4338CA" />
            </linearGradient>
          </defs>
          <rect width="1024" height="1024" rx="224" fill={`url(#${id})`} />
        </>
      )}
      <g transform="translate(0 -36)">
        <g fill="none" stroke={mark} strokeWidth="56" strokeLinecap="round" strokeLinejoin="round">
          <path d="M512 806V470" />
          <path d="M512 640C512 560 448 520 352 500" />
          <path d="M512 590C512 520 576 470 672 448" />
        </g>
        <g fill={mark}>
          <circle cx="512" cy="372" r="96" />
          <circle cx="318" cy="494" r="70" />
          <circle cx="706" cy="440" r="70" />
        </g>
        <rect x="404" y="790" width="216" height="40" rx="20" fill={mark} opacity=".55" />
      </g>
    </svg>
  );
}
