/**
 * Tell a one-line label whether it is actually being cut off, so it can fade
 * out instead of ending in an ellipsis (`.fade-tail` in `index.css` — the
 * IntelliJ treatment: the name dissolves into the tab rather than hitting a
 * wall of dots).
 *
 * The fade has to be conditional. It is a mask over the last ~28px of the
 * box, so applying it unconditionally would eat the tail of every *short*
 * name too — the box is only wider than its text when the flex layout has
 * room to spare. CSS can't ask "am I overflowing?", hence the observer: the
 * element's own size changes whenever its tab is resized or the strip
 * reflows, which is exactly when the answer can change.
 */

import { useEffect, useRef, useState } from "react";

export function useClipFade<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel text metrics make scrollWidth exceed clientWidth
    // by a fraction on labels that visibly fit.
    const check = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return { ref, clipped };
}
