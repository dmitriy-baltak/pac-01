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

export const NextStep = z.object({
  current_state: z.string(),
  plan_remaining_steps_brief: z.array(z.string()).min(1).max(5),
  task_completed: z.boolean(),
  action: ToolAction,
});

export type NextStep = z.infer<typeof NextStep>;
export type ToolAction = z.infer<typeof ToolAction>;
