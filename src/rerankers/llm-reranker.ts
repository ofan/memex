/**
 * LLM-based reranker: uses a chat model (via OpenAI-compatible API) to judge
 * the relevance ordering of documents to a query.
 *
 * This is an alternative to the cross-encoder reranker. Quality is often
 * better (the model can reason about semantic relevance) but latency is
 * 10-50x higher and there's a per-token cost for cloud models.
 *
 * Design: we ask the model to ORDER the documents (most relevant first) rather
 * than score them. Ordering is what an LLM is good at, and a bare index list
 * is trivial to parse — no fragile JSON extraction. The ordering is converted
 * to rank-normalized scores (top = 1.0, decreasing) which the retriever blends
 * with the fusion score exactly like the cross-encoder's "rank" score mode.
 *
 * Batch size is capped at 10 documents to keep latency and cost reasonable.
 * Documents are truncated to 600 chars each to stay within context limits.
 *
 * Uses node:http directly (not fetch) because the proxy's nginx ingress
 * returns empty bodies for chunked Transfer-Encoding requests from undici.
 */

import http from "node:http";
import https from "node:https";

const RERANK_SYSTEM_PROMPT = `You are a relevance ranker. Given a query and a set of numbered documents, return the document indices ordered from MOST relevant to LEAST relevant.

Rules:
- Output ONLY the index numbers, separated by commas. Example: 2, 0, 5, 1
- Most relevant first.
- Omit documents that are completely irrelevant.
- No explanations, no brackets, no text other than the comma-separated indices.`;

export interface LlmRerankerOptions {
  /** OpenAI-compatible chat completions endpoint (e.g. http://proxy/v1/chat/completions) */
  endpoint: string;
  /** API key (dummy if proxy doesn't require auth) */
  apiKey: string;
  /** Model name */
  model: string;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Max documents per call (default: 10, max: 20) */
  maxDocuments?: number;
}

export interface RerankItem {
  index: number;
  score: number;
}

/** Build the user prompt with query and numbered documents. */
function buildPrompt(query: string, documents: string[]): string {
  const docList = documents
    .map((doc, i) => `[${i}] ${doc.slice(0, 600)}`)
    .join("\n\n");
  return `Query: ${query}\n\nDocuments:\n${docList}\n\nReturn the indices in relevance order.`;
}

/**
 * Parse the LLM's free-text response into an ordered list of document indices.
 *
 * Accepts any of: "2, 0, 5", "2,0,5", "2\n0\n5", "[2,0,5]", or mixed.
 * Returns null if no valid indices are found.
 */
function parseOrdering(text: string): number[] | null {
  // Strip markdown fences / brackets if present, then split on non-digit runs.
  const nums = text.match(/\d+/g);
  if (!nums) return null;

  const indices: number[] = [];
  for (const n of nums) {
    const idx = parseInt(n, 10);
    if (Number.isFinite(idx) && !indices.includes(idx)) {
      indices.push(idx);
    }
  }
  return indices.length > 0 ? indices : null;
}

/**
 * Convert an ordering into rank-normalized scores.
 * top = 1.0, decreasing linearly: score = 1 - rank / n.
 */
function orderingToScores(ordering: number[]): RerankItem[] {
  const n = ordering.length || 1;
  return ordering.map((index, rank) => ({
    index,
    score: 1 - rank / n,
  }));
}

/**
 * Rerank documents using an LLM as a relevance ranker.
 *
 * Sends query + documents to the chat model, parses the returned index
 * ordering, and converts it to rank-normalized scores. Documents beyond
 * maxDocuments (or omitted by the model as irrelevant) keep their original
 * fusion scores.
 *
 * Returns null if the LLM call or parsing fails — caller should fall back
 * to fusion scores.
 */
export async function llmRerank(
  query: string,
  documents: string[],
  originalScores: number[],
  options: LlmRerankerOptions,
): Promise<RerankItem[] | null> {
  const maxDocs = Math.min(options.maxDocuments ?? 10, 20);
  const toRerank = documents.slice(0, maxDocs);

  const prompt = buildPrompt(query, toRerank);
  const timeoutMs = options.timeoutMs ?? 30000;
  const parsedUrl = new URL(options.endpoint);
  const isHttps = parsedUrl.protocol === "https:";
  const transport = isHttps ? https : http;

  const body = JSON.stringify({
    model: options.model,
    messages: [
      { role: "system", content: RERANK_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 256,
  });

  try {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = transport.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(raw) as Record<string, unknown>);
            } catch {
              reject(new Error("invalid JSON response"));
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });

    const choices = data.choices as Array<{ message: { content: string; reasoning_content?: string } }> | undefined;
    // Reasoning models (deepseek-v4-flash, etc.) may produce empty content
    // and put the real output in reasoning_content. Try content first.
    const content = choices?.[0]?.message?.content || choices?.[0]?.message?.reasoning_content;
    if (!content) {
      console.warn("LLM reranker: empty response content");
      return null;
    }

    const ordering = parseOrdering(content);
    if (!ordering) {
      console.warn("LLM reranker: no indices in response");
      return null;
    }

    // Filter to valid indices and convert to rank-normalized scores.
    const valid = ordering.filter(i => i >= 0 && i < toRerank.length);
    if (valid.length === 0) {
      console.warn("LLM reranker: no valid indices in response");
      return null;
    }
    const result: RerankItem[] = orderingToScores(valid);

    // Documents the model ranked (within maxDocs) but omitted from its list
    // are treated as irrelevant — keep them with a low score so they don't
    // outrank reranked docs but still survive the floor if fusion was strong.
    const rankedIndices = new Set(valid);
    for (let i = 0; i < toRerank.length; i++) {
      if (!rankedIndices.has(i)) {
        result.push({ index: i, score: originalScores[i] ?? 0 });
      }
    }

    // Documents beyond maxDocs were never sent — keep original fusion scores.
    for (let i = maxDocs; i < documents.length; i++) {
      result.push({ index: i, score: originalScores[i] ?? 0 });
    }

    return result;
  } catch (err) {
    console.warn("LLM reranker: request failed:", (err as Error).message);
    return null;
  }
}
