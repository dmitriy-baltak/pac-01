import { execFile } from "node:child_process";

export interface ClaudeResponse {
  result: string;
  structured_output?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
}

export function callClaude(
  model: string,
  systemPrompt: string,
  prompt: string,
): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const args = [
      "--print",
      "--output-format", "json",
      "--model", model,
      "--system-prompt", systemPrompt,
    ];

    const child = execFile("claude", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    }, (err, stdout, stderr) => {
      // CLI may output valid JSON even on non-zero exit
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.is_error) {
            reject(new Error(`claude CLI error: ${parsed.result || JSON.stringify(parsed).slice(0, 500)}`));
            return;
          }
          resolve(parsed);
          return;
        } catch {
          // stdout not valid JSON, fall through
        }
      }
      if (err) {
        reject(new Error(`claude CLI failed (exit ${(err as NodeJS.ErrnoException).code}): ${stderr || err.message}`));
        return;
      }
      reject(new Error(`Empty response from claude CLI`));
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
