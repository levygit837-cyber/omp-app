import { useContext, useEffect, useRef, useState } from "react";
import { announce, announceControls, announceQueue } from "./announce";
import { commandAnnouncement } from "./command-phrase";
import { requestAnnouncement } from "./requests-view";
import {
  lastAssistantText,
  useEndedCommand,
  useModel,
  useQueue,
  useThinking,
} from "./session-hooks";
import { EngineContext, useShownStatus, useWaiting } from "./shown-status";

/**
 * The one polite live region of a session. It speaks at transitions only (a turn starts, a turn
 * ends), never per streamed chunk and never for rows that mount while scrolling.
 */
export function Announcer({ sessionId }: { sessionId: string }) {
  const status = useShownStatus(sessionId);
  const engine = useContext(EngineContext);
  const previous = useRef(status);
  const [text, setText] = useState("");
  const waiting = useWaiting(sessionId)[0];
  const askedId = useRef<string | undefined>(undefined);
  const queue = useQueue(sessionId);
  const model = useModel(sessionId);
  const thinking = useThinking(sessionId);
  const lastQueue = useRef(queue);
  const lastControls = useRef({ model, thinking });

  // Messages entering or leaving the queue strip, and the model or thinking level changing.
  // Polite, one sentence, and nothing for the first reading of a session.
  useEffect(() => {
    const said = announceQueue(lastQueue.current, queue);
    lastQueue.current = queue;
    if (said) setText(said);
  }, [queue]);
  useEffect(() => {
    const said = announceControls(lastControls.current, { model, thinking });
    lastControls.current = { model, thinking };
    if (said) setText(said);
  }, [model, thinking]);

  // A request is said once, when it first shows. The band takes focus only from the page, so a
  // person typing in the input bar hears about it here instead of having the field taken away.
  useEffect(() => {
    if (waiting?.id === askedId.current) return;
    askedId.current = waiting?.id;
    if (waiting) setText(requestAnnouncement(waiting));
  }, [waiting]);

  // A command ends on its own time, so it is said when it does. One that had already ended when
  // the session opened (a resumed history) is not news.
  const ended = useEndedCommand(sessionId);
  const spoken = useRef(ended?.id);
  useEffect(() => {
    if (!ended || ended.id === spoken.current) return;
    spoken.current = ended.id;
    setText(commandAnnouncement(ended));
  }, [ended]);

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
