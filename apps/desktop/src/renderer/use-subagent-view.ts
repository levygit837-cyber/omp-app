import { useEffect, useState } from "react";
import { replicas, useStatus } from "./session-hooks";
import { SessionLostError } from "./session-store";

export type ViewPhase = "loading" | "ready" | "lost" | "failed";

/**
 * Follows a subagent's own timeline while its panel is on screen. The view is subscribed on
 * demand and dropped when the panel goes away, so a subagent nobody looks at costs nothing here
 * however many frames it produces: its row and mark come from the parent's list.
 */
export function useSubagentView(viewId: string): ViewPhase {
  const [failure, setFailure] = useState<"lost" | "failed" | null>(null);
  const loaded = useStatus(viewId) !== undefined;
  useEffect(() => {
    let live = true;
    setFailure(null);
    replicas.open(viewId).catch((error: unknown) => {
      if (live) setFailure(error instanceof SessionLostError ? "lost" : "failed");
    });
    return () => {
      live = false;
      replicas.close(viewId).catch(() => undefined);
    };
  }, [viewId]);
  if (failure) return failure;
  return loaded ? "ready" : "loading";
}
