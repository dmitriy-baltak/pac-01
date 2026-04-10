import { z } from "zod";

export const ReadAction = z.object({
  tool: z.literal("read"),
  path: z.string(),
  number: z.boolean().optional().default(false),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
});

export const WriteAction = z.object({
  tool: z.literal("write"),
  path: z.string(),
  content: z.string(),
  start_line: z.number().int().optional(),
  end_line: z.number().int().optional(),
});

export const DeleteAction = z.object({
  tool: z.literal("delete"),
  path: z.string(),
});

export const MkDirAction = z.object({
  tool: z.literal("mkdir"),
  path: z.string(),
});

export const MoveAction = z.object({
  tool: z.literal("move"),
  from: z.string(),
  to: z.string(),
});

export const ListAction = z.object({
  tool: z.literal("list"),
  path: z.string(),
});

export const TreeAction = z.object({
  tool: z.literal("tree"),
  root: z.string().optional().default(""),
  level: z.number().int().optional().default(2),
});

export const FindAction = z.object({
  tool: z.literal("find"),
  root: z.string().optional().default(""),
  name: z.string(),
  type: z.enum(["all", "files", "dirs"]).optional().default("all"),
  limit: z.number().int().min(1).max(20).optional().default(20),
});

export const SearchAction = z.object({
  tool: z.literal("search"),
  root: z.string().optional().default(""),
  pattern: z.string(),
  limit: z.number().int().min(1).max(20).optional().default(20),
});

export const ContextAction = z.object({
  tool: z.literal("context"),
});

export const AnswerAction = z.object({
  tool: z.literal("answer"),
  message: z.string(),
  outcome: z.enum([
    "ok",
    "denied_security",
    "none_clarification",
    "none_unsupported",
    "err_internal",
  ]),
  refs: z.array(z.string()).optional().default([]),
});

export const ToolAction = z.discriminatedUnion("tool", [
  ReadAction,
  WriteAction,
  DeleteAction,
  MkDirAction,
  MoveAction,
  ListAction,
  TreeAction,
  FindAction,
  SearchAction,
  ContextAction,
  AnswerAction,
]);

export type ToolAction = z.infer<typeof ToolAction>;

// --- OpenAI native tool-calling definitions ---

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function zodToToolDef(
  name: string,
  description: string,
  schema: z.ZodObject<z.ZodRawShape>,
): OpenAIToolDefinition {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const allProperties = (jsonSchema.properties ?? {}) as Record<string, unknown>;
  const { tool: _tool, ...properties } = allProperties;
  const required = ((jsonSchema.required as string[]) ?? []).filter((r) => r !== "tool");
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

export const TOOL_DEFINITIONS: OpenAIToolDefinition[] = [
  zodToToolDef("read", "Read a file from the vault", ReadAction),
  zodToToolDef("write", "Write content to a file in the vault", WriteAction),
  zodToToolDef("delete", "Delete a file from the vault", DeleteAction),
  zodToToolDef("mkdir", "Create a directory in the vault", MkDirAction),
  zodToToolDef("move", "Move/rename a file in the vault", MoveAction),
  zodToToolDef("list", "List files in a vault directory", ListAction),
  zodToToolDef("tree", "Show directory tree of the vault", TreeAction),
  zodToToolDef("find", "Find files by name pattern in the vault", FindAction),
  zodToToolDef("search", "Search file contents by grep pattern in the vault", SearchAction),
  zodToToolDef("context", "Get current vault context (time, metadata)", ContextAction),
  zodToToolDef("answer", "Submit final answer for the task", AnswerAction),
];

export const TOOL_SCHEMA_MAP: Record<string, z.ZodType> = {
  read: ReadAction,
  write: WriteAction,
  delete: DeleteAction,
  mkdir: MkDirAction,
  move: MoveAction,
  list: ListAction,
  tree: TreeAction,
  find: FindAction,
  search: SearchAction,
  context: ContextAction,
  answer: AnswerAction,
};
