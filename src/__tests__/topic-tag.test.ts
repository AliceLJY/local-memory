import { describe, expect, it } from "bun:test";
import { detectTopicTag, extractTopicTag, injectTopicTag } from "../topic-tag.js";

describe("detectTopicTag", () => {
  it("detects auth-related content", () => {
    expect(detectTopicTag("Implement JWT authentication with OAuth2 flow")).toBe("auth");
  });

  it("detects deploy-related content", () => {
    expect(detectTopicTag("Set up CI/CD pipeline with GitHub Actions for production deployment")).toBe("deploy");
  });

  it("detects infra-related content", () => {
    expect(detectTopicTag("Configure Docker containers and Kubernetes cluster")).toBe("infra");
  });

  it("detects testing-related content", () => {
    expect(detectTopicTag("Write unit tests with bun test and add coverage for the new module")).toBe("testing");
  });

  it("detects database-related content", () => {
    expect(detectTopicTag("Run SQL migration to add new columns to postgres users table")).toBe("database");
  });

  it("detects api-related content", () => {
    expect(detectTopicTag("Design REST API endpoints for the new webhook integration")).toBe("api");
  });

  it("detects ui-related content", () => {
    expect(detectTopicTag("Build React component with Tailwind CSS for the dashboard layout")).toBe("ui");
  });

  it("detects performance-related content", () => {
    expect(detectTopicTag("Profile cache hit rates and optimize latency bottleneck")).toBe("perf");
  });

  it("detects security-related content", () => {
    expect(detectTopicTag("Fix XSS vulnerability and add CSRF protection")).toBe("security");
  });

  it("detects memory-related content", () => {
    expect(detectTopicTag("Improve recall retrieval with better embedding vectors for LanceDB")).toBe("memory");
  });

  it("detects mcp-related content", () => {
    expect(detectTopicTag("Register new MCP tool in the Model Context Protocol server")).toBe("mcp");
  });

  it("detects llm-related content", () => {
    expect(detectTopicTag("Optimize prompt engineering for better token efficiency with Claude")).toBe("llm");
  });

  it("returns undefined for generic text", () => {
    expect(detectTopicTag("Had a great day today")).toBeUndefined();
  });

  it("returns undefined for empty text", () => {
    expect(detectTopicTag("")).toBeUndefined();
  });

  it("picks strongest match when multiple topics present", () => {
    const tag = detectTopicTag("Deploy the authentication service to production using Docker");
    expect(tag).toBeDefined();
    // Multiple topics present; strongest wins
    expect(["auth", "deploy", "infra"]).toContain(tag);
  });

  it("handles Chinese text with English tech terms", () => {
    expect(detectTopicTag("配置 Docker 容器编排和 Kubernetes 集群")).toBe("infra");
  });

  it("truncates very long text for efficiency", () => {
    const longText = "Fix authentication bug. ".repeat(500);
    expect(detectTopicTag(longText)).toBe("auth");
  });
});

describe("extractTopicTag", () => {
  it("extracts topicTag from metadata JSON", () => {
    expect(extractTopicTag('{"topicTag":"auth","source":"manual"}')).toBe("auth");
  });

  it("returns undefined when no topicTag", () => {
    expect(extractTopicTag('{"source":"manual"}')).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(extractTopicTag("not json")).toBeUndefined();
  });

  it("returns undefined for undefined/null metadata", () => {
    expect(extractTopicTag(undefined)).toBeUndefined();
    expect(extractTopicTag("")).toBeUndefined();
  });
});

describe("injectTopicTag", () => {
  it("injects topicTag into metadata JSON", () => {
    const result = injectTopicTag('{"source":"manual"}', "deploy");
    const parsed = JSON.parse(result);
    expect(parsed.topicTag).toBe("deploy");
    expect(parsed.source).toBe("manual");
  });

  it("overwrites existing topicTag", () => {
    const result = injectTopicTag('{"topicTag":"old","source":"manual"}', "new");
    expect(JSON.parse(result).topicTag).toBe("new");
  });

  it("returns original on invalid JSON", () => {
    expect(injectTopicTag("broken", "tag")).toBe("broken");
  });
});
