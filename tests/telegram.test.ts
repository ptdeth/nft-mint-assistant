import assert from "node:assert/strict";
import test from "node:test";

import {
  containsSecretLikeText,
  isAllowedUser,
  parseAllowedUserIds,
  redactSecrets,
  resolveConfigPath
} from "../src/telegram/bot.js";

test("telegram allowed user parser accepts comma-separated numeric IDs", () => {
  assert.deepEqual(Array.from(parseAllowedUserIds("123, 456")).sort(), [123, 456]);
});

test("telegram authorization refuses users outside allowlist", () => {
  const allowed = parseAllowedUserIds("123");

  assert.equal(isAllowedUser(123, allowed), true);
  assert.equal(isAllowedUser(456, allowed), false);
  assert.equal(isAllowedUser(undefined, allowed), false);
});

test("telegram secret detector catches private keys and secret wording", () => {
  assert.equal(containsSecretLikeText("0x59c6995e998f97a5a004497e5da55188adc4c0f8cfddebd7e89cb8a4b77690ef"), true);
  assert.equal(containsSecretLikeText("my private key is here"), true);
  assert.equal(containsSecretLikeText("/analyze https://example.com"), false);
});

test("telegram redaction removes private-key-like material", () => {
  const redacted = redactSecrets("key 0x59c6995e998f97a5a004497e5da55188adc4c0f8cfddebd7e89cb8a4b77690ef");

  assert.equal(redacted.includes("59c6995e"), false);
  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
});

test("telegram config path resolver blocks traversal", () => {
  assert.throws(() => resolveConfigPath("../.env"), /Invalid config name/);
  assert.match(resolveConfigPath("example.base"), /mints[\\/]+example\.base\.json$/);
});
