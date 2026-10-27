import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { isNearBottom } from "./follow-bottom";

/**
 * Keeps a scroll container pinned to its end while its content grows, until the user scrolls
 * away from the end; scrolling back to the end resumes following. `contentSize` is anything that
 * changes whenever the content height does. `resumeToken` forces following again when it
 * changes (the user sent a prompt: they want to see the answer).
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
    const onScroll = () => {
      following.current = isNearBottom(element);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
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
