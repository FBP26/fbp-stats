import assert from "node:assert/strict";
import test from "node:test";

import { isLoopbackOrigin, requestCorsOrigin } from "../src/index.ts";

const publicOrigin = "https://fbp26.github.io";

test("loopback origins are accepted only for local HTTP previews", () => {
  for (const origin of ["http://127.0.0.1:8830", "http://localhost:8765", "http://[::1]:8830"]) {
    assert.equal(isLoopbackOrigin(origin), true);
  }
  for (const origin of ["https://127.0.0.1:8830", "http://127.0.0.1.example", "https://fbp26.github.io"]) {
    assert.equal(isLoopbackOrigin(origin), false);
  }
});

test("only loopback GET requests receive a loopback CORS header", () => {
  const localRead = new Request("https://fbp-api.fbp-api-worker.workers.dev/?action=current-week", {
    headers: { Origin: "http://127.0.0.1:8830" },
  });
  const localWrite = new Request("https://fbp-api.fbp-api-worker.workers.dev/", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8830" },
  });
  const externalRead = new Request("https://fbp-api.fbp-api-worker.workers.dev/?action=current-week", {
    headers: { Origin: "https://example.test" },
  });
  assert.equal(requestCorsOrigin(localRead, publicOrigin), "http://127.0.0.1:8830");
  assert.equal(requestCorsOrigin(localWrite, publicOrigin), publicOrigin);
  assert.equal(requestCorsOrigin(externalRead, publicOrigin), publicOrigin);
});