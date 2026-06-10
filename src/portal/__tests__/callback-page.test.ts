// src/portal/__tests__/callback-page.test.ts
// 1.1 — Unit tests for the OAuth callback result page builder.
// Verifies the HTML structure, escape behavior, and success/error variants.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSuccessPage,
  buildErrorPage,
} from "../callback-page.js";

test("buildSuccessPage includes escaped account name in output", () => {
  const html = buildSuccessPage("google", "user@example.com");
  assert.ok(html.includes("user@example.com"), "should include email");
  assert.ok(html.includes("Google"), "should mention Google");
  assert.ok(html.includes("Pode fechar"), "should tell user to close tab");
  assert.ok(html.includes("status-icon ok"), "should have success icon container");
});

test("buildSuccessPage escapes HTML in account name", () => {
  const malicious = '<script>alert(1)</script>';
  const html = buildSuccessPage("google", malicious);
  assert.ok(!html.includes("<script>"), "must not contain raw <script>");
  assert.ok(html.includes("&lt;script&gt;"), "must escape the tag");
});

test("buildSuccessPage for Notion includes workspace name", () => {
  const html = buildSuccessPage("notion", "Cérebro do Bruno");
  assert.ok(html.includes("Cérebro do Bruno"), "should include workspace name");
  assert.ok(html.includes("Notion"), "should mention Notion");
});

test("buildSuccessPage includes Geist font CDN link", () => {
  const html = buildSuccessPage("google", "user@example.com");
  assert.ok(html.includes("cdn.jsdelivr.net") || html.includes("fonts.googleapis.com") || html.includes("Geist"), "should reference Geist font");
});

test("buildSuccessPage includes green accent color", () => {
  const html = buildSuccessPage("google", "user@example.com");
  assert.ok(html.includes("#1f8b4c"), "should use green accent color");
});

test("buildSuccessPage includes Zinom logo SVG", () => {
  const html = buildSuccessPage("google", "user@example.com");
  // The logo SVG has rect + path elements
  assert.ok(html.includes("<svg") && html.includes("</svg>"), "should include SVG logo");
});

test("buildErrorPage includes error reason (escaped) and retry link", () => {
  const html = buildErrorPage("google", "access_denied", "/portal/google/connect");
  assert.ok(html.includes("status-icon err"), "should have error icon container");
  assert.ok(html.includes("access_denied"), "should include reason");
  assert.ok(html.includes("/portal/google/connect"), "should include retry link");
});

test("buildErrorPage escapes HTML in reason", () => {
  const html = buildErrorPage("notion", "<img src=x onerror=alert(1)>", "/notion/connect");
  assert.ok(!html.includes("<img"), "must not contain raw <img>");
  assert.ok(html.includes("&lt;img"), "must escape the tag");
});

test("buildErrorPage for Google links back to Google connect", () => {
  const html = buildErrorPage("google", "access_denied", "/portal/google/connect");
  assert.ok(html.includes("/portal/google/connect"), "retry link for Google");
});

test("buildErrorPage for Notion links back to Notion connect", () => {
  const html = buildErrorPage("notion", "error", "/portal/notion/connect");
  assert.ok(html.includes("/portal/notion/connect"), "retry link for Notion");
});
