import type {
  TreeResponse_Entry,
  ListResponse,
  ReadResponse,
  SearchResponse,
  FindResponse,
  ContextResponse,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm_pb.js";
import type { ToolAction } from "./schemas.js";

function formatTreeEntry(
  entry: TreeResponse_Entry,
  prefix: string,
  isLast: boolean,
): string {
  const connector = isLast ? "└── " : "├── ";
  const name = entry.isDir ? `${entry.name}/` : entry.name;
  let result = `${prefix}${connector}${name}\n`;
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < entry.children.length; i++) {
    result += formatTreeEntry(
      entry.children[i],
      childPrefix,
      i === entry.children.length - 1,
    );
  }
  return result;
}

export function formatResult(cmd: ToolAction, result: unknown): string {
  switch (cmd.tool) {
    case "tree": {
      const res = result as { root?: TreeResponse_Entry };
      if (!res.root) return "(empty tree)";
      const root = res.root;
      let out = `${root.name}/\n`;
      for (let i = 0; i < root.children.length; i++) {
        out += formatTreeEntry(
          root.children[i],
          "",
          i === root.children.length - 1,
        );
      }
      return out.trimEnd();
    }

    case "list": {
      const res = result as ListResponse;
      if (!res.entries.length) return "(empty directory)";
      return res.entries
        .map((e) => (e.isDir ? `${e.name}/` : e.name))
        .join("\n");
    }

    case "read": {
      const res = result as ReadResponse;
      return `cat ${res.path}\n${res.content}`;
    }

    case "search": {
      const res = result as SearchResponse;
      if (!res.matches.length) return "(no matches)";
      return res.matches
        .map((m) => `${m.path}:${m.line}:${m.lineText}`)
        .join("\n");
    }

    case "find": {
      const res = result as FindResponse;
      if (!res.items.length) return "(no matches)";
      return res.items.join("\n");
    }

    case "context": {
      const res = result as ContextResponse;
      return `Current time: ${res.time}`;
    }

    case "write":
    case "delete":
    case "mkdir":
    case "move":
      return "OK";

    case "answer":
      return "";

    default:
      return JSON.stringify(result, null, 2);
  }
}
