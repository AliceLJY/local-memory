import { describe, expect, it } from "bun:test";

import { AGE_UNKNOWN, formatAgeLabel, formatIsoAgeLabel } from "../age-label.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-17T12:00:00.000Z");

describe("age label", () => {
  it("renders whole days, floored", () => {
    expect(formatAgeLabel(NOW, NOW)).toBe("0d");
    expect(formatAgeLabel(NOW - 23 * 3_600_000, NOW)).toBe("0d");
    expect(formatAgeLabel(NOW - 1 * DAY, NOW)).toBe("1d");
    expect(formatAgeLabel(NOW - 14 * DAY - 5 * 3_600_000, NOW)).toBe("14d");
    expect(formatAgeLabel(NOW - 400 * DAY, NOW)).toBe("400d");
  });

  it("reads a future stamp as today, not a negative age", () => {
    expect(formatAgeLabel(NOW + 3 * DAY, NOW)).toBe("0d");
  });

  it("does not fabricate an age for unusable stamps", () => {
    expect(formatAgeLabel(0, NOW)).toBe(AGE_UNKNOWN);
    expect(formatAgeLabel(undefined, NOW)).toBe(AGE_UNKNOWN);
    expect(formatAgeLabel(Number.NaN, NOW)).toBe(AGE_UNKNOWN);
    expect(formatIsoAgeLabel("not-a-date", NOW)).toBe(AGE_UNKNOWN);
    expect(formatIsoAgeLabel("", NOW)).toBe(AGE_UNKNOWN);
  });

  it("accepts ISO strings the same way", () => {
    expect(formatIsoAgeLabel("2026-08-03T09:30:00.000Z", NOW)).toBe("14d");
    expect(formatIsoAgeLabel("2026-08-17T00:00:00.000Z", NOW)).toBe("0d");
  });
});
