import test from "node:test";
import assert from "node:assert/strict";
import { namespaceConnectorTool, MANAGED_CONNECTOR_MANIFESTS } from "../app/server/connectors/connector-registry.ts";
import { assertSafeMcpUrl, McpClient } from "../app/server/connectors/mcp/mcp-client.ts";
import { discoveredMcpTools } from "../app/server/connectors/mcp/mcp-tool-discovery.ts";
import { normalizeMcpResult } from "../app/server/connectors/mcp/mcp-result-normalizer.ts";
import { redactConnectorError, redactConnectorValue } from "../app/server/connectors/connector-redaction.ts";
import { GoogleGmailProvider } from "../app/server/connectors/providers/google-gmail-provider.ts";
import { MicrosoftOutlookProvider } from "../app/server/connectors/providers/microsoft-outlook-provider.ts";
import { classifyLocalDriveToolAccess, LocalDriveProvider } from "../app/server/connectors/providers/local-drive-provider.ts";
import { requiresConnectorApproval } from "../app/server/connectors/connector-policy.ts";
import { exchangeMicrosoftOutlookCode, microsoftOutlookAuthorizationUrl, refreshMicrosoftOutlookAccessToken } from "../app/server/connectors/providers/microsoft-outlook-oauth.ts";
import { outlookGetMessage, outlookSearch, MicrosoftOutlookAuthorizationError } from "../app/server/connectors/providers/microsoft-outlook-adapter.ts";
import { isToolsConnector } from "../app/settings/connector-placement.ts";

test("managed connector registry exposes the initial catalog", () => {
  assert.deepEqual(MANAGED_CONNECTOR_MANIFESTS.map(({ id }) => id), ["gmail", "outlook", "google_drive", "notion", "slack", "local_drive"]);
  assert.equal(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "gmail").provider, "google_gmail");
  assert.deepEqual(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "gmail").capabilities, ["search", "read"]);
  assert.equal(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "outlook").provider, "microsoft_outlook");
  assert.deepEqual(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "outlook").capabilities, ["search", "read"]);
  assert.equal(MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "local_drive").provider, "local_drive");
});

test("Local Drive classifies every expected operation with the normal approval tier", async () => {
  assert.deepEqual([
    classifyLocalDriveToolAccess("drive_list", ""),
    classifyLocalDriveToolAccess("drive_search", ""),
    classifyLocalDriveToolAccess("drive_get_metadata", ""),
    classifyLocalDriveToolAccess("drive_read_text", ""),
    classifyLocalDriveToolAccess("drive_write_file", ""),
    classifyLocalDriveToolAccess("drive_create_folder", ""),
    classifyLocalDriveToolAccess("drive_rename_item", ""),
    classifyLocalDriveToolAccess("drive_move_item", ""),
    classifyLocalDriveToolAccess("drive_trash_item", ""),
    classifyLocalDriveToolAccess("drive_restore_item", ""),
    classifyLocalDriveToolAccess("drive_delete_permanently", ""),
  ], ["read", "read", "read", "read", "write", "write", "write", "write", "destructive", "destructive", "destructive"]);
  assert.equal(await requiresConnectorApproval("owner", MANAGED_CONNECTOR_MANIFESTS.find(({ id }) => id === "local_drive"), "drive_delete_permanently", "destructive"), true);
});

test("email connectors are placed in Tools", () => {
  assert.equal(isToolsConnector({ id: "gmail" }), true);
  assert.equal(isToolsConnector({ id: "outlook" }), true);
  assert.equal(isToolsConnector({ id: "google_drive" }), false);
  assert.equal(isToolsConnector({ id: "mcp_demo" }), false);
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

test("Outlook exposes only read-only email tools", async () => {
  const tools = await new MicrosoftOutlookProvider().listTools();
  assert.deepEqual(tools.map(({ name }) => name), ["search_emails", "search_email_ids", "read_email", "batch_read_email"]);
  assert.equal(tools.every(({ access }) => access === "read"), true);
  assert.equal(tools.some(({ name }) => /send|draft|label|archive|delete|trash/i.test(name)), false);
});

test("Microsoft Outlook OAuth uses the common tenant and read-only mail scopes", () => {
  const previous = {
    clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    tenant: process.env.MICROSOFT_OAUTH_TENANT,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  };
  process.env.MICROSOFT_OAUTH_CLIENT_ID = "client-id";
  delete process.env.MICROSOFT_OAUTH_TENANT;
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  try {
    const url = new URL(microsoftOutlookAuthorizationUrl("state-value"));
    assert.equal(url.hostname, "login.microsoftonline.com");
    assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/api/connectors/callback");
    assert.equal(url.searchParams.get("state"), "state-value");
    assert.match(url.searchParams.get("scope"), /Mail\.Read/);
    assert.match(url.searchParams.get("scope"), /offline_access/);
  } finally {
    if (previous.clientId === undefined) delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    else process.env.MICROSOFT_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.tenant === undefined) delete process.env.MICROSOFT_OAUTH_TENANT;
    else process.env.MICROSOFT_OAUTH_TENANT = previous.tenant;
    if (previous.siteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous.siteUrl;
  }
});

test("Microsoft Outlook OAuth exchanges authorization and refresh tokens", async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    tenant: process.env.MICROSOFT_OAUTH_TENANT,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  };
  const requests = [];
  process.env.MICROSOFT_OAUTH_CLIENT_ID = "client-id";
  process.env.MICROSOFT_OAUTH_CLIENT_SECRET = "client-secret";
  delete process.env.MICROSOFT_OAUTH_TENANT;
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), body: String(init.body) });
    return new Response(JSON.stringify(requests.length === 1
      ? { access_token: "access-token", refresh_token: "refresh-token", scope: "Mail.Read User.Read" }
      : { access_token: "refreshed-access-token" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await exchangeMicrosoftOutlookCode("authorization-code"), { accessToken: "access-token", refreshToken: "refresh-token", scope: "Mail.Read User.Read" });
    assert.equal(await refreshMicrosoftOutlookAccessToken("refresh-token"), "refreshed-access-token");
    assert.equal(requests[0].input, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    assert.match(requests[0].body, /grant_type=authorization_code/);
    assert.match(requests[1].body, /grant_type=refresh_token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.clientId === undefined) delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    else process.env.MICROSOFT_OAUTH_CLIENT_ID = previous.clientId;
    if (previous.clientSecret === undefined) delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    else process.env.MICROSOFT_OAUTH_CLIENT_SECRET = previous.clientSecret;
    if (previous.tenant === undefined) delete process.env.MICROSOFT_OAUTH_TENANT;
    else process.env.MICROSOFT_OAUTH_TENANT = previous.tenant;
    if (previous.siteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous.siteUrl;
  }
});

test("Outlook Graph adapter searches, follows opaque next links, and reads messages", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname.endsWith("/messages")) {
      return new Response(JSON.stringify({
        value: [{ id: "message-1", conversationId: "conversation-1", subject: "Invoice", from: { emailAddress: { name: "Sender", address: "sender@example.test" } }, toRecipients: [{ emailAddress: { address: "owner@example.test" } }], receivedDateTime: "2026-08-08T12:00:00Z", bodyPreview: "Please review", hasAttachments: true, isRead: false }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque-token",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "message-1", conversationId: "conversation-1", subject: "Invoice", from: { emailAddress: { name: "Sender", address: "sender@example.test" } }, bodyPreview: "Please review", body: { contentType: "text", content: "Full message" }, hasAttachments: true, attachments: [{ id: "attachment-1", name: "invoice.pdf", contentType: "application/pdf", size: 1234, isInline: false }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const search = await outlookSearch("access-token", { query: "invoice", maxResults: 10 });
    assert.equal(search.messages[0].from, "Sender <sender@example.test>");
    assert.deepEqual(search.messages[0].to, ["owner@example.test"]);
    assert.equal(search.nextPageToken, "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque-token");
    assert.equal(new URL(requests[0].url).searchParams.get("$search"), '"invoice"');
    const read = await outlookGetMessage("access-token", "message-1");
    assert.equal(read.body, "Full message");
    assert.deepEqual(read.attachments, [{ id: "attachment-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 1234, isInline: false }]);
    assert.match(requests[1].init.headers.prefer, /body-content-type/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Outlook Graph adapter classifies authorization failures as reconnects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
  try {
    await assert.rejects(() => outlookSearch("access-token", { query: "invoice" }), MicrosoftOutlookAuthorizationError);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.equal(calls[1].body.id, undefined);
  assert.equal(calls[1].body.method, "notifications/initialized");
});

test("Local Drive MCP provider discovers and executes drive_list with auth on every request", async () => {
  const previous = process.env.LOCAL_DRIVE_API_TOKEN;
  process.env.LOCAL_DRIVE_API_TOKEN = "local-drive-test-token";
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, headers: new Headers(init.headers) });
    const headers = new Headers({ "content-type": "application/json" });
    if (body.method === "initialize") {
      headers.set("mcp-session-id", "local-drive-session");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { status: 200, headers });
    }
    if (body.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
      tools: [
        { name: "drive_list", description: "List", inputSchema: { type: "object", properties: { folderId: { type: "string" } } } },
        { name: "drive_search", description: "Search", inputSchema: { type: "object" } },
        { name: "drive_get_metadata", description: "Metadata", inputSchema: { type: "object" } },
        { name: "drive_read_text", description: "Read", inputSchema: { type: "object" } },
        { name: "drive_write_file", description: "Write", inputSchema: { type: "object" } },
        { name: "drive_create_folder", description: "Create", inputSchema: { type: "object" } },
        { name: "drive_rename_item", description: "Rename", inputSchema: { type: "object" } },
        { name: "drive_move_item", description: "Move", inputSchema: { type: "object" } },
        { name: "drive_trash_item", description: "Trash", inputSchema: { type: "object" } },
        { name: "drive_restore_item", description: "Restore", inputSchema: { type: "object" } },
        { name: "drive_delete_permanently", description: "Delete", inputSchema: { type: "object" } },
      ],
    } }), { status: 200, headers });
    if (body.method === "tools/call") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { items: [], folderId: body.params.arguments.folderId, echoed: "Bearer local-drive-test-token" } } }), { status: 200, headers });
    return new Response("", { status: 202, headers });
  };
  try {
    const provider = new LocalDriveProvider(fetchImpl);
    const tools = await provider.listTools({ ownerId: "owner", connectorId: "local_drive" });
    assert.deepEqual(tools.map(({ name }) => name), ["drive_list", "drive_search", "drive_get_metadata", "drive_read_text", "drive_write_file", "drive_create_folder", "drive_rename_item", "drive_move_item", "drive_trash_item", "drive_restore_item", "drive_delete_permanently"]);
    assert.equal(tools.find(({ name }) => name === "drive_list").description, "List files and folders in a Local Drive folder.");
    assert.equal(tools.find(({ name }) => name === "drive_delete_permanently").access, "destructive");
    const result = await provider.callTool({ ownerId: "owner", connectorId: "local_drive", tool: tools[0], arguments: { folderId: "root" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { items: [], folderId: "root", echoed: "Bearer [redacted]" });
    assert.equal(requests.filter(({ body }) => body.method === "initialize").length, 2);
    assert.equal(requests.filter(({ body }) => body.method === "notifications/initialized").length, 2);
    assert.equal(requests.filter(({ body }) => body.method === "tools/list").length, 1);
    assert.equal(requests.filter(({ body }) => body.method === "tools/call").length, 1);
    assert.equal(requests.every(({ headers }) => headers.get("authorization") === "Bearer local-drive-test-token"), true);
    assert.equal(requests.filter(({ body }) => body.method === "notifications/initialized")[0].body?.id, undefined);
    assert.doesNotMatch(JSON.stringify(result), /local-drive-test-token/);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_DRIVE_API_TOKEN;
    else process.env.LOCAL_DRIVE_API_TOKEN = previous;
  }
});

test("MCP client maps timeout, authentication, authorization, server, and connectivity failures", async () => {
  const cases = [
    [401, /authentication failed/],
    [403, /authorization was denied/],
    [500, /server error/],
  ];
  for (const [status, message] of cases) {
    const client = new McpClient("https://example.com/mcp", {}, async () => new Response("", { status }));
    await assert.rejects(() => client.listTools(), message);
  }
  const timeoutClient = new McpClient("https://example.com/mcp", {}, async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), { timeoutMs: 10 });
  await assert.rejects(() => timeoutClient.listTools(), /timed out/);
  const connectivityClient = new McpClient("https://example.com/mcp", {}, async () => { throw new Error("offline"); });
  await assert.rejects(() => connectivityClient.listTools(), /Could not connect/);
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
