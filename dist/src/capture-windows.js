/**
 * Sliding window builder for auto-capture.
 *
 * Builds overlapping windows of conversation turns (user + filtered assistant)
 * for embedding and storage as memories.
 */
import { filterAssistantText } from "./noise-filter.js";
/**
 * Build sliding windows of conversation turns for auto-capture.
 * User messages are included as-is (after envelope extraction).
 * Assistant messages are filtered (code blocks, tool output stripped).
 * Windows overlap by stride to avoid boundary splits cutting context.
 */
export function buildCaptureWindows(messages, config) {
    const stride = config.stride ?? Math.max(1, Math.floor(config.windowSize / 2));
    // Pre-process: filter assistant text, drop all-noise messages
    const processed = [];
    for (const msg of messages) {
        if (msg.role === "assistant") {
            const filtered = filterAssistantText(msg.text);
            if (filtered)
                processed.push({ role: "assistant", text: filtered });
        }
        else if (msg.role === "user") {
            if (msg.text.trim())
                processed.push({ role: "user", text: msg.text.trim() });
        }
    }
    if (processed.length === 0)
        return [];
    // Build sliding windows
    const windows = [];
    for (let start = 0; start < processed.length; start += stride) {
        const windowMsgs = processed.slice(start, start + config.windowSize);
        if (windowMsgs.length === 0)
            break;
        // Format as labeled turns
        let windowText = "";
        for (const m of windowMsgs) {
            const label = m.role === "user" ? "[user]" : "[assistant]";
            const line = `${label} ${m.text}\n`;
            if (windowText.length + line.length > config.maxChars)
                break;
            windowText += line;
        }
        windowText = windowText.trim();
        if (windowText.length >= 20) {
            windows.push(windowText);
        }
        // If we've consumed all messages, stop
        if (start + config.windowSize >= processed.length)
            break;
    }
    return windows;
}
//# sourceMappingURL=capture-windows.js.map