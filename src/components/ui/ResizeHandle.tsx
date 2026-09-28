// Thin draggable bar for resizing a panel along one axis. Positioned
// absolutely by the parent, straddling the edge it resizes: a 9px grab strip
// that paints a 1px line on the edge itself, so the resting state stays
// minimal and the target is still something a pointer can land on.
//
// The grab strip IS this element. It used to be a 1px element with a wider
// invisible child overhanging it, and that child was clipped away by the
// sidebar's `overflow-hidden`: measured with elementFromPoint, the sidebar
// divider was grabbable across exactly ONE pixel (e2e/specs/tabs-layout.e2e.ts
// measures it now). Hit testing respects a clip, so a hit area that leaves its
// parent's box is a hit area that may not exist. An element can only be relied
// on to receive events inside its own box, inside whatever clips it.
//
// Calls `onDrag(delta)` with the pixel delta since the LAST mousemove (not
// since drag start), so consumers can just `state += delta` and clamp.

import { useRef } from "react";
import { cn } from "@/lib/utils";

/** How much of the strip sits on the NEIGHBOUR's side of the line. The bigger
 *  share, because the panel's own side of the edge is where its scrollbar
 *  lives and a divider must not eat that. */
const OUTSIDE = 5;
/** How much sits on the owning panel's side. Together: a 9px strip for a 1px
 *  line, the pixel of which is the panel's own border. */
const INSIDE = 3;
const STRIP = INSIDE + 1 + OUTSIDE;

interface Props {
  /** "x" = vertical bar (drag horizontal); "y" = horizontal bar (drag vertical). */
  direction: "x" | "y";
  /** Which edge of the positioned parent this handle sits on. The strip is
   *  centred on that edge rather than tucked inside it, which is the whole
   *  difference between a divider you can grab and one you can only hover. */
  anchor?: "left" | "right" | "top" | "bottom";
  onDrag: (delta: number) => void;
  /** Optional: called once when drag starts. */
  onStart?: () => void;
  /** Optional: called once when drag ends (e.g., persist final value). */
  onEnd?: () => void;
  /** When true, the handle paints a visible resting line (use for splits where
   *  the border is the only separator, e.g. the vertical right split). */
  alwaysVisible?: boolean;
  /** Rendered as `data-resize-handle`. A resize is a mouse drag on a bar with
   *  no text and no role, so e2e has nothing else to aim at. */
  label?: string;
  className?: string;
}

export function ResizeHandle({
  direction, anchor = direction === "x" ? "left" : "top",
  onDrag, onStart, onEnd, alwaysVisible, label, className,
}: Props) {
  const lastRef = useRef<number | null>(null);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    lastRef.current = direction === "x" ? e.clientX : e.clientY;
    document.body.style.cursor = direction === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Kill column/row transitions while dragging — otherwise the grid lerps
    // toward each new width and the handle visibly trails the cursor.
    document.documentElement.style.setProperty("--cols-transition", "none");
    document.documentElement.classList.add("is-resizing");
    onStart?.();
    function onMove(ev: MouseEvent) {
      const prev = lastRef.current; if (prev == null) return;
      const cur = direction === "x" ? ev.clientX : ev.clientY;
      onDrag(cur - prev);
      lastRef.current = cur;
    }
    function onUp() {
      lastRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.documentElement.style.removeProperty("--cols-transition");
      document.documentElement.classList.remove("is-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onEnd?.();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // The geometry is inline style, not Tailwind: these are computed from the
  // two constants above, and an arbitrary class built by interpolation is a
  // class Tailwind never sees and never emits. Every offset is a whole number
  // of CSS pixels on purpose - a strip centred with a percentage translate
  // lands on a half pixel, and a 1px line on a half pixel is the blur this
  // codebase keeps re-learning about.
  const thickness = alwaysVisible ? 2 : 1;
  const horizontal = direction === "x";
  const strip: React.CSSProperties = horizontal
    ? {
      top: 0, bottom: 0, width: STRIP,
      ...(anchor === "right"
        ? { right: 0, transform: `translateX(${OUTSIDE}px)` }
        : { left: 0, transform: `translateX(${-OUTSIDE}px)` }),
    }
    : {
      left: 0, right: 0, height: STRIP,
      ...(anchor === "bottom"
        ? { bottom: 0, transform: `translateY(${OUTSIDE}px)` }
        : { top: 0, transform: `translateY(${-OUTSIDE}px)` }),
    };
  // Where the line sits inside the strip, so it covers the panel's border
  // pixel rather than the content beside it.
  const at = INSIDE + 1 - thickness;
  const line: React.CSSProperties = horizontal
    ? { top: 0, bottom: 0, left: at, width: thickness }
    : { left: 0, right: 0, top: at, height: thickness };

  return (
    <div
      onMouseDown={onMouseDown}
      data-resize-handle={label}
      style={strip}
      className={cn("group absolute z-20", horizontal ? "cursor-col-resize" : "cursor-row-resize", className)}
    >
      {/* The line. Painted on hover of the whole strip, so what lights up and
          what takes the press are the same region. */}
      <div
        style={line}
        className={cn(
          "absolute transition-colors group-hover:bg-[var(--color-accent-soft)] group-active:bg-[var(--color-accent)]",
          alwaysVisible && "bg-[var(--color-border)]",
        )}
      />
    </div>
  );
}
