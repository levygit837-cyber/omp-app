import { createContext, useContext } from "react";
import type { CenterView } from "./plan-view";

/**
 * Which view the chat column shows, owned by `SessionPane` and read by the plan toggle in the
 * input bar, so the bar needs no props for it.
 */
export interface PlanCenter {
  readonly view: CenterView;
  readonly open: () => void;
  readonly close: () => void;
}

export const PlanCenterContext = createContext<PlanCenter>({
  view: "chat",
  open: () => {},
  close: () => {},
});

export const usePlanCenter = () => useContext(PlanCenterContext);
