import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSgauthUrl } from "./sso-stub-url.mjs";

test("accepts http on localhost, *.localhost and loopback", () => {
  for (const url of [
    "http://auth.sga.localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    assert.equal(checkSgauthUrl(url), null, url);
  }
});

test("accepts https on any host", () => {
  assert.equal(checkSgauthUrl("https://auth-dev.northeasternsga.com"), null);
});

test("refuses http on a remote host", () => {
  for (const url of [
    "http://auth-dev.northeasternsga.com",
    "http://10.0.0.5:3000",
    "http://evil-localhost.example.com",
    "http://localhost.example.com",
  ]) {
    assert.match(checkSgauthUrl(url) ?? "", /must use https/, url);
  }
});

test("refuses a malformed or non-http URL", () => {
  assert.match(checkSgauthUrl("not a url") ?? "", /not a valid URL/);
  assert.match(checkSgauthUrl("ftp://localhost") ?? "", /http or https/);
});
