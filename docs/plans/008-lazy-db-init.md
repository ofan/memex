# Lazy DB Initialization

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix CLI hanging (issue #8) by deferring DB initialization to first use. `register()` stores config only — DB opens lazily on first query/command.

**Architecture:** Replace eager `createSearchStore()` + `new MemoryStore()` in `register()` with lazy getters that open the DB on first access. Gateway mode: DB opens on first `before_agent_start` hook (auto-recall). CLI mode: DB opens on first CLI command, closes on postAction.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), jiti

---

## Problem

`register()` in `index.ts` runs for EVERY `openclaw` invocation — including `openclaw --help`, `openclaw sessions`, etc. It eagerly opens SQLite databases:

```
Line 347: createSearchStore(unifiedDbFile)     ← opens DB, loads sqlite-vec
Line 350: new MemoryStore({ db: ... })         ← creates tables
```

SQLite native handles (better-sqlite3 + sqlite-vec) keep the Node event loop alive. Since `register()` runs before openclaw knows whether a memex command was requested, the DB opens for every command and never closes.

## Design

### What changes

| Current | Proposed |
|---------|----------|
| `register()` opens DB eagerly | `register()` stores config only |
| `MemoryStore` created in `register()` | `MemoryStore` created on first access via `getStore()` |
| `createSearchStore()` called in `register()` | Called inside `getStore()` on first access |
| CLI commands access `context.store` directly | CLI commands access `context.getStore()` |
| Gateway hooks access `store` directly | Gateway hooks access `getStore()` — first hook triggers init |

### Lazy wrapper

```typescript
// In register()
let _store: MemoryStore | null = null;
let _searchStore: any = null;

function getStore(): MemoryStore {
  if (!_store) {
    _searchStore = createSearchStore(unifiedDbFile);
    _searchStore.ensureVecTable(vectorDim);
    _store = new MemoryStore({ dbPath: unifiedDbFile, vectorDim, db: _searchStore.db });
  }
  return _store;
}

function getSearchStore(): any {
  getStore(); // ensures both are initialized
  return _searchStore;
}
```

### What stays the same

- All search/retrieval logic unchanged
- MemoryStore interface unchanged
- UnifiedRetriever interface unchanged
- All tests unchanged (tests create their own stores)
- Gateway behavior unchanged (DB opens on first auto-recall, which happens immediately)

### CLI lifecycle

```
openclaw --help          → register() runs, no getStore() called → exits cleanly
openclaw sessions        → register() runs, no getStore() called → exits cleanly
openclaw memex search  → register() runs → CLI action calls getStore() → DB opens → runs query → postAction closes DB → exits
openclaw gateway         → register() runs → first hook calls getStore() → DB opens → stays open
```

## Files to Modify

| File | Changes |
|------|---------|
| `index.ts` | Replace eager init with lazy `getStore()`/`getSearchStore()` |
| `src/cli.ts` | Already has postAction hook for cleanup |

Files NOT modified: `src/memory.ts`, `src/search.ts`, `src/unified-retriever.ts`, all tests.

---

## Task 1: Lazy Init in index.ts

- [ ] **Step 1: Replace eager DB init with lazy getters**

Replace lines 335-350:
```typescript
// Before (eager):
const searchStore = createSearchStore(unifiedDbFile);
searchStore.ensureVecTable(vectorDim);
const store = new MemoryStore({ dbPath: unifiedDbFile, vectorDim, db: searchStore.db });

// After (lazy):
let _store: MemoryStore | null = null;
let _searchStore: ReturnType<typeof createSearchStore> | null = null;

function getStore(): MemoryStore {
  if (!_store) {
    _searchStore = createSearchStore(unifiedDbFile);
    _searchStore.ensureVecTable(vectorDim);
    _store = new MemoryStore({ dbPath: unifiedDbFile, vectorDim, db: _searchStore.db });
  }
  return _store;
}

function getSearchStore() {
  getStore();
  return _searchStore!;
}
```

- [ ] **Step 2: Update all `store` references in register() to use getStore()**

Find all usages of `store` and `searchStoreRef` in the register function body and replace with `getStore()` / `getSearchStore()`. Key locations:

- Embedder creation (doesn't need store — leave as-is)
- Retriever creation: `createRetriever(getStore(), ...)` — but retriever is created eagerly too. Either lazy-wrap the retriever, or accept that retriever creation triggers DB init.
- UnifiedRetriever creation: `new UnifiedRetriever(getStore(), ...)` — same issue.
- Tool registration: pass `getStore` getter instead of `store` value.
- CLI registration: pass `getStore` getter.
- Service start/stop: use `_store` directly (may be null if never accessed).

The key insight: **retriever and unified retriever creation also need lazy init** since they take `store` as a constructor arg. Two approaches:

**Approach A: Lazy-wrap everything**
Create getters for retriever, unifiedRetriever, unifiedRecall too. More changes but cleanest.

**Approach B: Accept gateway inits eagerly**
For gateway mode, init immediately in the `start()` handler (which already has `if (isCli) return`). For CLI mode, init lazily in CLI command actions. This means:
- Gateway: same behavior as now (DB opens on start)
- CLI: DB opens only when a memex command runs

Approach B is simpler:

```typescript
// In register():
let store: MemoryStore | undefined;
let searchStoreRef: any = undefined;
let retriever: any = undefined;
let unifiedRetriever: any = undefined;

function initStores() {
  if (store) return;
  searchStoreRef = createSearchStore(unifiedDbFile);
  searchStoreRef.ensureVecTable(vectorDim);
  store = new MemoryStore({ dbPath: unifiedDbFile, vectorDim, db: searchStoreRef.db });
  // ... create retriever, unifiedRetriever, etc.
}

// In start():
if (!isCli) {
  initStores();
  // ... schedule background tasks
}

// In CLI actions:
// initStores() called at top of each action
```

- [ ] **Step 3: Update CLI context to use lazy init**

```typescript
// In createMemoryCLI context:
{
  get store() { initStores(); return store!; },
  get retriever() { initStores(); return retriever!; },
  // etc.
}
```

Or simpler: call `initStores()` once at the top of `registerMemoryCLI()`.

- [ ] **Step 4: Run full test suite**

- [ ] **Step 5: Test CLI hanging**

```bash
timeout 5 openclaw --help; echo "EXIT:$?"        # expect 0
timeout 5 openclaw sessions; echo "EXIT:$?"       # expect 0
timeout 10 openclaw memex stats; echo "EXIT:$?"  # expect 0
```

- [ ] **Step 6: Commit**

---

## Verification

1. `openclaw --help` exits in < 3 seconds
2. `openclaw sessions` exits in < 3 seconds
3. `openclaw memex search "test"` works and exits
4. Gateway starts normally, auto-recall works
5. All 506+ tests pass
