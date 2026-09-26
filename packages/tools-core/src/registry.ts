import { type ToolDefinition, isReadOnly } from "@amb/protocol";

/** A registry of tools keyed by manifest name. Ordering is preserved for deterministic tool lists. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    const name = tool.manifest.name;
    if (this.tools.has(name)) throw new Error(`duplicate tool: ${name}`);
    this.tools.set(name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Names of read-only tools — used to decide which calls may run in parallel. */
  readOnlyNames(): string[] {
    return this.list()
      .filter((t) => isReadOnly(t.manifest))
      .map((t) => t.manifest.name);
  }
}
