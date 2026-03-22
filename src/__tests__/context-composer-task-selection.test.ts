import { describe, expect, it } from "bun:test";

import { countTaskSpecificTextMatches } from "../context-composer-task-selection.js";

describe("context composer task selection", () => {
  it("keeps later task-specific cues from long maintenance prompts", () => {
    const taskSeed =
      "继续 RecallNest continuity helper boundary audit ranking scoring selection orchestration context composer stable query fallback profile forwarding gap runner isolation";

    expect(
      countTaskSpecificTextMatches(
        "Case: Continuity eval profile forwarding gap Problem: sparse writing prompts still failed until the eval profile was forwarded correctly.",
        taskSeed,
      ),
    ).toBeGreaterThan(0);

    expect(
      countTaskSpecificTextMatches(
        "Case: Eval runner shared components skewed later continuity previews Problem: runner isolation broke when shared component state leaked across fresh-window replay.",
        taskSeed,
      ),
    ).toBeGreaterThan(0);
  });
});
