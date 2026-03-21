// CallingClaw 2.0 — Tool Definition Types
// Shared types for modular tool definitions

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

export interface ToolModule {
  definitions: ToolDefinition[];
  handler: (name: string, args: any) => Promise<string>;
}
