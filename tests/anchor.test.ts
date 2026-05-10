import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anchor,
  expandAnchor,
  looksLikeAnchor,
  ANCHOR_LEN,
  AnchorAmbiguityError,
} from "../src/anchor.js";

describe("anchor()", () => {
  it("returns the first 8 chars of an id", () => {
    assert.equal(anchor("a3f1c0d2-b1e2-4f3a-9c8d-1234567890ab"), "a3f1c0d2");
    assert.equal(ANCHOR_LEN, 8);
  });

  it("does not pad short ids", () => {
    assert.equal(anchor("abc"), "abc");
  });

  it("coerces non-strings safely", () => {
    assert.equal(anchor(123 as unknown as string), "123");
  });
});

describe("looksLikeAnchor()", () => {
  it("accepts 8-char hex", () => {
    assert.ok(looksLikeAnchor("a3f1c0d2"));
    assert.ok(looksLikeAnchor("01234567"));
  });

  it("accepts longer hex prefixes", () => {
    assert.ok(looksLikeAnchor("a3f1c0d2b1e2"));
  });

  it("rejects shorter or non-hex input", () => {
    assert.ok(!looksLikeAnchor("abc"));
    assert.ok(!looksLikeAnchor("a3f1c0d!"));
    assert.ok(!looksLikeAnchor("the dashboard from slack"));
  });
});

describe("expandAnchor()", () => {
  const ids = [
    "a3f1c0d2-b1e2-4f3a-9c8d-1234567890ab",
    "a3f10000-aaaa-bbbb-cccc-000000000000", // shares 4 chars with the first
    "7e9b4520-1111-2222-3333-444444444444",
    "0123abcd-ffff-eeee-dddd-cccccccccccc",
  ];

  it("returns the matching full id when prefix is unique", () => {
    assert.equal(expandAnchor("a3f1c0d2", ids), ids[0]);
    assert.equal(expandAnchor("7e9b4520", ids), ids[2]);
  });

  it("returns null when no candidate matches", () => {
    assert.equal(expandAnchor("ffffffff", ids), null);
  });

  it("returns null for a prefix shorter than 4 chars", () => {
    assert.equal(expandAnchor("abc", ids), null);
  });

  it("throws AnchorAmbiguityError when multiple candidates share the prefix", () => {
    assert.throws(
      () => expandAnchor("a3f1", ids),
      (err: Error) => err instanceof AnchorAmbiguityError && err.matches.length === 2
    );
  });

  it("is case-insensitive", () => {
    assert.equal(expandAnchor("A3F1C0D2", ids), ids[0]);
  });
});
