import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { followAfterScroll, movesTowardsStart } from "./follow-bottom";

/**
 * Keeps a scroll container pinned to its end while its content grows, until the user scrolls
 * away from the end; scrolling back to the end resumes following. `contentSize` is anything that
 * changes whenever the content height does. `resumeToken` forces following again when it
 * changes (the user sent a prompt: they want to see the answer).
 *
 * Leaving the end takes a user gesture (wheel, keys, scrollbar drag, touch), never a `scroll`
 * event alone: see {@link followAfterScroll}.
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
    // A scrollbar drag or a touch is under way: its scroll events are the user's.
    let dragging = false;
    const onScroll = () => {
      following.current = followAfterScroll(following.current, dragging, element);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && element.scrollTop > 0) following.current = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== element) return;
      // Home and End jump by writing `scrollTop` once. The browser's own jump is animated, and
      // the virtualizer's corrections for rows measured on the way cancel it half-way.
      if (event.key === "Home" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        following.current = false;
        element.scrollTop = 0;
      } else if (event.key === "End" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        following.current = true;
        element.scrollTop = element.scrollHeight;
      } else if (movesTowardsStart(event.key, event.shiftKey) && element.scrollTop > 0) {
        following.current = false;
      }
    };
    const onMouseDown = (event: MouseEvent) => {
      // A press on the element itself, right of the content box, is on its scrollbar.
      if (event.target === element && event.offsetX >= element.clientWidth) dragging = true;
    };
    const release = () => {
      dragging = false;
    };
    const touch = () => {
      dragging = true;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("mousedown", onMouseDown);
    element.addEventListener("touchstart", touch, { passive: true });
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("mousedown", onMouseDown);
      element.removeEventListener("touchstart", touch);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
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
