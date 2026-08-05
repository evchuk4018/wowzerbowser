import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MOBILE_HISTORY_HORIZONTAL_INTENT_PX,
  MobileHistorySwipeGesture,
  getMobileHistorySwipeAction,
} from "../app/chat/mobile-history-swipe.ts";
import { parseChatRequest } from "../lib/chat-protocol.ts";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const stylesheetPaths = [
  "../app/globals.css",
  "../app/styles/tokens.css",
  "../app/styles/base.css",
  "../app/styles/auth.css",
  "../app/styles/app-shell.css",
  "../app/styles/sidebar.css",
  "../app/styles/settings.css",
  "../app/styles/transcript.css",
  "../app/styles/assistant-markdown.css",
  "../app/styles/message-actions.css",
  "../app/styles/reasoning.css",
  "../app/styles/assistant-activity.css",
  "../app/styles/artifacts.css",
  "../app/styles/pdf-preview.css",
  "../app/styles/composer.css",
  "../app/styles/chat-search.css",
  "../app/styles/responsive.css",
  "../app/styles/reduced-motion.css",
];

async function readStyles() {
  const styles = await Promise.all(
    stylesheetPaths.map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  return styles.join("\n");
}

function extractCssBlock(source, selector) {
  const selectorIndex = source.indexOf(selector);
  if (selectorIndex === -1) {
    return null;
  }

  const openingBraceIndex = source.indexOf("{", selectorIndex);
  if (openingBraceIndex === -1) {
    return null;
  }

  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(selectorIndex, index + 1);
      }
    }
  }

  return null;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("loads feature stylesheets in deterministic cascade order", async () => {
  const [layout, globals] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const imports = stylesheetPaths.map((path) => `./${path.replace("../app/", "")}`);
  let previousIndex = -1;
  for (const stylesheet of imports) {
    const index = layout.indexOf(`import "${stylesheet}"`);
    assert.notEqual(index, -1, `${stylesheet} should be imported by the root layout`);
    assert.ok(index > previousIndex, `${stylesheet} should preserve the declared cascade order`);
    previousIndex = index;
  }

  assert.match(globals, /^@import "tailwindcss";/);
  assert.doesNotMatch(globals, /(?:^|\n)\s*[^/@\s][^\n]*\{/);
});

async function assertPngRoute(path, width, height) {
  const response = await fetch(`http://127.0.0.1:43123${path}`);
  assert.equal(response.status, 200, `${path} should be served`);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png\b/i);

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(
    [...bytes.slice(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${path} should have a PNG signature`,
  );
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(header.getUint32(16), width, `${path} should be ${width}px wide`);
  assert.equal(header.getUint32(20), height, `${path} should be ${height}px tall`);
}

async function withNextServer(callback) {
  const port = 43123;
  const server = spawn(process.execPath, [nextCli, "start", "-p", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) {
        throw new Error(`Next server exited before becoming ready:\n${serverOutput}`);
      }
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await delay(100);
      }
    }
    if (!response) {
      throw new Error(`Next server did not become ready:\n${serverOutput}`);
    }
    return await callback(response);
  } finally {
    server.kill();
  }
}

test("server renders the local auth-aware app shell", async () => {
  await withNextServer(async (response) => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(html, /<title>Chat<\/title>/i);
    assert.match(html, /id="sign-in-title"/);
    assert.match(html, /name="password"/);
  });
});

test("renders mobile home-screen metadata and serves the manifest", async () => {
  await withNextServer(async (response) => {
    const html = await response.text();
    const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
    const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
    const hasMeta = (name, content) => metaTags.some((tag) =>
      new RegExp(`\\bname="${name}"`, "i").test(tag)
      && new RegExp(`\\bcontent="${content}"`, "i").test(tag));
    const manifestLink = linkTags.find((tag) =>
      /\brel="manifest"/i.test(tag) && /\bhref="\/manifest\.webmanifest"/i.test(tag));

    assert.ok(hasMeta("application-name", "Chat"));
    assert.ok(manifestLink);
    assert.ok(hasMeta("mobile-web-app-capable", "yes"));
    assert.ok(hasMeta("apple-mobile-web-app-title", "Chat"));
    assert.ok(hasMeta("apple-mobile-web-app-status-bar-style", "black-translucent"));
    assert.ok(hasMeta("theme-color", "#d4ff70"));
    const viewportTag = metaTags.find((tag) => /\bname="viewport"/i.test(tag));
    assert.ok(viewportTag);
    assert.match(viewportTag, /content="[^"]*width=device-width[^"]*initial-scale=1[^"]*maximum-scale=1[^"]*user-scalable=no[^"]*viewport-fit=cover[^"]*interactive-widget=resizes-content/i);
    assert.ok(hasMeta("color-scheme", "dark"));

    const manifestResponse = await fetch("http://127.0.0.1:43123/manifest.webmanifest");
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type") ?? "", /application\/manifest\+json/i);
    const manifest = await manifestResponse.json();
    assert.deepEqual(manifest, {
      name: "Chat",
      short_name: "Chat",
      description: "A simple, private chat workspace.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#181918",
      theme_color: "#d4ff70",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });

    for (const [path, width, height] of [
      ["/icons/icon-192.png", 192, 192],
      ["/icons/icon-512.png", 512, 512],
      ["/icons/icon-maskable-512.png", 512, 512],
      ["/icon.png", 512, 512],
      ["/apple-icon.png", 180, 180],
    ]) {
      await assertPngRoute(path, width, height);
    }

    const serviceWorkerResponse = await fetch("http://127.0.0.1:43123/sw.js");
    assert.equal(serviceWorkerResponse.status, 200);
    assert.match(serviceWorkerResponse.headers.get("content-type") ?? "", /javascript/i);
    const serviceWorker = await serviceWorkerResponse.text();
    assert.match(serviceWorker, /addEventListener\("install"/);
    assert.match(serviceWorker, /addEventListener\("activate"/);
    assert.doesNotMatch(serviceWorker, /cache|fetch|respondWith|offline|\/api\//i);
  });
});

test("keeps PWA icon references and service worker behavior safe", async () => {
  const [layout, manifestSource, registration, serviceWorker, styles] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/pwa/service-worker-registration.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readStyles(),
  ]);

  for (const icon of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png"]) {
    assert.match(manifestSource, new RegExp(icon.replaceAll("/", "\\/")));
  }
  assert.match(layout, /ServiceWorkerRegistration/);
  assert.match(registration, /"use client"/);
  assert.match(registration, /process\.env\.NODE_ENV !== "production"/);
  assert.match(registration, /"serviceWorker" in navigator/);
  assert.match(registration, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(registration, /\.catch\(\(\) =>/);
  assert.match(serviceWorker, /addEventListener\("install"/);
  assert.match(serviceWorker, /addEventListener\("activate"/);
  assert.doesNotMatch(serviceWorker, /cache|fetch|respondWith|offline|\/api\//i);
  assert.doesNotMatch(serviceWorker, /addEventListener\("fetch"/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /env\(safe-area-inset-right\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /env\(safe-area-inset-left\)/);
  assert.match(styles, /\.auth-form input[\s\S]*?font-size: 16px;/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.settings-field textarea \{[\s\S]*?font-size: 16px;/);
  assert.match(styles, /\.composer textarea[\s\S]*?font-size: 16px;/);
  assert.match(styles, /min-height: 100dvh;/);
  assert.match(styles, /height: 100dvh;/);
});

test("keeps Auth.js credentials and local object storage separate", async () => {
  const [page, authConfig, authRoute, ownerService, authService, authForm, storageAdapter, storageRuntime] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/[...nextauth]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/login-form.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/server/storage/local-filesystem-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/local-filesystem-storage.mjs", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /@supabase\/supabase-js|createClient\(/);
  assert.match(authConfig, /Credentials/);
  assert.match(authConfig, /strategy: "jwt"/);
  assert.match(authConfig, /trustHost: true/);
  assert.match(authConfig, /sessionVersion/);
  assert.match(authRoute, /handlers/);
  assert.match(ownerService, /ownerForSession/);
  assert.match(ownerService, /NEXT_PUBLIC_SITE_URL/);
  assert.match(authService, /authSignIn\("credentials"/);
  assert.doesNotMatch(authService, /supabase|magic|signUp/i);
  assert.match(authForm, /Password/);
  assert.doesNotMatch(authForm, /Create password account|magic link|signUp/i);
  assert.match(storageAdapter + "\n" + storageRuntime, /atomic|rename/);
  assert.doesNotMatch(storageAdapter + "\n" + storageRuntime, /supabase|storage\.from|signed.?url/i);
});

test("renders a non-blocking startup shell before remote chat bootstrap", async () => {
  const [page, shell, workspace, composer] = await Promise.all([
    readFile(new URL("../app/chat/chat-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-startup-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-composer.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<ChatStartupShell/);
  assert.doesNotMatch(page, /className="loading-shell"/);
  assert.match(shell, /startup-shell/);
  assert.doesNotMatch(shell, /ChatTranscript|react-markdown|KaTeX|SettingsModal|ChatSearchDialog|PdfPreview|attachment/i);
  assert.doesNotMatch(workspace, /if \(!ready \|\| !active\) return <main className="loading-shell"/);
  assert.match(workspace, /startupPending=\{startupPending\}/);
  assert.match(composer, /startupPending\?: boolean/);
  assert.match(composer, /Restoring chat/);
});

test("collapses authenticated chat startup into one bootstrap request", async () => {
  const [authService, page, workspace, preferences, client] = await Promise.all([
    readFile(new URL("../app/auth/auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/use-chat-preferences.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-service.ts", import.meta.url), "utf8"),
  ]);

  assert.match(authService, /\/api\/auth\/session/);
  assert.match(authService, /body\?\.user/);
  assert.match(client, /fetchChatBootstrap/);
  assert.match(workspace, /fetchChatBootstrap\(initialConversationIdRef\.current\)/);
  assert.doesNotMatch(workspace, /loadConversationIndex\(|loadSettings\(/);
  assert.doesNotMatch(preferences, /fetchChatModelPreferences/);
  assert.match(preferences, /bootstrapComplete/);
  assert.match(page, /onSessionInvalid/);
});

test("keeps DeepSeek access server-side and uses the V4 thinking contract", async () => {
  const [page, client, protocol, adapter, adapterConfig, messages, route, modelsRoute, envExample] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/deepseek/deepseek-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/deepseek/deepseek-client-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/deepseek/deepseek-messages.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/models/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(envExample, /^DEEPSEEK_API_KEY=$/m);
  assert.doesNotMatch(page, /api\.deepseek\.com|DEEPSEEK_API_KEY|@supabase\/supabase-js/);
  assert.doesNotMatch(client, /api\.deepseek\.com|DEEPSEEK_API_KEY|@supabase\/supabase-js/);
  assert.match(protocol, /deepseek-v4-flash/);
  assert.match(protocol, /deepseek-v4-pro/);
  assert.match(protocol, /reasoningEffort/);
  assert.match(protocol, /systemPrompt/);
  assert.match(protocol, /userPresence/);
  assert.match(adapterConfig, /https:\/\/api\.deepseek\.com/);
  assert.match(adapter, /reasoning_content/);
  assert.match(adapter, /reasoning_effort/);
  assert.match(adapter, /thinking/);
  assert.doesNotMatch(adapter, /deepseek-chat|deepseek-reasoner/);
  assert.match(messages, /role: "system"/);
  assert.match(messages, /tool_call_id/);
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /streamChatJob/);
  assert.doesNotMatch(route, /after\(|runChatJob|generateChatResponse/);
  assert.match(route, /text\/event-stream/);
  assert.match(modelsRoute, /composerChatModels/);
  assert.match(modelsRoute, /discoverChatModels/);
  assert.match(modelsRoute, /enableChatModel/);
});

test("keeps composer model and thinking controls accessible and responsive", async () => {
  const [page, workspace, sidebar, preferences, storage, settings, defaults, protocol, composer, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/use-chat-preferences.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/settings/settings-modal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-defaults.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-composer.tsx", import.meta.url), "utf8"),
    readStyles(),
  ]);
  const client = `${page}\n${workspace}\n${sidebar}\n${preferences}\n${storage}\n${settings}\n${defaults}\n${protocol}`;

  assert.match(composer, /aria-label="Choose model"/);
  assert.match(composer, /aria-label="Choose thinking mode"/);
  assert.match(composer, /aria-label="Stop generating"/);
  assert.match(composer, /aria-label=\{expanded \? "Close expanded editor" : "Expand message editor"\}/);
  assert.match(composer, /className="composer-expand-icon"/);
  assert.doesNotMatch(composer, /expanded \? "↙" : "↗"/);
  assert.match(composer, /useLayoutEffect\(\(\) =>/);
  assert.match(composer, /event\.key === "Escape" && expanded/);
  assert.match(composer, /composer-wrap--expanded/);
  assert.match(composer, /className="send-button stop-button"/);
  assert.match(composer, /<rect x="3" y="3" width="10" height="10" rx="1"/);
  assert.match(composer, /aria-controls="model-options"/);
  assert.match(composer, /aria-controls="thinking-options"/);
  assert.match(composer, /aria-pressed=/);
  assert.match(client, /supportedEfforts/);
  assert.match(client, /Open settings/);
  assert.match(client, /fetchChatUserPreferences/);
  assert.match(client, /saveChatUserPreferences/);
  assert.doesNotMatch(client, /localStorage/);
  assert.match(client, /readOnly/);
  assert.match(client, /responds in English/);
  assert.match(client, /User presence/);
  assert.match(settings, /aria-label="Settings sections"/);
  assert.match(settings, /aria-current=/);
  assert.match(settings, /className="settings-section-grid"/);
  assert.match(settings, /className="settings-section-card"/);
  assert.match(settings, /className="settings-sections-button"/);
  assert.match(settings, /setShowIndex\(false\)/);
  assert.match(settings, /setShowIndex\(true\)/);
  assert.match(settings, /Promise<UsageReport>/);
  assert.match(settings, /aria-label="Usage period"/);
  assert.match(settings, /Day/);
  assert.match(settings, /Week/);
  assert.match(settings, /Month/);
  assert.match(settings, /All time/);
  assert.match(settings, /Tools/);
  assert.doesNotMatch(settings, /Notifications/);
  assert.match(settings, /Models/);
  assert.match(settings, /ModelsSettings/);
  assert.match(settings, /Memory/);
  assert.match(settings, /Automations/);
  assert.match(settings, /Configurables/);
  assert.match(settings, /Security and login/);
  assert.match(settings, /Account/);
  assert.match(settings, /Skills/);
  assert.match(settings, /SkillsSettings/);
  assert.doesNotMatch(settings, /label: "Keyboard"/);
  assert.match(settings, /role="tooltip"/);
  assert.match(settings, /Cached input/);
  assert.match(settings, /estimatedRequestCount/);
  assert.match(settings, /unpricedRequestCount/);
  assert.match(settings, /bucket\.costUsd \/ maximumCost/);
  assert.match(settings, /Provider calls/);
  assert.match(workspace, /fetchChatUsage/);
  assert.match(workspace, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(workspace, /loadUsage=\{loadUsage\}/);
  assert.match(settings, /per 1M tokens/);
  assert.match(styles, /backdrop-filter: blur\(8px\)/);
  assert.match(styles, /\.settings-section-grid[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.settings-section-card\[aria-current="page"\]/);
  assert.match(styles, /\.settings-main[\s\S]*?height: 100%/);
  assert.match(styles, /\.settings-bar-target:hover \.settings-bar-tooltip,[\s\S]*?\.settings-bar-target:focus-visible \.settings-bar-tooltip/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(workspace, /mobileMenuButtonRef/);
  assert.match(workspace, /setSidebarOpen\(false\);[\s\S]*?setOpenConversationActions\(null\);[\s\S]*?setSettingsOpen\(true\)/);
  assert.doesNotMatch(client, /Messages stay on this device/);
  assert.doesNotMatch(styles, /privacy-note/);
  assert.match(styles, /bottom: calc\(100% \+ 8px\)/);
  assert.match(styles, /padding: 34px max\(21px, calc\(\(100% - 860px\) \/ 2\)\) 220px;/);
  assert.match(styles, /height: 100dvh;/);
  assert.match(styles, /\.chat-area[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.transcript[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.chat-active \.composer-wrap[\s\S]*?position: absolute;/);
  assert.match(styles, /\.composer textarea[\s\S]*?max-height: 192px;/);
  assert.match(styles, /\.composer-wrap--expanded[\s\S]*?position: fixed;/);
  assert.match(styles, /\.composer-wrap--expanded[\s\S]*?transform: none;/);
  assert.match(styles, /\.composer--expanded[\s\S]*?height: min\(560px, 60dvh\);[\s\S]*?max-height: calc\(100dvh - 48px\);/);
  assert.match(styles, /\.composer--expanded[\s\S]*?height: 100%;[\s\S]*?min-height: 0;/);
  assert.match(styles, /\.composer--expanded textarea[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.composer--expanded \.composer-actions[\s\S]*?margin-top: auto;/);
});

test("keeps the transcript scroll viewport full-width with compact mobile composer clearance", async () => {
  const [transcript, responsive] = await Promise.all([
    readFile(new URL("../app/styles/transcript.css", import.meta.url), "utf8"),
    readFile(new URL("../app/styles/responsive.css", import.meta.url), "utf8"),
  ]);
  const desktopTranscript = transcript.match(/\.transcript\s*\{[\s\S]*?\n\}/)?.[0];
  const mobileResponsiveBlock = extractCssBlock(responsive, "@media (max-width: 760px)");
  const mobileResponsiveTranscript = mobileResponsiveBlock
    && extractCssBlock(mobileResponsiveBlock, ".transcript");
  const mobileTranscriptBlock = extractCssBlock(
    extractCssBlock(transcript, "@media (max-width: 760px)") ?? "",
    ".transcript",
  );

  assert.ok(desktopTranscript);
  assert.match(desktopTranscript, /width: 100%;/);
  assert.match(desktopTranscript, /padding: 34px max\(21px, calc\(\(100% - 860px\) \/ 2\)\) 220px;/);
  assert.match(desktopTranscript, /overflow-y: auto;/);
  assert.doesNotMatch(transcript, /width: min\(860px, calc\(100% - 42px\)\)/);
  assert.doesNotMatch(desktopTranscript, /margin: 0 auto;/);

  assert.ok(mobileResponsiveTranscript);
  assert.match(mobileResponsiveTranscript, /width: calc\(100% - 28px - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\);/);
  assert.match(mobileResponsiveTranscript, /padding-top: 70px;/);
  assert.match(mobileResponsiveTranscript, /padding-bottom: calc\(100px \+ env\(safe-area-inset-bottom\)\);/);
  assert.ok(mobileTranscriptBlock);
  assert.match(mobileTranscriptBlock, /padding-inline: 0;/);
});

test("shows call activity without a generic generation indicator", async () => {
  const [page, workspace, transcript, turn, generation, stream, indicator, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-transcript.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-turn.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/use-chat-generation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-stream-reducer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/call-activity-indicator.tsx", import.meta.url), "utf8"),
    readStyles(),
  ]);
  const client = `${page}\n${workspace}\n${transcript}\n${turn}\n${generation}\n${stream}\n${indicator}`;

  assert.doesNotMatch(page, /Generating(?:…|Ã¢â‚¬Â¦)/);
  assert.match(client, /controller\.signal\.aborted[\s\S]*?activeRequestsRef\.current/);
  assert.match(client, /setWaitingByMessage/);
  assert.match(client, /case "reasoning"|event\.type === "reasoning"/);
  assert.match(client, /reasoning/);
  assert.doesNotMatch(client, /Waiting for reasoning/);
  assert.match(client, /waitingByMessage\[message\.id\][\s\S]*?<CallActivityIndicator \/>|waitingByMessage\[assistantMessage\.id\][\s\S]*?<CallActivityIndicator \/>/);
  assert.match(client, /!assistantMessage\.thinkingEnabled && waitingByMessage\[assistantMessage\.id\][\s\S]*?<CallActivityIndicator \/>/);
  assert.match(client, /role="status" aria-label="Waiting for response"/);
  assert.match(client, /<span aria-hidden="true">[^<]+<\/span>/);
  assert.match(styles, /\.call-activity-indicator > span[\s\S]*?animation: call-activity-pulse/);
  assert.match(styles, /@keyframes call-activity-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.call-activity-indicator > span \{[\s\S]*?animation: none;/);
});

test("keeps mobile prompt actions prominent and ephemeral", async () => {
  const [page, workspace, transcript, turn, actions, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-transcript.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-turn.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/message-actions.tsx", import.meta.url), "utf8"),
    readStyles(),
  ]);
  const client = `${page}\n${workspace}\n${transcript}\n${turn}\n${actions}`;

  assert.match(client, /message-action-popover/);
  assert.match(client, /message-actions-backdrop/);
  assert.match(client, /message-user-container/);
  assert.match(client, /aria-label="Close prompt actions"/);
  assert.match(client, /role="menuitem"/);
  assert.match(client, /Share prompt/);
  assert.match(client, /navigator\.share/);
  assert.match(client, /event\.key === "Escape"/);
  assert.match(client, /setOpenMessageActions\(null\)/);
  assert.match(styles, /\.message-actions-backdrop[\s\S]*?backdrop-filter: blur\(8px\)/);
  assert.match(styles, /\.message-action-popover[\s\S]*?backdrop-filter: blur\(16px\)/);
  assert.match(styles, /\.message-actions-open \.message-user-container[\s\S]*?z-index: 20/);
  assert.match(styles, /\.message-actions-open \.message\.user \.message-bubble[\s\S]*?transform: scale\(1\.06\)/);
  assert.match(styles, /\.message-action-popover[\s\S]*?top: calc\(100% - 1px\)/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.message\.user \.message-bubble \{[\s\S]*?user-select: none;[\s\S]*?-webkit-user-select: none;/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.conversation-item,[\s\S]*?\.conversation-title \{[\s\S]*?user-select: none;[\s\S]*?-webkit-user-select: none;/);
});

test("expands assistant responses across the mobile transcript", async () => {
  const styles = await readStyles();

  assert.match(
    styles,
    /@media \(max-width: 760px\) \{[\s\S]*?\.message\.assistant \.message-bubble \{\s*max-width: 100%;\s*\}/,
  );
});

test("uses normal whitespace flow for rendered assistant Markdown", async () => {
  const styles = await readStyles();

  assert.match(styles, /\.assistant-markdown \{\s*white-space: normal;\s*\}/);
});

test("keeps wide assistant Markdown tables on one line with horizontal scrolling", async () => {
  const [renderer, styles] = await Promise.all([
    readFile(new URL("../app/chat/assistant-response.tsx", import.meta.url), "utf8"),
    readStyles(),
  ]);

  assert.match(renderer, /className="assistant-markdown-table"/);
  assert.match(renderer, /table: MarkdownTable/);
  assert.match(styles, /\.assistant-markdown-table \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.assistant-markdown-table table \{[\s\S]*?width: max-content;[\s\S]*?min-width: 100%;/);
  assert.match(styles, /\.assistant-markdown td \{[\s\S]*?white-space: nowrap;/);
});

test("validates and preserves ordered assistant tool rounds", () => {
  const artifact = {
    id: "signed-artifact-token",
    name: "report.csv",
    contentType: "text/csv",
    size: 42,
  };
  const request = parseChatRequest({
    systemPrompt: "System",
    userPresence: "",
    model: "deepseek-v4-flash",
    thinking: true,
    reasoningEffort: "high",
    conversationId: "conversation_123",
    messages: [
      { role: "user", content: "Calculate it" },
      {
        role: "assistant",
        content: "The answer is 42.",
        rounds: [
          {
            reasoning: "I should calculate this.",
            content: "",
            toolCalls: [
              {
                id: "call_1",
                name: "run_python",
                arguments: "{\"code\":\"print(42)\"}",
                result: {
                  id: "call_1",
                  name: "run_python",
                  ok: true,
                  stdout: "42\n",
                  stderr: "",
                  exitCode: 0,
                  artifacts: [artifact],
                },
              },
            ],
          },
          { reasoning: "The result is ready.", content: "The answer is 42." },
        ],
      },
      { role: "user", content: "What did Python return?" },
    ],
  });

  assert.equal(request.messages[1].rounds?.length, 2);
  assert.equal(request.messages[1].rounds?.[0].toolCalls?.[0].result?.stdout, "42\n");
  assert.deepEqual(
    request.messages[1].rounds?.[0].toolCalls?.[0].result?.artifacts?.[0],
    artifact,
  );
});

test("keeps Python execution isolated, persistent, bounded, and server-only", async () => {
  const [executor, tool, manifest, streamService, artifactStore, artifactRoute, client, activity, envExample, packageJson, workerDockerfile, workerSource, compose] =
    await Promise.all([
      readFile(new URL("../app/server/python/local-python-executor.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/server/agent/python-tool.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/server/agent/python-tool-manifest.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/chat/chat-server-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/server/artifacts/artifact-store.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/chat/artifacts/[artifactId]/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/chat/chat-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/chat/assistant-activity.tsx", import.meta.url), "utf8"),
      readFile(new URL("../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../docker/python-worker/Dockerfile", import.meta.url), "utf8"),
      readFile(new URL("../docker/python-worker/server.py", import.meta.url), "utf8"),
      readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    ]);

  assert.match(executor, /PYTHON_WORKER_URL/);
  assert.match(executor, /x-python-worker-secret/);
  assert.match(executor, /sessions\/open/);
  assert.match(executor, /sessions\/close/);
  assert.match(executor, /responseTimeoutMs: 240_000/);
  assert.match(workerSource, /start_new_session=True/);
  assert.match(workerSource, /kill_process_group/);
  assert.match(workerSource, /O_NOFOLLOW/);
  assert.match(workerSource, /resource_limits/);
  assert.match(workerDockerfile, /FROM python:3\.13-slim/);
  assert.match(compose, /python-worker:/);
  assert.match(compose, /cpus: "0\.75"/);
  assert.match(compose, /mem_limit: 1536m/);
  assert.match(compose, /pids_limit: 128/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(executor, /callTimeoutMs: 60_000/);
  assert.doesNotMatch(executor, /maxCalls/);
  assert.match(executor, /relativeWorkspacePath/);
  assert.doesNotMatch(executor, /readConversationArtifact/);
  assert.doesNotMatch(executor, /process\.env\.DEEPSEEK_API_KEY|SUPABASE_SECRET_KEY/);
  assert.match(tool, /python-tool-manifest/);
  assert.match(manifest, /PYTHON_TOOL_NAME = "run_python"/);
  assert.match(streamService, /replayRounds/);
  assert.match(streamService, /systemInstructions/);
  assert.match(streamService, /call\.result = result/);
  assert.match(streamService, /new LocalPythonExecutor\(ownerId, conversationId, responseDeadlineAt\)/);
  assert.doesNotMatch(artifactStore, /new Map/);
  assert.match(artifactStore, /createHmac/);
  assert.match(artifactStore, /ARTIFACT_SIGNING_SECRET/);
  assert.match(artifactStore, /sha256/);
  assert.match(artifactRoute, /authorizeOwnerSession/);
  assert.match(artifactRoute, /openOwnedStorageObject/);
  assert.match(artifactRoute, /Artifact has changed since it was created/);
  assert.match(client, /\/api\/chat\/artifacts\/\$\{encodeURIComponent\(artifact\.id\)\}/);
  assert.doesNotMatch(client, /artifact\.downloadUrl/);
  assert.match(activity, /aria-expanded=\{open\}/);
  assert.match(activity, /Created \{artifact\.name\}/);
  assert.match(activity, /pythonSourceFor/);
  assert.match(activity, /filename: "script\.py"/);
  assert.match(activity, /className="python-source"/);
  assert.match(activity, /className="python-output"/);
  assert.match(activity, /phases = activities\.reduce/);
  assert.doesNotMatch(activity, /JSON\.stringify\(activity\.call, null, 2\)/);
  assert.match(envExample, /^PYTHON_WORKER_SECRET=$/m);
  assert.match(envExample, /^PYTHON_WORKER_URL=http:\/\/python-worker:5003$/m);
  assert.match(envExample, /^ARTIFACT_SIGNING_SECRET=$/m);
  assert.equal(JSON.parse(packageJson).dependencies?.modal, undefined);
});

test("classifies mobile history swipes by viewport threshold and direction", () => {
  const decide = (deltaX, deltaY, sidebarOpen, viewportWidth = 400) =>
    getMobileHistorySwipeAction({ deltaX, deltaY, sidebarOpen, viewportWidth });

  assert.equal(decide(107, 0, false), null);
  assert.equal(decide(108, 0, false), "open");
  assert.equal(decide(-108, 0, true), "close");
  assert.equal(decide(108, 0, true), null);
  assert.equal(decide(-108, 0, false), null);
  assert.equal(decide(120, 121, false), null);
  assert.equal(decide(120, 119, false), "open");
  assert.equal(decide(200, 0, false, 761), null);
});

test("keeps mobile history gesture tracking touch-safe and click-safe", () => {
  const gesture = new MobileHistorySwipeGesture();
  const begin = (overrides = {}) =>
    gesture.begin({
      clientX: 0,
      clientY: 0,
      disabled: false,
      isPrimary: true,
      pointerId: 1,
      pointerType: "touch",
      sidebarOpen: false,
      viewportWidth: 400,
      ...overrides,
    });

  assert.equal(begin({ pointerType: "mouse" }), false);
  assert.equal(begin({ isPrimary: false }), false);
  assert.equal(begin({ disabled: true }), false);
  assert.equal(begin({ viewportWidth: 761 }), false);

  assert.equal(begin(), true);
  assert.equal(begin({ pointerId: 2, isPrimary: false }), false);
  assert.equal(gesture.isTrackingPointer(1), true);
  assert.equal(gesture.cancel(2), false);
  assert.equal(gesture.isTrackingPointer(1), true);
  assert.equal(gesture.end({ clientX: 20, clientY: 0, pointerId: 2 }), null);
  assert.equal(gesture.isTrackingPointer(1), true);
  assert.equal(
    gesture.move({
      clientX: MOBILE_HISTORY_HORIZONTAL_INTENT_PX,
      clientY: 0,
      pointerId: 1,
    }),
    true,
  );
  gesture.cancel();

  assert.equal(begin(), true);
  assert.equal(
    gesture.move({
      clientX: MOBILE_HISTORY_HORIZONTAL_INTENT_PX - 1,
      clientY: 0,
      pointerId: 1,
    }),
    false,
  );
  assert.equal(
    gesture.move({
      clientX: MOBILE_HISTORY_HORIZONTAL_INTENT_PX,
      clientY: 0,
      pointerId: 1,
    }),
    true,
  );
  assert.equal(gesture.hasClickSuppression(), true);
  assert.equal(gesture.end({ clientX: 108, clientY: 0, pointerId: 1 }), "open");
  assert.equal(gesture.end({ clientX: 108, clientY: 0, pointerId: 1 }), null);
  assert.equal(gesture.consumeClickSuppression(), true);
  assert.equal(gesture.consumeClickSuppression(), false);

  assert.equal(begin(), true);
  assert.equal(gesture.move({ clientX: 120, clientY: 121, pointerId: 1 }), false);
  gesture.cancel();
  assert.equal(gesture.end({ clientX: 120, clientY: 0, pointerId: 1 }), null);
  assert.equal(gesture.hasClickSuppression(), false);
});

test("wires mobile history swipes without pointer capture", async () => {
  const [page, workspace, navigation, sidebar, styles, gestureSource] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/use-mobile-history-navigation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-sidebar.tsx", import.meta.url), "utf8"),
    readStyles(),
    readFile(new URL("../app/chat/mobile-history-swipe.ts", import.meta.url), "utf8"),
  ]);
  const client = `${page}\n${workspace}\n${navigation}\n${sidebar}`;

  assert.match(client, /onPointerDown: handlePointerDown/);
  assert.match(client, /onPointerMove: handlePointerMove/);
  assert.match(client, /onPointerUp: handlePointerUp/);
  assert.match(client, /onPointerCancel: handlePointerCancel/);
  assert.match(client, /isTrackingPointer\(event\.pointerId\)/);
  assert.match(client, /cancel\(event\.pointerId\)/);
  assert.match(client, /onClickCapture: handleClickCapture/);
  assert.match(client, /window\.addEventListener\("blur"/);
  assert.match(client, /window\.addEventListener\("resize"/);
  assert.match(client, /disabled: settingsOpen/);
  assert.match(client, /action === "open"[\s\S]*?onBeforeSidebarOpen[\s\S]*?onSidebarOpen\(\)/);
  assert.match(client, /window\.getSelection\(\)\?\.isCollapsed === false/);
  assert.match(client, /gestureRef\.current\.cancel\(event\.pointerId\)/);
  assert.doesNotMatch(client, /hasHorizontalIntent && event\.cancelable\) event\.preventDefault\(\)/);
  assert.match(client, /aria-label="Collapse sidebar"[\s\S]*?onCloseSidebar/);
  assert.doesNotMatch(client, /setPointerCapture|releasePointerCapture/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.app-shell \{[\s\S]*?touch-action: pan-y;/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.chat-area \{[\s\S]*?touch-action: pan-y;[\s\S]*?overscroll-behavior-x: none;/);
  assert.match(gestureSource, /MOBILE_HISTORY_MAX_WIDTH = 760/);
  assert.match(gestureSource, /MOBILE_HISTORY_SWIPE_THRESHOLD = 0\.27/);
  assert.match(gestureSource, /pointerType !== "touch"/);
  assert.match(gestureSource, /!isPrimary/);
});

test("renders assistant Markdown and LaTeX with the bobert default prompt", async () => {
  const [page, workspace, defaults, protocol, transcript, turn, renderer, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-defaults.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-transcript.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/conversation-turn.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/assistant-response.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  const client = `${page}\n${workspace}\n${defaults}\n${protocol}\n${transcript}\n${turn}`;
  assert.match(client, /<bobert_behavior>/);
  assert.match(client, /bobert may use Markdown/);
  assert.match(client, /DEFAULT_CHAT_SYSTEM_PROMPT/);
  assert.match(client, /<AssistantResponse content=\{assistantMessage\.content\}/);
  assert.match(renderer, /remarkGfm/);
  assert.match(renderer, /remarkMath/);
  assert.match(renderer, /rehypeKatex/);
  assert.match(layout, /katex\/dist\/katex\.min\.css/);

  const dependencies = JSON.parse(packageJson).dependencies;
  for (const dependency of ["react-markdown", "remark-gfm", "remark-math", "rehype-katex", "katex"]) {
    assert.ok(dependencies[dependency], `${dependency} should be installed`);
  }
});

test("does not retain removed hosting integrations", async () => {
  const files = [
    "../package.json",
    "../README.md",
    "../.gitignore",
    "../app/globals.css",
  ];
  const contents = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  );
  const source = contents.join("\n");
  assert.doesNotMatch(source, /openai|\.openai|sites-vite|cloudflare|vinext|wrangler|D1Database/i);
});

test("renders web activities inside thought-process disclosures", async () => {
  const [activity, styles, stream, history] = await Promise.all([
    readFile(new URL("../app/chat/assistant-activity.tsx", import.meta.url), "utf8"),
    readStyles(),
    readFile(new URL("../app/chat/chat-stream-reducer.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-history.ts", import.meta.url), "utf8"),
  ]);
  assert.match(activity, /WebDisclosure/);
  assert.match(activity, /phaseActivities\.map/);
  assert.match(activity, /kind: "output"/);
  assert.match(activity, /phaseSegments/);
  assert.match(activity, /!outputActivities\.length/);
  assert.match(activity, /activity\.summary \?\? "Thinking…"/);
  assert.match(activity, /const latestSummary = reasoningItems\.reduce/);
  assert.match(activity, /summary: latestSummary\.summary/);
  assert.match(activity, /web\.results/);
  assert.match(activity, /web\.markdown/);
  assert.match(`${stream}\n${history}`, /kind: call\.name === "run_python" \? "python" : "web"/);
  assert.match(styles, /\.web-nested/);
});

test("renders explicit phase breaks as visible reasoning boundaries", async () => {
  const [activity, styles] = await Promise.all([
    readFile(new URL("../app/chat/assistant-activity.tsx", import.meta.url), "utf8"),
    readStyles(),
  ]);
  assert.match(activity, /className="reasoning-phase"/);
  assert.match(activity, /className="message-bubble phase-progress-update"/);
  assert.match(activity, /Progress update/);
  assert.match(activity, /aria-label="Progress update"/);
  assert.match(styles, /\.reasoning-phase/);
  assert.match(styles, /\.phase-progress-update/);
  assert.match(styles, /\.phase-progress-update-label/);
});
