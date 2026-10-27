import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import {
  followAfterRelease,
  followAfterScroll,
  isScrollPress,
  jumpTarget,
  movesTowardsStart,
  type ScrollMetrics,
} from "./follow-bottom";

/**
 * Keeps a scroll container pinned to its end while its content grows, until the user scrolls
 * away from the end; scrolling back to the end resumes following. `contentSize` is anything that
 * changes whenever the content height does. `resumeToken` forces following again when it
 * changes (the user sent a prompt: they want to see the answer).
 *
 * Leaving the end takes a user gesture (wheel, keys, any pointer press on the scroller), never a
 * `scroll` event alone: see {@link followAfterScroll}. While a press is held following is off;
 * on release it is decided again from the distance to the end.
 */
export function useFollowBottom(
  ref: RefObject<HTMLElement | null>,
  contentSize: number,
  resumeToken: unknown,
): void {
  const following = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A pointer press on the scroller is held: a scrollbar drag, a selection drag or a touch.
    let pressed = false;
    // Where the user has left the view since the press: the geometry at the press, then at each
    // scroll it caused.
    let left: ScrollMetrics = element;
    const snapshot = (): ScrollMetrics => ({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    });
    const onScroll = () => {
      following.current = followAfterScroll(following.current, false, element, pressed);
      if (pressed) left = snapshot();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && element.scrollTop > 0) following.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== element) return;
      const jump = jumpTarget(event.key, {
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
      });
      if (jump === "start") {
        event.preventDefault();
        following.current = false;
        element.scrollTop = 0;
      } else if (jump === "end") {
        event.preventDefault();
        following.current = true;
        element.scrollTop = element.scrollHeight;
      } else if (movesTowardsStart(event.key, event.shiftKey) && element.scrollTop > 0) {
        following.current = false;
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isScrollPress(event.button)) return;
      pressed = true;
      left = snapshot();
      following.current = false;
    };
    const onRelease = () => {
      if (!pressed) return;
      pressed = false;
      following.current = followAfterRelease(left);
      if (following.current) element.scrollTop = element.scrollHeight;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("pointerdown", onPointerDown);
    // On the window: the press is often released outside the scroller.
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", onRelease);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onRelease);
      window.removeEventListener("pointercancel", onRelease);
    };
  }, [ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resumeToken is the trigger, not a value read here
  useLayoutEffect(() => {
    following.current = true;
  }, [resumeToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSize is the trigger, not a value read here
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [ref, contentSize, resumeToken]);
}
