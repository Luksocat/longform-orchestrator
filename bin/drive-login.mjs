#!/usr/bin/env node
// One-time Google sign-in for the orchestrator's Drive gateway.
// Reads the OAuth Desktop client JSON, opens a loopback listener, prints the
// sign-in link and stores only the refresh token (owner-only file mode).
// Usage: node bin/drive-login.mjs [clientFile] [tokenFile]
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const dir = join(homedir(), ".config", "longform-drive");
const clientFile = process.argv[2] ?? join(dir, "client.json");
const tokenFile = process.argv[3] ?? join(dir, "token.json");
const client = JSON.parse(readFileSync(clientFile, "utf8"));
const key = client.installed;
if (!key?.client_id)
  throw new Error("Expected a Desktop app OAuth client JSON (an \"installed\" key)");

const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");
const server = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const redirect = `http://127.0.0.1:${server.address().port}`;
const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
for (const [k, v] of Object.entries({
  client_id: key.client_id,
  redirect_uri: redirect,
  response_type: "code",
  scope: "https://www.googleapis.com/auth/drive",
  access_type: "offline",
  prompt: "consent",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
}))
  url.searchParams.set(k, v);
console.log("Open this link in a browser on this computer and sign in:\n\n" + url + "\n");

const code = await new Promise((resolve, reject) => {
  server.on("request", (req, res) => {
    const got = new URL(req.url, redirect);
    if (got.searchParams.get("state") !== state) {
      res.end("Wrong sign-in attempt; close this tab.");
      return;
    }
    const error = got.searchParams.get("error");
    res.end(error ? "Sign-in failed: " + error : "Signed in. You can close this tab.");
    server.close();
    error ? reject(new Error(error)) : resolve(got.searchParams.get("code"));
  });
});
const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  body: new URLSearchParams({
    client_id: key.client_id,
    client_secret: key.client_secret ?? "",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    grant_type: "authorization_code",
  }),
});
const body = await response.json();
if (!response.ok || !body.refresh_token)
  throw new Error("Token exchange failed: " + (body.error ?? response.status));
mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
const temporary = tokenFile + ".new";
writeFileSync(
  temporary,
  JSON.stringify({ refresh_token: body.refresh_token, scope: body.scope, obtainedAt: new Date().toISOString() }, null, 2) + "\n",
  { mode: 0o600 },
);
renameSync(temporary, tokenFile);
console.log("Saved the Drive login to " + tokenFile);
