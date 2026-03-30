function flattenContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(flattenContent)
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if ("content" in record) return flattenContent(record.content);
    if ("parts" in record) return flattenContent(record.parts);
  }
  return "";
}

export function extractRecallQuery(event: { prompt?: string; messages?: unknown[] }): string {
  const messages = Array.isArray(event.messages) ? event.messages : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user") continue;
    const text = flattenContent(record.content);
    if (text) return text;
  }

  return typeof event.prompt === "string" ? event.prompt : "";
}
