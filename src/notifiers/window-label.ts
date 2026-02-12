import type { Alert } from "./types.js";

export function formatWindowLabel(window: Alert["window"] | string): string {
  switch (window) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return window;
  }
}
