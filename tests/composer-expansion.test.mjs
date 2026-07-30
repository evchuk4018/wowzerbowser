import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerStyles = await readFile(new URL("../app/styles/composer.css", import.meta.url), "utf8");

test("expanded composer stays anchored to the chat column and grows upward", () => {
  assert.match(
    composerStyles,
    /\.composer-wrap--expanded\s*\{[^}]*left:\s*300px;[^}]*align-items:\s*end;[^}]*justify-items:\s*center;/s,
  );
  assert.match(
    composerStyles,
    /\.chat-active \.composer-wrap--expanded\s*\{[^}]*left:\s*300px;[^}]*width:\s*auto;/s,
  );
  assert.match(
    composerStyles,
    /\.composer--expanded\s*\{[^}]*width:\s*min\(100%, 860px\);[^}]*height:\s*min\(560px, 60dvh\);/s,
  );
});
