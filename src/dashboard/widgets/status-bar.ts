import { format } from "date-fns";

export function updateStatusBar(
  bar: { setContent: (value: string) => void },
  lastUpdated: Date | null,
  nextPoll: Date | null,
  message?: string
): void {
  const lastText = lastUpdated ? format(lastUpdated, "HH:mm:ss") : "--:--:--";
  const nextText = nextPoll ? format(nextPoll, "HH:mm:ss") : "--:--:--";
  const extra = message ? ` | ${message}` : "";
  bar.setContent(
    ` Last updated: ${lastText} | Next poll: ${nextText} | q:Quit r:Refresh d/w/m:Period Tab:Focus${extra}`
  );
}
