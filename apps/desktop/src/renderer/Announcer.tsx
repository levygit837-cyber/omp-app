import { useContext, useEffect, useRef, useState } from "react";
import { announce } from "./announce";
import { lastAssistantText } from "./session-hooks";
import { EngineContext, useShownStatus } from "./shown-status";

/**
 * The one polite live region of a session. It speaks at transitions only (a turn starts, a turn
 * ends), never per streamed chunk and never for rows that mount while scrolling.
 */
export function Announcer({ sessionId }: { sessionId: string }) {
  const status = useShownStatus(sessionId);
  const engine = useContext(EngineContext);
  const previous = useRef(status);
  const [text, setText] = useState("");

  useEffect(() => {
    const said = announce({
      previous: previous.current,
      status,
      engine,
      lastReply: lastAssistantText(sessionId),
    });
    previous.current = status;
    if (said) setText(said);
  }, [status, engine, sessionId]);

  return (
    <p data-testid="announcer" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </p>
  );
}
