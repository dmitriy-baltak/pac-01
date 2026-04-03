export interface StepTrace {
  step: number;
  tool: string;
  params: Record<string, unknown>;
  result_preview: string;
  error?: string;
  elapsed_ms: number;
  parse_error?: string;
}

export interface TaskTrace {
  task_id: string;
  prompt_version: string;
  model: string;
  instruction: string;
  steps: StepTrace[];
  outcome?: string;
  answer_message?: string;
  score?: number;
  score_detail: string[];
  total_elapsed_ms: number;
  total_steps: number;
  error?: string;
}

export class TraceCollector {
  private trace: TaskTrace;
  private startTime: number;

  constructor(taskId: string, promptVersion: string, model: string, instruction: string) {
    this.startTime = Date.now();
    this.trace = {
      task_id: taskId,
      prompt_version: promptVersion,
      model,
      instruction,
      steps: [],
      score_detail: [],
      total_elapsed_ms: 0,
      total_steps: 0,
    };
  }

  addStep(step: StepTrace): void {
    this.trace.steps.push(step);
    this.trace.total_steps = this.trace.steps.length;
  }

  setOutcome(outcome: string, message: string, _refs: string[]): void {
    this.trace.outcome = outcome;
    this.trace.answer_message = message;
  }

  setScore(score: number, detail: string[]): void {
    this.trace.score = score;
    this.trace.score_detail = detail;
  }

  setError(error: string): void {
    this.trace.error = error;
  }

  finalize(): TaskTrace {
    this.trace.total_elapsed_ms = Date.now() - this.startTime;
    this.trace.total_steps = this.trace.steps.length;
    return { ...this.trace };
  }
}
