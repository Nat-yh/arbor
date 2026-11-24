export type SelectionAxis = "x" | "y";

// Local coordinates, with the x-axis following the direction of travel.
export interface SelectionBounds {
  left: number;
  right: number;
  top: number;
  height: number;
}

export type LiquidShape = SelectionBounds & { pinch: number; lean: number; wave: number };

const mix = (start: number, end: number, fraction: number) => start + (end - start) * fraction;
const round = (number: number) => Number(number.toFixed(2));

function outline({ left, right, top, height, pinch, lean, wave }: LiquidShape, axis: SelectionAxis) {
  const vertical = axis === "y";
  const centerY = height / 2;
  const bias = pinch * lean;
  const leftHalf = centerY * (1 - .48 * (pinch + bias));
  const rightHalf = centerY * (1 - .48 * (pinch - bias));
  const leftCenter = centerY + bias * 4 + wave * .35;
  const rightCenter = centerY + bias - wave * .45;
  const maxRadius = (right - left) / 2;
  const leftRadius = Math.min(vertical ? 6 + (pinch - bias) * 5 : leftHalf * (1 + .25 * pinch), maxRadius);
  const rightRadius = Math.min(vertical ? 6 + (pinch + bias) * 5 : rightHalf * (1 + .25 * pinch), maxRadius);
  const leftCorner = vertical ? Math.min(leftHalf, leftRadius) : leftHalf;
  const rightCorner = vertical ? Math.min(rightHalf, rightRadius) : rightHalf;
  const startX = left + leftRadius;
  const endX = right - rightRadius;
  const upperX = mix(startX, endX, .5 - .18 * bias);
  const lowerX = mix(startX, endX, .5 + .25 * bias);
  const leftTop = leftCenter - leftHalf;
  const rightTop = rightCenter - rightHalf;
  const leftBottom = leftCenter + leftHalf;
  const rightBottom = rightCenter + rightHalf;
  const upperY = centerY - centerY * (1 - pinch) + wave;
  const lowerY = centerY + centerY * (1 - .83 * pinch) + wave * .5;
  const point = (x: number, y: number) => vertical
    ? `${round(y + top)} ${round(x)}`
    : `${round(x)} ${round(y + top)}`;
  const arc = .55228475;

  return [
    "M", point(left, leftTop + leftCorner),
    "C", point(left, leftTop + leftCorner * (1 - arc)), point(startX - leftRadius * arc, leftTop), point(startX, leftTop),
    "C", point(mix(startX, upperX, .55), leftTop), point(mix(startX, upperX, .70), upperY), point(upperX, upperY),
    "C", point(mix(upperX, endX, .38), upperY), point(mix(upperX, endX, .62), rightTop), point(endX, rightTop),
    "C", point(endX + rightRadius * arc, rightTop), point(right, rightTop + rightCorner * (1 - arc)), point(right, rightTop + rightCorner),
    "L", point(right, rightBottom - rightCorner),
    "C", point(right, rightBottom - rightCorner * (1 - arc)), point(endX + rightRadius * arc, rightBottom), point(endX, rightBottom),
    "C", point(mix(endX, lowerX, .30), rightBottom), point(mix(endX, lowerX, .76), lowerY), point(lowerX, lowerY),
    "C", point(mix(lowerX, startX, .35), lowerY), point(mix(lowerX, startX, .70), leftBottom), point(startX, leftBottom),
    "C", point(startX - leftRadius * arc, leftBottom), point(left, leftBottom - leftCorner * (1 - arc)), point(left, leftBottom - leftCorner),
    "Z",
  ].join(" ");
}

export function selectionBounds(element: HTMLElement, axis: SelectionAxis): SelectionBounds {
  const vertical = axis === "y";
  const left = vertical ? element.offsetTop : element.offsetLeft;
  const top = vertical ? element.offsetLeft : element.offsetTop;
  const width = vertical ? element.offsetHeight : element.offsetWidth;
  const height = vertical ? element.offsetWidth : element.offsetHeight;
  return { left, right: left + width, top, height };
}

export function paintLiquidSelection(path: SVGPathElement, shape: LiquidShape, axis: SelectionAxis) {
  path.setAttribute("d", outline(shape, axis));
}

const horizontalDeformation = .70;

function horizontalPinch(distance: number, pulse: number) {
  return pulse ** 1.25 * horizontalDeformation * Math.min(1, Math.abs(distance) / 44);
}

export function dragLiquidShape(bounds: SelectionBounds, velocity: number, axis: SelectionAxis): LiquidShape {
  const direction = Math.sign(velocity);
  const speed = Math.abs(velocity);
  const length = bounds.right - bounds.left;
  const vertical = axis === "y";
  const stretch = vertical
    ? Math.min(14, length * .45, speed * 6.8 + speed ** 2 * 1.5)
    : Math.min(54, length * .55 + 8, speed * 22 + speed ** 2 * 4);
  return {
    left: bounds.left - (direction > 0 ? stretch : 0),
    right: bounds.right + (direction < 0 ? stretch : 0),
    top: bounds.top,
    height: bounds.height,
    pinch: vertical ? Math.min(.12, stretch / bounds.height) : horizontalPinch(stretch * 1.7, 1),
    lean: direction,
    wave: -direction * stretch * .07,
  };
}

export function bindLiquidSelection(
  parent: HTMLElement, selected: HTMLElement, path: SVGPathElement,
  current: { current: LiquidShape | null }, axis: SelectionAxis,
) {
  const vertical = axis === "y";
  let frame = 0;
  let bounds: SelectionBounds | undefined;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const draw = (shape: LiquidShape) => {
    current.current = shape;
    paintLiquidSelection(path, shape, axis);
  };

  function position(animate: boolean) {
    // 取布局坐标，弹窗入场缩放和标签栏滚动不会改变底色自身的尺寸。
    const next = selectionBounds(selected, axis);
    const { left, right, top, height } = next;
    const width = right - left;
    if (bounds?.left === left && bounds.right === next.right && bounds.top === top && bounds.height === height) return;
    bounds = next;
    cancelAnimationFrame(frame);
    if (!width || !height) {
      path.removeAttribute("d");
      current.current = null;
      return;
    }

    const settled = { ...next, pinch: 0, lean: 0, wave: 0 };
    const previous = current.current;
    const distance = previous ? (next.left + next.right - previous.left - previous.right) / 2 : 0;
    if (!animate || !previous || reduced.matches || Math.abs(distance) < 1) {
      draw(settled);
      return;
    }

    const direction = Math.sign(distance);
    const intensity = Math.min(1, Math.abs(distance) / 44);
    const sway = (Math.random() - .5) * 5;
    const duration = vertical ? 210 : 350;
    const verticalDeformation = Math.min(.12, 6 / height);
    const start = performance.now();
    const advance = (time: number) => {
      const progress = Math.min(1, Math.max(0, (time - start) / duration));
      if (progress === 1 || reduced.matches) {
        draw(settled);
        return;
      }
      const head = 1 - (1 - progress) ** 2.8;
      const tail = vertical ? head : progress ** 1.8 * (2 - progress);
      const pulse = Math.sin(Math.PI * progress);
      const deformation = vertical ? pulse ** 1.25 * verticalDeformation * intensity : horizontalPinch(distance, pulse);
      const pinch = Math.max(previous.pinch * (1 - progress), deformation);
      const left = mix(previous.left, next.left, direction > 0 ? tail : head);
      const right = mix(previous.right, next.right, direction > 0 ? head : tail);
      // 侧栏底色很宽，按像素限制拖尾，连续切换时也不能叠加拉长。
      const stretch = vertical ? Math.min(7 * pulse, Math.abs(distance) * .18, Math.max(0, width + 7 - (right - left))) : 0;
      draw({
        left: left - (direction > 0 ? stretch : 0),
        right: right + (direction < 0 ? stretch : 0),
        top: mix(previous.top, next.top, head),
        height: mix(previous.height, next.height, head),
        pinch,
        lean: mix(previous.lean, direction, head),
        wave: mix(previous.wave, 0, progress) + (Math.sin(2 * Math.PI * progress) * 3 + sway) * pinch,
      });
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
  }

  position(true);
  const observer = new ResizeObserver(() => position(false));
  observer.observe(parent);
  for (const tab of parent.children) {
    if (tab instanceof HTMLElement && tab.dataset.selectionValue !== undefined) observer.observe(tab);
  }
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}
