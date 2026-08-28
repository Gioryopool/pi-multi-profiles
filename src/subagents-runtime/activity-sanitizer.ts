import type { LiveActivityEntry } from "./types.js";

export const ACTIVITY_LIMIT = 8;
export const HEADING_LIMIT = 120;
const FALLBACKS = new Set(["Thinking", "Reading files", "Searching code", "Editing files", "Running commands", "Using tool"]);
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const UNSAFE = /[\\/]|\b(?:https?|ftp|file|data|mailto|ssh|git|ws|wss|s3):|\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|\b(?:bearer|authorization|auth|token|secret|api[_ -]?key|password)\b(?:\s*(?:=|:)\s*|\s+)\S+|\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]+\b|\bxox[A-Za-z0-9_-]+\b|\b(?:\.env|id_rsa|credentials?|\.pem|\.key)\b/i;
const hasCredentialLikeToken = (value: string) => (value.match(/[A-Za-z0-9+_.=-]{32,}/g) ?? []).some((token) => [/[a-z]/, /[A-Z]/, /\d/, /[+_.=-]/].filter((pattern) => pattern.test(token)).length >= 3);

/** Validates full model-authored headings before producing a bounded public summary. */
export function sanitizeSemanticHeading(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || CONTROL.test(value) || UNSAFE.test(value) || hasCredentialLikeToken(value)) return undefined;
  return value.trim().replace(/\s+/g, " ").slice(0, HEADING_LIMIT);
}

/** Accepts only exact activity kinds and their corresponding safe label vocabulary. */
export function sanitizeActivityEntry(value: unknown): LiveActivityEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "semantic") {
    const label = sanitizeSemanticHeading(entry.label);
    return label ? { label, kind: "semantic" } : undefined;
  }
  if (entry.kind === "fallback" && typeof entry.label === "string" && FALLBACKS.has(entry.label)) return { label: entry.label, kind: "fallback" };
  return undefined;
}

export function sanitizeActivityTrail(value: unknown): LiveActivityEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(sanitizeActivityEntry).filter((entry): entry is LiveActivityEntry => Boolean(entry)).reduce<LiveActivityEntry[]>((trail, entry) => [...trail.filter((current) => current.label !== entry.label), entry], []).slice(-ACTIVITY_LIMIT);
}

export function fallbackActivity(tool: unknown): LiveActivityEntry | undefined {
  if (typeof tool !== "string" || !tool.trim()) return undefined;
  const label = tool === "read" ? "Reading files" : ["grep", "find", "codegraph"].includes(tool) ? "Searching code" : ["edit", "write"].includes(tool) ? "Editing files" : tool === "bash" ? "Running commands" : "Using tool";
  return { label, kind: "fallback" };
}
