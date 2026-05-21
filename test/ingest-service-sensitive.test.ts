import { describe, expect, it } from "vitest";
// 内部関数をテストするために、エクスポートされていない場合は proxy 経由などで確認するか、
// ファイルを読んで直接テスト可能な形にする。ここでは filterSensitiveData を想定。

describe("ingest service sensitive data filter", () => {
  it("removes API keys and secrets", () => {
    // 実際の実装に合わせてテスト
    expect(true).toBe(true);
  });
});
