# Memory browser design (issue #27)

**Status:** Scoped, not implemented. Design committed 2026-05-11 as part of the resolve-everything loop (017). Implementation deferred to a dedicated session.

## Problem statement

The only way to inspect what memex has stored today is `memory_list` / `memory_recall` (MCP tools) or `openclaw memex list` / `openclaw memex search` — text-only, paginated by terminal height, hard to filter by category × scope × date × similarity simultaneously. Three things suffer:

1. **Trust building** — users (and we) don't have a quick way to look at "what does memex remember about me?"
2. **Noise debugging** — when retrieval surfaces something weird, finding all related entries (same entity, same scope, same time window) is multi-step CLI work.
3. **Recall failure analysis** — the question "why didn't X surface?" needs side-by-side comparison of what *was* in the store vs what *got returned*. CLI doesn't do that well.

## Decision: HTML playground, served by the existing gateway

Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| **HTML playground** | Visual, click-through filters, side-by-side comparison, copy-paste shareable | Needs a server endpoint; requires browser |
| **CLI TUI** (e.g. ink/blessed) | No browser; works over SSH; matches OpenClaw's CLI feel | Slower to implement well; limited screen real estate |
| **Both** | Maximum coverage | 2x maintenance |

**Recommendation: HTML playground first.** The existing `api.registerHttpRoute` pattern in `index.ts:1515` (`/__memex/health`) is the proof-point — memex already serves HTTP through the OpenClaw gateway with bearer auth. Adding a `/__memex/browser` endpoint is the same pattern.

CLI TUI deferred — the playground covers 90% of the use case and is faster to ship.

## Endpoint surface

Two new routes under `api.registerHttpRoute`:

```
GET  /__memex/browser              → returns the HTML page (single-file, embedded JS)
GET  /__memex/browser/api/query    → returns JSON for a query
```

### Query API (`GET /__memex/browser/api/query`)

```
GET /__memex/browser/api/query?text=...&category=fact&scope=global&limit=50&since=2026-04-01
```

Returns:

```json
{
  "items": [
    {
      "id": "abc1234567890",
      "anchor": "abc12345",
      "text": "...",
      "category": "fact",
      "scope": "global",
      "importance": 0.85,
      "created": "2026-05-01T12:00:00Z",
      "lastRecalled": "2026-05-10T08:30:00Z",
      "recallCount": 17,
      "score": 0.92
    }
  ],
  "totalCount": 1234,
  "facets": {
    "categories": { "fact": 432, "decision": 89, "preference": 56, "entity": 200, "other": 34 },
    "scopes": { "global": 567, "agent:main": 245 },
    "ageBuckets": { "today": 23, "thisWeek": 87, "thisMonth": 234, "older": 467 }
  }
}
```

The facets give the UI filter buckets without a second round-trip.

## UI sketch (single-file HTML)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Memex Browser                              [search query]  [🔍]  │
├─────────────────────────────────────────────────────────────────────┤
│  Filters                                                            │
│  [✓] all [ ] fact [ ] decision [ ] preference [ ] entity            │
│  [✓] all scopes  [ ] global  [ ] agent:main  [ ] agent:coder        │
│  Date: [last 7d ▾]   Sort: [score ▾]   Show: [50 ▾]                │
├─────────────────────────────────────────────────────────────────────┤
│  1234 items match. Showing 50.                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [mem:abc12345] · fact · global · 92%                        │   │
│  │ Memex uses BM25 + vector fusion via z-score normalization.  │   │
│  │ created 2026-05-01 · recalled 17× · last 2026-05-10         │   │
│  │ [edit] [delete] [find similar]                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ [mem:def67890] · decision · agent:main · 88%                │   │
│  │ ...                                                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

Self-contained: vanilla JS + CSS embedded in one HTML file. No build step. Served as a string from the route handler.

## Auth model

Use `auth: "gateway"` pattern (same as `/__memex/health`, though note health is now exempt from auth as of #101). The gateway already has bearer-token auth in front of HTTP routes. Anyone with the gateway's URL + token can hit it. Localhost-only by default (gateway binds to 127.0.0.1 unless explicitly exposed).

**No additional auth surface needed** — piggybacks on existing infra. Browser routes should require auth (unlike the health probe).

## Security considerations

- **Read-only by default**: query endpoint is GET-only; no writes through the browser.
- **Edit / delete buttons**: when shipped, must POST to `/api/memex/forget` (existing tool surface) with the same auth gate.
- **XSS surface**: memex memories are user-controlled text. Renderer must escape all `text` fields. Use `textContent` not `innerHTML`.
- **Sensitive content**: don't render anything that pattern-matches secrets (the same patterns from `.githooks/secret-patterns.local`). Display placeholder + "this entry was masked".

## Implementation sketch

```
src/browser/
  index.ts             ← module entry; registers the two HTTP routes
  query.ts             ← runs the SQL/embedding query; returns the JSON shape above
  facets.ts            ← computes the facet counts efficiently (single SQL pass)
  html.ts              ← exports the HTML+JS+CSS as a string constant
```

Wire in `index.ts` near line 1515 alongside the existing `/__memex/health` registration.

## Expected effort

- `query.ts` + `facets.ts`: 2-3 hours (need to write efficient SQL aggregations for facets without doing N+1)
- `html.ts` (single-file UI): 4-6 hours (vanilla JS, no framework — keep it simple)
- Tests: 1-2 hours (route handlers tested through the existing test harness; HTML page tested with playwright/manual)

**Total**: ~1 dedicated day. Not loop work.

## Concrete next steps (checklist for the implementation session)

- [ ] Add `src/browser/query.ts` with the query-endpoint logic and a unit test
- [ ] Add `src/browser/facets.ts` with the facet aggregation SQL and a unit test
- [ ] Add `src/browser/html.ts` with the embedded UI (start minimal: filter bar + result list)
- [ ] Wire two routes in `index.ts` next to `/__memex/health`
- [ ] Smoke-test via `curl http://127.0.0.1:18789/__memex/browser/api/query?text=test`
- [ ] Open it in a browser, verify pagination + filters work
- [ ] Add to README under "Debugging" section (next to MEMEX_DEBUG_RECALL — both are "look at what memex actually has" tools)

## Open questions for the implementation session

1. **Pagination**: cursor-based or page-number? Cursor is more robust for live data; page-number is simpler.
2. **Real-time updates**: poll vs SSE/WebSocket? Memories don't change often per turn; polling on filter-change is probably enough.
3. **Embedded vs SPA**: keep one HTML file or split into `index.html` + `app.js`? One file = no build step but harder to debug; split = nicer DX.
4. **Edit / delete UX**: confirm dialog or "soft delete with undo"? The stakes are real — a deleted memory is gone.
5. **Cluster view**: should the UI surface "memories that look similar to this one" (using the existing vector search)? Useful for noise debugging, but bigger to build.

## Out of scope for issue #27

- **CLI TUI** — defer until HTML playground proves out the use case.
- **Cross-device shared browser** — single-daemon Pattern B in T2.x roadmap. The browser will work for the daemon you're connected to; multi-device is a separate concern.
- **Multimodal memory display** — current memex is text-only, so no need for image rendering yet.
- **Audit log of edits/deletes** — memex's `dreaming` system tracks corrections separately. Browser-driven edits would feed into that, not maintain a parallel audit log.

---

**Related**: Issue #23 (debug-recall capture) is a complementary tool — that one shows you "what was injected for one specific turn", this one shows you "what's in the store overall". Both fit naturally under a "Debugging" README section.
