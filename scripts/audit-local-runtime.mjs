import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["app", "auth.ts", "auth-types.d.ts", "lib", "scripts", "database", "docker", "compose.yaml", "Dockerfile", ".env.example", "next.config.ts", "package.json", "package-lock.json"];
const forbiddenSourcePatterns = [
  ["supabase-sdk", /@supabase(?:\/|\\)|supabase-js|createClient\s*\(/iu],
  ["supabase-config", /(?:SUPABASE|supabaseUrl|supabaseKey|NEXT_PUBLIC_SUPABASE)/u],
  ["postgrest", /postgrest|\.from\s*\(\s*["'](?:storage|public)/iu],
  ["hosted-storage", /storage\.from|createSignedUrl|signedUrl/iu],
  ["hosted-auth", /signInWithOtp|magic[ -]?link|supabaseAuth/iu],
  ["hosted-scheduler", /pg_net|supabase\s+cron|supabase\s+vault/iu],
  ["obsolete-hosting", /\bvercel\b|\brailway\b/iu],
];
const forbiddenClientPatterns = [
  ["supabase-runtime", /@supabase|supabase\.co|postgrest|storage\.from|signInWithOtp|magic[ -]?link|pg_net|vault/iu],
  ["server-secret-name", /(?:AUTH_SECRET|DATABASE_URL|POSTGRES_PASSWORD|APP_OWNER_PASSWORD|DEEPSEEK_API_KEY|OPENROUTER_API_KEY|OPENCODE_API_KEY|PIPEDREAM_CONNECT_API_KEY|DISCORD_BOT_TOKEN|GOOGLE_OAUTH_CLIENT_SECRET|CONNECTOR_CREDENTIAL_ENCRYPTION_KEY|LOCAL_DRIVE_API_TOKEN)/u],
];

async function filesUnder(relative) {
  const absolute = path.join(root, relative);
  const details = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  if (!details.length) return [absolute];
  const files = [];
  for (const entry of details) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path.relative(root, child)));
    else files.push(child);
  }
  return files;
}

async function sourceFiles() {
  const files = [];
  for (const sourceRoot of sourceRoots) files.push(...await filesUnder(sourceRoot));
  return files.filter((file) => !file.includes(`${path.sep}supabase${path.sep}`) && !file.endsWith(`${path.sep}audit-local-runtime.mjs`));
}

async function inspectFiles(files, patterns) {
  const findings = [];
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => null);
    if (source === null) continue;
    for (const [label, pattern] of patterns) if (pattern.test(source)) findings.push({ file: path.relative(root, file), label });
  }
  return findings;
}

async function dependencyFindings() {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(lock.packages ?? {}).map((name) => name.replace(/^node_modules\//u, "")),
  ];
  return [...new Set(names.filter((name) => name === "@supabase/supabase-js" || name.startsWith("@supabase/")))].map((name) => ({ file: "package manifest/lock", label: name }));
}

async function auditSource() {
  const findings = [...await dependencyFindings(), ...await inspectFiles(await sourceFiles(), forbiddenSourcePatterns)];
  if (findings.length) {
    for (const finding of findings) console.error(`local-runtime-audit-failed\t${finding.file}\t${finding.label}`);
    process.exitCode = 1;
    return;
  }
  console.log("local-runtime-audit\tsource-clean");
}

async function auditClient() {
  const staticDirectory = path.join(root, ".next", "static");
  const files = (await filesUnder(path.relative(root, staticDirectory))).filter((file) => file.endsWith(".js") || file.endsWith(".css") || file.endsWith(".map"));
  if (!files.length) throw new Error("The Next.js client bundle is missing; run npm run build first.");
  const findings = await inspectFiles(files, forbiddenClientPatterns);
  if (findings.length) {
    for (const finding of findings) console.error(`client-bundle-audit-failed\t${finding.file}\t${finding.label}`);
    process.exitCode = 1;
    return;
  }
  console.log(`client-bundle-audit\tclean\tfiles=${files.length}`);
}

if (process.argv.includes("--client")) await auditClient();
else if (process.argv.includes("--source") || process.argv.includes("--supabase")) await auditSource();
else throw new Error("Usage: node scripts/audit-local-runtime.mjs --source|--client");
