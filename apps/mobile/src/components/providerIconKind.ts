export type ProviderIconKind = "claude" | "grok" | "cursor" | "opencode" | "pi" | "generic";

export function resolveProviderIconKind(provider: string | null | undefined): ProviderIconKind {
  switch (provider) {
    case "claudeAgent":
      return "claude";
    case "grok":
      return "grok";
    case "cursor":
      return "cursor";
    case "opencode":
      return "opencode";
    case "piAgent":
      return "pi";
    default:
      return "generic";
  }
}
