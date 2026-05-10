/**
 * llm.ts - LLM abstraction layer for QMD using OpenAI-compatible HTTP endpoints
 *
 * Replaces node-llama-cpp with HTTP calls to a shared embedding/reranker server
 * (e.g., llama.cpp router on Mac Mini or any OpenAI-compatible API).
 */
import OpenAI from "openai";
// =============================================================================
// Embedding Formatting Functions
// =============================================================================
export function formatQueryForEmbedding(query) {
    return `task: search result | query: ${query}`;
}
export function formatDocForEmbedding(text, title) {
    return `title: ${title || "none"} | text: ${text}`;
}
// Keep these for backward compat with QMD code that references them
export const DEFAULT_EMBED_MODEL_URI = "Qwen3-Embedding-0.6B-Q8_0";
export const DEFAULT_RERANK_MODEL_URI = "bge-reranker-v2-m3-Q8_0";
export const DEFAULT_GENERATE_MODEL_URI = "";
export const DEFAULT_MODEL_CACHE_DIR = "";
export async function pullModels(_models, _options = {}) {
    return [];
}
export class LlamaCpp {
    embedClient;
    genClient = null;
    embedModel;
    embedDimensions;
    rerankEndpoint = null;
    rerankApiKey = "";
    rerankModel = "";
    rerankProvider = "jina";
    genModel = "";
    queryExpansionEnabled;
    disposed = false;
    constructor(config = { embedding: { baseURL: "", apiKey: "unused", model: "" } }) {
        this.embedClient = new OpenAI({
            baseURL: config.embedding.baseURL,
            apiKey: config.embedding.apiKey || "unused",
        });
        this.embedModel = config.embedding.model;
        this.embedDimensions = config.embedding.dimensions;
        if (config.reranker?.enabled) {
            this.rerankEndpoint = config.reranker.endpoint;
            this.rerankApiKey = config.reranker.apiKey || "unused";
            this.rerankModel = config.reranker.model;
            this.rerankProvider = config.reranker.provider || "jina";
        }
        if (config.generation) {
            this.genClient = new OpenAI({
                baseURL: config.generation.baseURL,
                apiKey: config.generation.apiKey || "unused",
            });
            this.genModel = config.generation.model;
        }
        this.queryExpansionEnabled = config.queryExpansion ?? false;
    }
    // ==========================================================================
    // Tokenization stubs (not needed for HTTP — only used for chunk sizing)
    // ==========================================================================
    async countTokens(text) {
        // Rough estimate: 1 token ≈ 4 chars (conservative)
        return Math.ceil(text.length / 4);
    }
    // ==========================================================================
    // Core API methods
    // ==========================================================================
    async embed(text, _options = {}) {
        if (this.disposed)
            return null;
        try {
            const response = await this.embedClient.embeddings.create({
                model: this.embedModel,
                input: text,
                encoding_format: "float",
                ...(this.embedDimensions ? { dimensions: this.embedDimensions } : {}),
            });
            const embedding = response.data[0]?.embedding;
            if (!embedding)
                return null;
            return {
                embedding: Array.from(embedding),
                model: this.embedModel,
            };
        }
        catch (error) {
            console.error("Embedding error:", error);
            return null;
        }
    }
    async embedBatch(texts) {
        if (this.disposed || texts.length === 0)
            return [];
        try {
            // OpenAI-compatible endpoints support batch input
            const response = await this.embedClient.embeddings.create({
                model: this.embedModel,
                input: texts,
                encoding_format: "float",
                ...(this.embedDimensions ? { dimensions: this.embedDimensions } : {}),
            });
            return response.data.map((item) => ({
                embedding: Array.from(item.embedding),
                model: this.embedModel,
            }));
        }
        catch (error) {
            console.error("Batch embedding error:", error);
            // Fallback: try one at a time
            const results = [];
            for (const text of texts) {
                results.push(await this.embed(text));
            }
            return results;
        }
    }
    async generate(prompt, options = {}) {
        if (this.disposed)
            return null;
        const client = this.genClient || this.embedClient;
        const model = options.model || this.genModel;
        if (!model)
            return null;
        try {
            const response = await client.chat.completions.create({
                model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: options.maxTokens ?? 150,
                temperature: options.temperature ?? 0.7,
                top_p: 0.8,
            });
            const text = response.choices[0]?.message?.content || "";
            return { text, model, done: true };
        }
        catch (error) {
            console.error("Generation error:", error);
            return null;
        }
    }
    async modelExists(model) {
        // HTTP models are always "available" — the server manages them
        return { name: model, exists: true };
    }
    async expandQuery(query, options = {}) {
        if (this.disposed)
            return [{ type: "vec", text: query }];
        const includeLexical = options.includeLexical ?? true;
        // If no generation model or query expansion disabled, return simple expansion
        if (!this.queryExpansionEnabled || (!this.genClient && !this.genModel)) {
            const fallback = [
                { type: "hyde", text: `Information about ${query}` },
                { type: "vec", text: query },
            ];
            if (includeLexical)
                fallback.push({ type: "lex", text: query });
            return fallback;
        }
        // Use chat completion for query expansion
        const prompt = `/no_think Expand this search query into variations for different search backends.
Output format (one per line): type: text
Types: lex (keyword search), vec (semantic search), hyde (hypothetical document)

Query: ${query}`;
        try {
            const result = await this.generate(prompt, {
                maxTokens: 600,
                temperature: 0.7,
            });
            if (!result?.text) {
                return this.simpleExpansion(query, includeLexical);
            }
            const lines = result.text.trim().split("\n");
            const queryLower = query.toLowerCase();
            const queryTerms = queryLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
            const hasQueryTerm = (text) => {
                const lower = text.toLowerCase();
                if (queryTerms.length === 0)
                    return true;
                return queryTerms.some((term) => lower.includes(term));
            };
            const queryables = lines
                .map((line) => {
                const colonIdx = line.indexOf(":");
                if (colonIdx === -1)
                    return null;
                const type = line.slice(0, colonIdx).trim();
                if (type !== "lex" && type !== "vec" && type !== "hyde")
                    return null;
                const text = line.slice(colonIdx + 1).trim();
                if (!hasQueryTerm(text))
                    return null;
                return { type: type, text };
            })
                .filter((q) => q !== null);
            const filtered = includeLexical ? queryables : queryables.filter((q) => q.type !== "lex");
            if (filtered.length > 0)
                return filtered;
            return this.simpleExpansion(query, includeLexical);
        }
        catch (error) {
            console.error("Query expansion failed:", error);
            return this.simpleExpansion(query, includeLexical);
        }
    }
    simpleExpansion(query, includeLexical) {
        const fallback = [
            { type: "hyde", text: `Information about ${query}` },
            { type: "vec", text: query },
        ];
        if (includeLexical)
            fallback.unshift({ type: "lex", text: query });
        return fallback;
    }
    async rerank(query, documents, _options = {}) {
        if (this.disposed || !this.rerankEndpoint || documents.length === 0) {
            // No reranker configured — return documents in original order with flat scores
            return {
                results: documents.map((doc, i) => ({
                    file: doc.file,
                    score: 1 - i * 0.01,
                    index: i,
                })),
                model: "none",
            };
        }
        try {
            const response = await fetch(this.rerankEndpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(this.rerankApiKey && this.rerankApiKey !== "unused"
                        ? { Authorization: `Bearer ${this.rerankApiKey}` }
                        : {}),
                },
                body: JSON.stringify({
                    model: this.rerankModel,
                    query,
                    documents: documents.map((d) => d.text),
                    top_n: documents.length,
                }),
            });
            if (!response.ok) {
                throw new Error(`Rerank failed: ${response.status} ${response.statusText}`);
            }
            const data = (await response.json());
            const results = data.results
                .map((r) => ({
                file: documents[r.index].file,
                score: r.relevance_score,
                index: r.index,
            }))
                .sort((a, b) => b.score - a.score);
            return { results, model: this.rerankModel };
        }
        catch (error) {
            console.error("Rerank error:", error);
            // Fallback: return in original order
            return {
                results: documents.map((doc, i) => ({
                    file: doc.file,
                    score: 1 - i * 0.01,
                    index: i,
                })),
                model: "none",
            };
        }
    }
    async getDeviceInfo() {
        return {
            gpu: "remote",
            gpuOffloading: false,
            gpuDevices: ["remote-server"],
            cpuCores: 0,
        };
    }
    async dispose() {
        this.disposed = true;
    }
}
// =============================================================================
// Session Management Layer
// =============================================================================
class LLMSessionManager {
    llm;
    _activeSessionCount = 0;
    _inFlightOperations = 0;
    constructor(llm) {
        this.llm = llm;
    }
    get activeSessionCount() {
        return this._activeSessionCount;
    }
    get inFlightOperations() {
        return this._inFlightOperations;
    }
    canUnload() {
        return this._activeSessionCount === 0 && this._inFlightOperations === 0;
    }
    acquire() {
        this._activeSessionCount++;
    }
    release() {
        this._activeSessionCount = Math.max(0, this._activeSessionCount - 1);
    }
    operationStart() {
        this._inFlightOperations++;
    }
    operationEnd() {
        this._inFlightOperations = Math.max(0, this._inFlightOperations - 1);
    }
    getLlamaCpp() {
        return this.llm;
    }
}
export class SessionReleasedError extends Error {
    constructor(message = "LLM session has been released or aborted") {
        super(message);
        this.name = "SessionReleasedError";
    }
}
class LLMSession {
    manager;
    released = false;
    abortController;
    maxDurationTimer = null;
    name;
    constructor(manager, options = {}) {
        this.manager = manager;
        this.name = options.name || "unnamed";
        this.abortController = new AbortController();
        if (options.signal) {
            if (options.signal.aborted) {
                this.abortController.abort(options.signal.reason);
            }
            else {
                options.signal.addEventListener("abort", () => {
                    this.abortController.abort(options.signal.reason);
                }, { once: true });
            }
        }
        const maxDuration = options.maxDuration ?? 10 * 60 * 1000;
        if (maxDuration > 0) {
            this.maxDurationTimer = setTimeout(() => {
                this.abortController.abort(new Error(`Session "${this.name}" exceeded max duration of ${maxDuration}ms`));
            }, maxDuration);
            this.maxDurationTimer.unref();
        }
        this.manager.acquire();
    }
    get isValid() {
        return !this.released && !this.abortController.signal.aborted;
    }
    get signal() {
        return this.abortController.signal;
    }
    release() {
        if (this.released)
            return;
        this.released = true;
        if (this.maxDurationTimer) {
            clearTimeout(this.maxDurationTimer);
            this.maxDurationTimer = null;
        }
        this.abortController.abort(new Error("Session released"));
        this.manager.release();
    }
    async withOperation(fn) {
        if (!this.isValid) {
            throw new SessionReleasedError();
        }
        this.manager.operationStart();
        try {
            if (this.abortController.signal.aborted) {
                throw new SessionReleasedError(this.abortController.signal.reason?.message || "Session aborted");
            }
            return await fn();
        }
        finally {
            this.manager.operationEnd();
        }
    }
    async embed(text, options) {
        return this.withOperation(() => this.manager.getLlamaCpp().embed(text, options));
    }
    async embedBatch(texts) {
        return this.withOperation(() => this.manager.getLlamaCpp().embedBatch(texts));
    }
    async expandQuery(query, options) {
        return this.withOperation(() => this.manager.getLlamaCpp().expandQuery(query, options));
    }
    async rerank(query, documents, options) {
        return this.withOperation(() => this.manager.getLlamaCpp().rerank(query, documents, options));
    }
}
// =============================================================================
// Singleton for default instance
// =============================================================================
let defaultSessionManager = null;
let defaultLlamaCpp = null;
function getSessionManager() {
    const llm = getDefaultLlamaCpp();
    if (!defaultSessionManager || defaultSessionManager.getLlamaCpp() !== llm) {
        defaultSessionManager = new LLMSessionManager(llm);
    }
    return defaultSessionManager;
}
export async function withLLMSession(fn, options) {
    const manager = getSessionManager();
    const session = new LLMSession(manager, options);
    try {
        return await fn(session);
    }
    finally {
        session.release();
    }
}
export function canUnloadLLM() {
    if (!defaultSessionManager)
        return true;
    return defaultSessionManager.canUnload();
}
export function getDefaultLlamaCpp() {
    if (!defaultLlamaCpp) {
        defaultLlamaCpp = new LlamaCpp();
    }
    return defaultLlamaCpp;
}
export function setDefaultLlamaCpp(llm) {
    defaultLlamaCpp = llm;
}
export async function disposeDefaultLlamaCpp() {
    if (defaultLlamaCpp) {
        await defaultLlamaCpp.dispose();
        defaultLlamaCpp = null;
    }
}
/**
 * Initialize the default LlamaCpp instance with shared config from the plugin.
 * Called by the plugin entry point during registration.
 */
export function initializeLLM(config) {
    const llm = new LlamaCpp(config);
    setDefaultLlamaCpp(llm);
    return llm;
}
//# sourceMappingURL=llm.js.map