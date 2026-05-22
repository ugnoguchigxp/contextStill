import { describe, expect, it } from "vitest";
import {
  decodeFileUrl,
  deriveProjectContextFromValues,
  deriveProjectFromPath,
  extractPathCandidates,
  isAgentTaskLogPath,
} from "../src/modules/agent-log-sync/project-analyzer.js";

describe("project-analyzer", () => {
  describe("decodeFileUrl", () => {
    it("should decode file:// URLs to paths", () => {
      expect(decodeFileUrl("file:///Users/test/Code/my-project")).toBe(
        "/Users/test/Code/my-project",
      );
    });

    it("should return the path itself if it does not start with file://", () => {
      expect(decodeFileUrl("/Users/test/Code/my-project")).toBe("/Users/test/Code/my-project");
    });
  });

  describe("deriveProjectFromPath", () => {
    it("should extract project details from 'Code' subdirectory patterns", () => {
      const result = deriveProjectFromPath("/Users/y.noguchi/Code/memoryRouter/src/index.ts");
      expect(result.projectName).toBe("memoryRouter");
      expect(result.projectRoot).toBe("/Users/y.noguchi/Code/memoryRouter");
    });

    it("should fallback to basename for absolute paths if 'Code' is not present", () => {
      const result = deriveProjectFromPath("/home/user/my-awesome-app");
      expect(result.projectName).toBe("my-awesome-app");
      expect(result.projectRoot).toBe("/home/user/my-awesome-app");
    });

    it("should not classify Antigravity background task logs as projects", () => {
      const result = deriveProjectFromPath(
        "/Users/y.noguchi/.gemini/antigravity/brain/session/.system_generated/logs/task-240.log",
      );
      expect(result).toEqual({});
    });

    it("should return empty object if path is undefined or empty", () => {
      expect(deriveProjectFromPath(undefined)).toEqual({});
      expect(deriveProjectFromPath("")).toEqual({});
    });
  });

  describe("isAgentTaskLogPath", () => {
    it("should identify generated task log paths", () => {
      expect(isAgentTaskLogPath("file:///tmp/task-240.log")).toBe(true);
      expect(isAgentTaskLogPath("/tmp/task-240.log")).toBe(true);
      expect(isAgentTaskLogPath("/tmp/task-report.log")).toBe(false);
    });
  });

  describe("extractPathCandidates", () => {
    it("should find file URLs and absolute user paths in text", () => {
      const text =
        "Found file:///Users/y.noguchi/Code/project1 and another at /Users/y.noguchi/Code/project2/file.js";
      const candidates = extractPathCandidates(text);
      expect(candidates).toContain("file:///Users/y.noguchi/Code/project1");
      expect(candidates).toContain("/Users/y.noguchi/Code/project2/file.js");
    });
  });

  describe("deriveProjectContextFromValues", () => {
    it("should derive context from a list of candidate values", () => {
      const values = [
        "some random log message",
        "working dir is /Users/y.noguchi/Code/my-cool-project",
      ];
      const result = deriveProjectContextFromValues(values);
      expect(result.projectName).toBe("my-cool-project");
      expect(result.projectRoot).toBe("/Users/y.noguchi/Code/my-cool-project");
    });
  });
});
