// src/portal/__tests__/connection-type.test.ts
// Unit tests for the connection-type chip derivation (1.3):
// notion_pat:* -> "pat", notion_access*/notion_refresh* -> "oauth".
import { test } from "node:test";
import assert from "node:assert/strict";

import { connectionTypeFromKind, connectionTypeLabel } from "../connection-type.js";

test('notion_pat:<id> yields "pat"', () => {
  assert.equal(connectionTypeFromKind("notion_pat:abc123"), "pat");
});

test('notion_pat:<uuid> yields "pat"', () => {
  assert.equal(connectionTypeFromKind("notion_pat:00000000-0000-0000-0000-000000000000"), "pat");
});

test('notion_access:<ws> yields "oauth"', () => {
  assert.equal(connectionTypeFromKind("notion_access:ws-id"), "oauth");
});

test('notion_refresh:<ws> yields "oauth"', () => {
  assert.equal(connectionTypeFromKind("notion_refresh:ws-id"), "oauth");
});

test('unknown kind yields null', () => {
  assert.equal(connectionTypeFromKind("granola"), null);
  assert.equal(connectionTypeFromKind("ical"), null);
  assert.equal(connectionTypeFromKind(""), null);
});

test('label: pat -> "Token (PAT)"', () => {
  assert.equal(connectionTypeLabel("pat"), "Token (PAT)");
});

test('label: oauth -> "OAuth"', () => {
  assert.equal(connectionTypeLabel("oauth"), "OAuth");
});

test('label: null -> null', () => {
  assert.equal(connectionTypeLabel(null), null);
});
