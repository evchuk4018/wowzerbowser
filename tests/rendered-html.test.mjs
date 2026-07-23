import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    assert.match(html, /aria-label="Loading session"/);
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
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
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

test("self-hosts Geist without a Google Fonts build dependency", async () => {
  const [layout, styles, ...fontAssets] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    ...[
      "geist-cyrillic-ext.woff2",
      "geist-cyrillic.woff2",
      "geist-vietnamese.woff2",
      "geist-latin-ext.woff2",
      "geist-latin.woff2",
    ].map((font) => readFile(new URL(`../public/fonts/${font}`, import.meta.url))),
  ]);

  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.doesNotMatch(styles, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(styles, /--font-geist-sans: "Geist", "Geist Fallback";/);
  assert.match(styles, /url\("\/fonts\/geist-latin\.woff2"\)/);
  for (const asset of fontAssets) {
    assert.ok(asset.byteLength > 0, "self-hosted Geist font assets should not be empty");
  }
});

test("keeps Supabase calls behind adapters and owner authorization", async () => {
  const [page, browserAdapter, serverAdapter, ownerService, magicLinkRoute, authService, authForm] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-browser-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/supabase-server-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/owner-auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/auth/magic-link/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/auth-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/auth/magic-link-form.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /@supabase\/supabase-js|createClient\(/);
  assert.match(browserAdapter, /@supabase\/supabase-js/);
  assert.doesNotMatch(browserAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /signInWithOtp/);
  assert.match(serverAdapter, /shouldCreateUser: true/);
  assert.match(ownerService, /APP_OWNER_EMAIL/);
  assert.match(ownerService, /NEXT_PUBLIC_SITE_URL/);
  assert.match(magicLinkRoute, /sendOwnerMagicLink/);
  assert.match(magicLinkRoute, /magic_link_rate_limited/);
  assert.match(authService, /MagicLinkRateLimitError/);
  assert.match(authService, /response\.status === 429/);
  assert.match(browserAdapter, /signInWithPassword/);
  assert.match(browserAdapter, /signUp/);
  assert.match(authForm, /Create password account/);
  assert.match(authForm, /isMagicLinkRateLimitError/);
});

test("keeps DeepSeek access server-side and uses the V4 thinking contract", async () => {
  const [page, client, protocol, adapter, route, modelsRoute, envExample] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/chat-protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/providers/deepseek/deepseek-adapter.ts", import.meta.url), "utf8"),
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
  assert.match(adapter, /https:\/\/api\.deepseek\.com/);
  assert.match(adapter, /role: "system"/);
  assert.match(adapter, /reasoning_content/);
  assert.match(adapter, /reasoning_effort/);
  assert.match(adapter, /thinking/);
  assert.doesNotMatch(adapter, /deepseek-chat|deepseek-reasoner/);
  assert.match(route, /authorizeOwnerSession/);
  assert.match(route, /text\/event-stream/);
  assert.match(modelsRoute, /listDeepSeekModels/);
});

test("keeps composer model and thinking controls accessible and responsive", async () => {
  const [page, composer, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/chat-composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(composer, /aria-label="Choose model"/);
  assert.match(composer, /aria-label="Choose thinking mode"/);
  assert.match(composer, /aria-controls="model-options"/);
  assert.match(composer, /aria-controls="thinking-options"/);
  assert.match(composer, /aria-pressed=/);
  assert.match(page, /supportedEfforts/);
  assert.match(page, /Open settings/);
  assert.match(page, /local-chat-settings/);
  assert.match(page, /Always respond in English/);
  assert.match(page, /User presence/);
  assert.match(styles, /backdrop-filter: blur\(8px\)/);
  assert.doesNotMatch(page, /Messages stay on this device/);
  assert.doesNotMatch(styles, /privacy-note/);
  assert.match(styles, /bottom: calc\(100% \+ 8px\)/);
  assert.match(styles, /padding: 34px 0 220px/);
  assert.match(styles, /height: 100dvh;/);
  assert.match(styles, /\.chat-area[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.transcript[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.chat-active \.composer-wrap[\s\S]*?position: absolute;/);
});

test("shows call activity without a generic generation indicator", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /Generating(?:…|Ã¢â‚¬Â¦)/);
  const waitingGuard = "if (controller.signal.aborted || activeRequestRef.current?.messageId !== assistantMessage.id)";
  const waitingStateSetter = "setWaitingMessageId(assistantMessage.id)";
  assert.ok(page.includes(waitingGuard));
  assert.ok(page.includes(waitingStateSetter));
  assert.ok(
    page.indexOf(waitingGuard) < page.indexOf(waitingStateSetter),
    "the cancelled-request guard must run before the waiting indicator state is set",
  );
  assert.match(page, /event\.type === "reasoning"[\s\S]*?current === assistantMessage\.id \? null : current/);
  assert.match(page, /\{Boolean\(assistantMessage\.reasoning\) && \(/);
  assert.doesNotMatch(page, /Waiting for reasoning/);
  assert.match(page, /!assistantMessage\.thinkingEnabled && waitingMessageId === assistantMessage\.id[\s\S]*?<CallActivityIndicator \/>/);
  assert.match(page, /!message\.thinkingEnabled && message\.status === "streaming"[\s\S]*?<CallActivityIndicator \/>/);
  assert.match(page, /role="status" aria-label="Waiting for response"/);
  assert.match(page, /<span aria-hidden="true">✦<\/span>/);
  assert.match(styles, /\.call-activity-indicator > span[\s\S]*?animation: call-activity-pulse/);
  assert.match(styles, /@keyframes call-activity-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.call-activity-indicator > span \{[\s\S]*?animation: none;/);
});

test("keeps mobile prompt actions prominent and ephemeral", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /message-action-popover/);
  assert.match(page, /message-actions-backdrop/);
  assert.match(page, /message-user-container/);
  assert.match(page, /aria-label="Close prompt actions"/);
  assert.match(page, /role="menuitem"/);
  assert.match(page, /Share prompt/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /event\.key === "Escape"\) setOpenMessageActions\(null\)/);
  assert.match(page, /onScroll=\{\(\) => setOpenMessageActions\(null\)\}/);
  assert.match(styles, /\.message-actions-backdrop[\s\S]*?backdrop-filter: blur\(8px\)/);
  assert.match(styles, /\.message-action-popover[\s\S]*?backdrop-filter: blur\(16px\)/);
  assert.match(styles, /\.message-actions-open \.message-user-container[\s\S]*?z-index: 20/);
  assert.match(styles, /\.message-actions-open \.message\.user \.message-bubble[\s\S]*?transform: scale\(1\.06\)/);
  assert.match(styles, /\.message-action-popover[\s\S]*?top: calc\(100% - 1px\)/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.message\.user \.message-bubble \{[\s\S]*?user-select: none;[\s\S]*?-webkit-user-select: none;/);
});

test("keeps mobile history drawer movement progressive and chat centered", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /drawerDragProgress/);
  assert.match(page, /clampDrawerProgress/);
  assert.match(page, /DRAWER_OPEN_THRESHOLD = 0\.25/);
  assert.match(page, /gesture\.startProgress === 0/);
  assert.match(page, /drawerProgressRef\.current >= DRAWER_OPEN_THRESHOLD/);
  assert.match(page, /drawerProgressRef\.current > 1 - DRAWER_OPEN_THRESHOLD/);
  assert.match(page, /onPointerDown=\{beginDrawerGesture\}/);
  assert.match(page, /onPointerMove=\{updateDrawerGesture\}/);
  assert.match(page, /onPointerUp=\{finishDrawerGesture\}/);
  assert.match(page, /event\.preventDefault\(\)/);
  assert.match(page, /DRAWER_GESTURE_IGNORE_SELECTOR/);
  assert.match(styles, /var\(--drawer-progress, 0\) \* 100%/);
  assert.match(styles, /\.sidebar\.sidebar-dragging[\s\S]*?transition: none;/);
  assert.match(styles, /\.sidebar-scrim[\s\S]*?opacity: var\(--drawer-progress, 0\)/);
  assert.match(styles, /\.chat-area \{[\s\S]*?touch-action: pan-y;/);
});

test("renders assistant Markdown and LaTeX with the bobert default prompt", async () => {
  const [page, renderer, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/chat/assistant-response.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<bobert_behavior>/);
  assert.match(page, /bobert may use Markdown/);
  assert.match(page, /LEGACY_DEFAULT_SYSTEM_PROMPT/);
  assert.match(page, /<AssistantResponse content=\{message\.content\} \/>/);
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
