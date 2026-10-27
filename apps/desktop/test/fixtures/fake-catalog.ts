import type { Item, StoredSession } from "@omp-app/protocol";

/**
 * Sessions "on disk" for the fake sidecar: `FAKE_STORED=<n>` makes n of them, spread over three
 * folders, newest first. Their history is a short exchange per session, so a resume has
 * something to show.
 */
const FOLDERS = [
  "/Users/dev/Projects/omp-app",
  "/Users/dev/Developer/oh-my-pi",
  "/Users/dev/scratch",
];
const PROMPTS = [
  "Why does the supervisor test flake on CI?",
  "Add a schema guard for the database version",
  "Explain how the sidecar handshake works",
  "Rename the session store selectors",
];
const HOUR = 3_600_000;

export function storedSessions(count: number, now = Date.now()): StoredSession[] {
  return Array.from({ length: count }, (_, i) => {
    const prompt = PROMPTS[i % PROMPTS.length] as string;
    return {
      id: `stored-${i + 1}`,
      cwd: FOLDERS[i % FOLDERS.length] as string,
      // The first session carries omp's own title; the others fall back to the first prompt.
      title: i === 0 ? "flaky supervisor test" : null,
      firstPrompt: prompt,
      modified: now - (i + 1) * HOUR * (i + 1),
      turns: 1,
    };
  });
}

export function storedTimeline(session: StoredSession): Item[] {
  return [
    { kind: "user", id: "i0", text: session.firstPrompt ?? "" },
    {
      kind: "assistant",
      id: "i1",
      text: `Here is what I found for “${session.firstPrompt}”.`,
      done: true,
    },
  ];
}
