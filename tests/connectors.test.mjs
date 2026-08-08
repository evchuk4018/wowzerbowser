import test from "node:test";
import assert from "node:assert/strict";
import { namespaceConnectorTool, MANAGED_CONNECTOR_MANIFESTS } from "../app/server/connectors/connector-registry.ts";
import { assertSafeMcpUrl, McpClient } from "../app/server/connectors/mcp/mcp-client.ts";
import { discoveredMcpTools } from "../app/server/connectors/mcp/mcp-tool-discovery.ts";
import { normalizeMcpResult } from "../app/server/connectors/mcp/mcp-result-normalizer.ts";
import { redactConnectorError, redactConnectorValue } from "../app/server/connectors/connector-redaction.ts";
import { GoogleGmailProvider } from "../app/server/connectors/providers/google-gmail-provider.ts";

test("managed connector registry exposes the initial catalog", () => {
  assert.deepEqual(MANAGED_CONNECTOR_MANIFESTS.map(({ id }) => id), ["gmail", "google_drive", "notion", "slack"]);
  assert.equal(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "gmail").provider, "google_gmail");
  assert.deepEqual(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "gmail").capabilities, ["search", "read"]);
});

test("connector tool namespacing prevents collisions", () => {
  assert.equal(namespaceConnectorTool("gmail", "search_messages"), "connector__gmail__search_messages");
  assert.notEqual(namespaceConnectorTool("gmail", "search_messages"), namespaceConnectorTool("slack", "search_messages"));
});

test("Gmail exposes only read-only tools", async () => {
  const tools = await new GoogleGmailProvider().listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["search_emails", "search_email_ids", "read_email_thread", "batch_read_email"]);
  assert.equal(tools.every(({ access }) => access === "read"), true);
  assert.equal(tools.some(({ name }) => /send|draft|label|archive|delete|trash/i.test(name)), false);
});

test("MCP discovery classifies read, write, and destructive actions", () => {
  const tools = discoveredMcpTools("mcp_demo", "1.0.0", [
    { name: "search_pages", description: "Search pages" },
    { name: "create_page", description: "Create a page" },
    { name: "delete_page", description: "Delete a page" },
  ]);
  assert.deepEqual(tools.map(({ access }) => access), ["read", "write", "destructive"]);
  assert.equal(tools[1].namespacedName, "connector__mcp_demo__create_page");
});

test("MCP URLs reject non-HTTPS and private targets", () => {
  assert.throws(() => assertSafeMcpUrl("http://example.com/mcp"), /HTTPS/);
  assert.throws(() => assertSafeMcpUrl("https://127.0.0.1/mcp"), /private|local/i);
  assert.equal(assertSafeMcpUrl("https://example.com/mcp"), "https://example.com/mcp");
});

test("MCP client initializes, caches session, lists, and calls tools", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, headers: init.headers });
    const headers = new Headers({ "content-type": "application/json" });
    if (body.method === "initialize") {
      headers.set("mcp-session-id", "session-1");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers });
    }
    if (body.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] } }), { status: 200, headers });
    if (body.method === "tools/call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { answer: "ok" } } }), { status: 200, headers });
    return new Response("", { status: 202, headers });
  };
  const client = new McpClient("https://example.com/mcp", { token: "secret-token" }, fetchImpl);
  await client.initialize();
  assert.equal((await client.listTools())[0].name, "search");
  assert.deepEqual(await client.callTool("search", { query: "hello" }), { structuredContent: { answer: "ok" } });
  assert.equal(calls[1].headers["mcp-session-id"], "session-1");
  assert.equal(calls[1].headers.authorization, "Bearer secret-token");
});

test("MCP results and errors redact secrets", () => {
  const result = normalizeMcpResult({ structuredContent: { authorization: "Bearer secret-token", value: "safe" } });
  assert.equal(result.ok, true);
  assert.equal(result.output.authorization, "[redacted]");
  assert.equal(redactConnectorValue({ access_token: "secret", value: "safe" }).access_token, "[redacted]");
  assert.doesNotMatch(redactConnectorError(new Error("authorization: secret-token")), /secret-token/);
});

test("connector credentials and integration metadata use server-side encryption", async () => {
  const previous = process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY;
  process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const {
      decryptConnectorCredentials,
      decryptConnectorMetadata,
      encryptConnectorCredentials,
      encryptConnectorMetadata,
    } = await import("../app/server/connectors/connector-crypto.ts");
    const credentials = encryptConnectorCredentials({ access_token: "credential-secret" });
    const metadata = encryptConnectorMetadata({ accountId: "account-123", providerSecret: "metadata-secret" });
    assert.doesNotMatch(credentials.ciphertext, /credential-secret/);
    assert.doesNotMatch(metadata.ciphertext, /metadata-secret/);
    assert.deepEqual(decryptConnectorCredentials({
      credentials_ciphertext: credentials.ciphertext,
      credentials_nonce: credentials.nonce,
      credentials_auth_tag: credentials.authTag,
    }), { access_token: "credential-secret" });
    assert.deepEqual(decryptConnectorMetadata({
      metadata_ciphertext: metadata.ciphertext,
      metadata_nonce: metadata.nonce,
      metadata_auth_tag: metadata.authTag,
    }), { accountId: "account-123", providerSecret: "metadata-secret" });
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CONNECTOR_CREDENTIAL_ENCRYPTION_KEY = previous;
  }
});
