/**
 * Retrieval Trace — per-stage observability for the retrieval pipeline.
 *
 * Usage: pass an optional TraceCollector into retrieve(); each scoring stage
 * calls startStage / endStage. After retrieve() returns, call summarize()
 * for a human-readable breakdown or toJSON() for machine consumption.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetrievalStageResult {
  name: string;
  inputCount: number;
  outputCount: number;
  droppedCount: number;
  scoreRange: [number, number] | null;
  durationMs: number;
}

export interface RetrievalTrace {
  query: string;
  mode: "hybrid" | "vector";
  stages: RetrievalStageResult[];
  finalCount: number;
  totalMs: number;
}

// ── TraceCollector ───────────────────────────────────────────────────────────

export class TraceCollector {
  private stages: RetrievalStageResult[] = [];
  private stageStart = 0;
  private currentStageName = "";
  private currentInputCount = 0;
  private traceStart = 0;

  constructor() {
    this.traceStart = Date.now();
  }

  startStage(name: string, inputCount: number): void {
    this.currentStageName = name;
    this.currentInputCount = inputCount;
    this.stageStart = Date.now();
  }

  endStage(outputCount: number, scores?: number[]): void {
    const durationMs = Date.now() - this.stageStart;
    let scoreRange: [number, number] | null = null;
    if (scores && scores.length > 0) {
      const finite = scores.filter(Number.isFinite);
      if (finite.length > 0) {
        scoreRange = [Math.min(...finite), Math.max(...finite)];
      }
    }
    this.stages.push({
      name: this.currentStageName,
      inputCount: this.currentInputCount,
      outputCount,
      droppedCount: this.currentInputCount - outputCount,
      scoreRange,
      durationMs,
    });
  }

  finalize(query: string, mode: "hybrid" | "vector"): RetrievalTrace {
    const finalCount = this.stages.length > 0
      ? this.stages[this.stages.length - 1].outputCount
      : 0;
    return {
      query,
      mode,
      stages: this.stages,
      finalCount,
      totalMs: Date.now() - this.traceStart,
    };
  }

  summarize(query: string, mode: "hybrid" | "vector"): string {
    const trace = this.finalize(query, mode);
    const lines: string[] = [];
    lines.push(`[retrieve] query="${trace.query}" mode=${trace.mode} total=${trace.totalMs}ms`);
    for (const s of trace.stages) {
      const range = s.scoreRange
        ? ` [${s.scoreRange[0].toFixed(3)}–${s.scoreRange[1].toFixed(3)}]`
        : "";
      lines.push(
        `  ${s.name}: ${s.inputCount} → ${s.outputCount} (${s.droppedCount} dropped)${range} ${s.durationMs}ms`,
      );
    }
    lines.push(`  final: ${trace.finalCount} results`);
    return lines.join("\n");
  }
}
