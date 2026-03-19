/**
 * Thin mock of the OpenClaw Plugin API for benchmark and integration testing.
 *
 * Provides tool registration, event hook recording, and mock identity —
 * enough to exercise tools.ts and index.ts without the real gateway.
 */

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: any;
  execute: (toolCallId: string, params: any) => Promise<any>;
}

export interface MockPluginApi {
  registerTool(def: ToolDef): void;
  getRegisteredTool(name: string): ToolDef | undefined;
  executeTool(name: string, params: any): Promise<any>;
  onEvent(event: string, handler: Function): void;
  getEventHandlers(event: string): Function[];
  identity: { pluginId: string; pluginName: string; pluginVersion: string };
}

let callCounter = 0;

export function createMockPluginApi(): MockPluginApi {
  const tools = new Map<string, ToolDef>();
  const events = new Map<string, Function[]>();

  return {
    identity: {
      pluginId: "memex-mock",
      pluginName: "memex",
      pluginVersion: "0.0.0-test",
    },

    registerTool(def: ToolDef): void {
      tools.set(def.name, def);
    },

    getRegisteredTool(name: string): ToolDef | undefined {
      return tools.get(name);
    },

    async executeTool(name: string, params: any): Promise<any> {
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`);
      }
      const toolCallId = `mock-call-${++callCounter}`;
      return tool.execute(toolCallId, params);
    },

    onEvent(event: string, handler: Function): void {
      let handlers = events.get(event);
      if (!handlers) {
        handlers = [];
        events.set(event, handlers);
      }
      handlers.push(handler);
    },

    getEventHandlers(event: string): Function[] {
      return events.get(event) ?? [];
    },
  };
}
