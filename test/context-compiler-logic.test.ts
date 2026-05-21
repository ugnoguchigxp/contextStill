import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  estimatedTokenWeight,
} from "../src/modules/context-compiler/context-compiler.service.js";

describe("ContextCompiler logic - Token Estimation Tests", () => {
  describe("estimatedTokenWeight", () => {
    it("assigns 0.15 weight to whitespace characters", () => {
      expect(estimatedTokenWeight(" ")).toBe(0.15);
      expect(estimatedTokenWeight("\t")).toBe(0.15);
      expect(estimatedTokenWeight("\n")).toBe(0.15);
    });

    it("assigns 0.25 weight to standard ASCII characters", () => {
      expect(estimatedTokenWeight("a")).toBe(0.25);
      expect(estimatedTokenWeight("z")).toBe(0.25);
      expect(estimatedTokenWeight("A")).toBe(0.25);
      expect(estimatedTokenWeight("1")).toBe(0.25);
      expect(estimatedTokenWeight("-")).toBe(0.25);
    });

    it("assigns 0.8 weight to CJK (Japanese/Chinese/Korean) characters", () => {
      expect(estimatedTokenWeight("あ")).toBe(0.8); // Hiragana
      expect(estimatedTokenWeight("ア")).toBe(0.8); // Katakana
      expect(estimatedTokenWeight("漢")).toBe(0.8); // Kanji
    });

    it("assigns 1.0 weight to astral code points / emojis", () => {
      expect(estimatedTokenWeight("🌟")).toBe(1.0);
    });

    it("returns 0 for empty or invalid character inputs", () => {
      expect(estimatedTokenWeight("")).toBe(0);
    });
  });

  describe("estimateTokens", () => {
    it("estimates basic english text and rounds up to nearest integer", () => {
      // "hello" -> 5 * 0.25 = 1.25 -> 2 tokens
      expect(estimateTokens("hello")).toBe(2);
    });

    it("estimates CJK texts correctly", () => {
      // "こんにちは" -> 5 * 0.8 = 4.0 -> 4 tokens
      expect(estimateTokens("こんにちは")).toBe(4);
    });

    it("estimates mixed texts and whitespaces correctly", () => {
      // "hello あ" -> "h","e","l","l","o"," ","あ" -> 5*0.25 + 0.15 + 0.8 = 2.2 -> 3 tokens
      expect(estimateTokens("hello あ")).toBe(3);
    });

    it("returns at least 1 token even for empty strings", () => {
      expect(estimateTokens("")).toBe(1);
    });
  });
});
