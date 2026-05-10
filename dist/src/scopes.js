/**
 * Multi-Scope Access Control System
 * Manages memory isolation and access permissions
 */
// ============================================================================
// Default Configuration
// ============================================================================
export const DEFAULT_SCOPE_CONFIG = {
    default: "global",
    definitions: {
        global: {
            description: "Shared knowledge across all agents",
        },
    },
    agentAccess: {},
};
// ============================================================================
// Built-in Scope Patterns
// ============================================================================
const SCOPE_PATTERNS = {
    GLOBAL: "global",
    AGENT: (agentId) => `agent:${agentId}`,
    CUSTOM: (name) => `custom:${name}`,
    PROJECT: (projectId) => `project:${projectId}`,
    USER: (userId) => `user:${userId}`,
    SESSION: (sessionId) => `session:${sessionId}`,
};
// ============================================================================
// Scope Manager Implementation
// ============================================================================
export class MemoryScopeManager {
    config;
    constructor(config = {}) {
        this.config = {
            default: config.default || DEFAULT_SCOPE_CONFIG.default,
            definitions: {
                ...DEFAULT_SCOPE_CONFIG.definitions,
                ...config.definitions,
            },
            agentAccess: {
                ...DEFAULT_SCOPE_CONFIG.agentAccess,
                ...config.agentAccess,
            },
        };
        // Ensure global scope always exists
        if (!this.config.definitions.global) {
            this.config.definitions.global = {
                description: "Shared knowledge across all agents",
            };
        }
        this.validateConfiguration();
    }
    validateConfiguration() {
        // Validate default scope exists in definitions
        if (!this.config.definitions[this.config.default]) {
            throw new Error(`Default scope '${this.config.default}' not found in definitions`);
        }
        // Validate agent access scopes exist in definitions
        for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
            for (const scope of scopes) {
                if (!this.config.definitions[scope] && !this.isBuiltInScope(scope)) {
                    console.warn(`Agent '${agentId}' has access to undefined scope '${scope}'`);
                }
            }
        }
    }
    isBuiltInScope(scope) {
        return (scope === "global" ||
            scope.startsWith("agent:") ||
            scope.startsWith("custom:") ||
            scope.startsWith("project:") ||
            scope.startsWith("user:") ||
            scope.startsWith("session:"));
    }
    getAccessibleScopes(agentId) {
        if (!agentId) {
            // No agent specified, return all scopes
            return this.getAllScopes();
        }
        // Check explicit agent access configuration
        const explicitAccess = this.config.agentAccess[agentId];
        if (explicitAccess) {
            return explicitAccess;
        }
        // Default access: global + agent-specific scope
        const defaultScopes = ["global"];
        const agentScope = SCOPE_PATTERNS.AGENT(agentId);
        // Only include agent scope if it already exists — don't mutate config as a side effect
        if (this.config.definitions[agentScope] || this.isBuiltInScope(agentScope)) {
            defaultScopes.push(agentScope);
        }
        return defaultScopes;
    }
    getDefaultScope(agentId) {
        if (!agentId) {
            return this.config.default;
        }
        // For agents, default to their private scope if they have access to it
        const agentScope = SCOPE_PATTERNS.AGENT(agentId);
        const accessibleScopes = this.getAccessibleScopes(agentId);
        if (accessibleScopes.includes(agentScope)) {
            return agentScope;
        }
        return this.config.default;
    }
    isAccessible(scope, agentId) {
        if (!agentId) {
            // No agent specified, allow access to all valid scopes
            return this.validateScope(scope);
        }
        const accessibleScopes = this.getAccessibleScopes(agentId);
        return accessibleScopes.includes(scope);
    }
    validateScope(scope) {
        if (!scope || typeof scope !== "string" || scope.trim().length === 0) {
            return false;
        }
        const trimmedScope = scope.trim();
        // Check if scope is defined or is a built-in pattern
        return (this.config.definitions[trimmedScope] !== undefined ||
            this.isBuiltInScope(trimmedScope));
    }
    getAllScopes() {
        return Object.keys(this.config.definitions);
    }
    getScopeDefinition(scope) {
        return this.config.definitions[scope];
    }
    // Management methods
    addScopeDefinition(scope, definition) {
        if (!this.validateScopeFormat(scope)) {
            throw new Error(`Invalid scope format: ${scope}`);
        }
        this.config.definitions[scope] = definition;
    }
    removeScopeDefinition(scope) {
        if (scope === "global") {
            throw new Error("Cannot remove global scope");
        }
        if (!this.config.definitions[scope]) {
            return false;
        }
        delete this.config.definitions[scope];
        // Clean up agent access references
        for (const [agentId, scopes] of Object.entries(this.config.agentAccess)) {
            const filtered = scopes.filter(s => s !== scope);
            if (filtered.length !== scopes.length) {
                this.config.agentAccess[agentId] = filtered;
            }
        }
        return true;
    }
    setAgentAccess(agentId, scopes) {
        if (!agentId || typeof agentId !== "string") {
            throw new Error("Invalid agent ID");
        }
        // Validate all scopes
        for (const scope of scopes) {
            if (!this.validateScope(scope)) {
                throw new Error(`Invalid scope: ${scope}`);
            }
        }
        this.config.agentAccess[agentId] = [...scopes];
    }
    removeAgentAccess(agentId) {
        if (!this.config.agentAccess[agentId]) {
            return false;
        }
        delete this.config.agentAccess[agentId];
        return true;
    }
    validateScopeFormat(scope) {
        if (!scope || typeof scope !== "string") {
            return false;
        }
        const trimmed = scope.trim();
        // Basic format validation
        if (trimmed.length === 0 || trimmed.length > 100) {
            return false;
        }
        // Allow alphanumeric, hyphens, underscores, colons, and dots
        const validFormat = /^[a-zA-Z0-9._:-]+$/.test(trimmed);
        return validFormat;
    }
    // Export/Import configuration
    exportConfig() {
        return JSON.parse(JSON.stringify(this.config));
    }
    importConfig(config) {
        this.config = {
            default: config.default || this.config.default,
            definitions: {
                ...this.config.definitions,
                ...config.definitions,
            },
            agentAccess: {
                ...this.config.agentAccess,
                ...config.agentAccess,
            },
        };
        this.validateConfiguration();
    }
    // Statistics
    getStats() {
        const scopes = this.getAllScopes();
        const scopesByType = {
            global: 0,
            agent: 0,
            custom: 0,
            project: 0,
            user: 0,
            session: 0,
            other: 0,
        };
        for (const scope of scopes) {
            if (scope === "global") {
                scopesByType.global++;
            }
            else if (scope.startsWith("agent:")) {
                scopesByType.agent++;
            }
            else if (scope.startsWith("custom:")) {
                scopesByType.custom++;
            }
            else if (scope.startsWith("project:")) {
                scopesByType.project++;
            }
            else if (scope.startsWith("user:")) {
                scopesByType.user++;
            }
            else if (scope.startsWith("session:")) {
                scopesByType.session++;
            }
            else {
                scopesByType.other++;
            }
        }
        return {
            totalScopes: scopes.length,
            agentsWithCustomAccess: Object.keys(this.config.agentAccess).length,
            scopesByType,
        };
    }
}
// ============================================================================
// Factory Functions
// ============================================================================
export function createScopeManager(config) {
    return new MemoryScopeManager(config);
}
export function createAgentScope(agentId) {
    return SCOPE_PATTERNS.AGENT(agentId);
}
export function createCustomScope(name) {
    return SCOPE_PATTERNS.CUSTOM(name);
}
export function createProjectScope(projectId) {
    return SCOPE_PATTERNS.PROJECT(projectId);
}
export function createUserScope(userId) {
    return SCOPE_PATTERNS.USER(userId);
}
export function createSessionScope(sessionId) {
    return SCOPE_PATTERNS.SESSION(sessionId);
}
// ============================================================================
// Utility Functions
// ============================================================================
export function parseScopeId(scope) {
    if (scope === "global") {
        return { type: "global", id: "" };
    }
    const colonIndex = scope.indexOf(":");
    if (colonIndex === -1) {
        return null;
    }
    return {
        type: scope.substring(0, colonIndex),
        id: scope.substring(colonIndex + 1),
    };
}
export function isScopeAccessible(scope, allowedScopes) {
    return allowedScopes.includes(scope);
}
export function filterScopesForAgent(scopes, agentId, scopeManager) {
    if (!scopeManager || !agentId) {
        return scopes;
    }
    return scopes.filter(scope => scopeManager.isAccessible(scope, agentId));
}
//# sourceMappingURL=scopes.js.map