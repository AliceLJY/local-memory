import { describe, expect, it } from "bun:test";

import { CircuitBreaker } from "../llm-client.js";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("remains closed after failures below threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  it("resets failure count on success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.getFailureCount()).toBe(0);
    // Need 3 more to open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
  });

  it("transitions to half-open after cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canAttempt()).toBe(false);

    // Simulate cooldown elapsed by waiting
    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState()).toBe("half-open");
  });

  it("closes on successful probe in half-open state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    cb.canAttempt(); // triggers half-open
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
    expect(cb.getFailureCount()).toBe(0);
  });

  it("re-opens on failed probe in half-open state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10 });
    cb.recordFailure();

    const start = Date.now();
    while (Date.now() - start < 15) { /* busy wait */ }

    cb.canAttempt(); // triggers half-open
    cb.recordFailure(); // probe fails
    expect(cb.getState()).toBe("open");
  });

  it("blocks attempts while open and within cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    cb.recordFailure();
    expect(cb.canAttempt()).toBe(false);
    expect(cb.canAttempt()).toBe(false);
    expect(cb.canAttempt()).toBe(false);
  });

  it("uses custom config values", () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 100 });
    // 4 failures — still closed
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    // 5th opens it
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
  });
});
