import "server-only";

import { checkRuntimeStorage, runtimeConfigurationIssues } from "../../../lib/runtime-preflight.mjs";
import { query } from "../database/database";
import { readDatabaseSchemaStatus } from "../database/schema-status";

type ReadinessCheck = {
  status: "ok" | "error";
  code?: string;
};

export type ReadinessReport = {
  service: "web";
  status: "ok" | "not_ready";
  checks: {
    application: ReadinessCheck;
    configuration: ReadinessCheck;
    database: ReadinessCheck;
    schema: ReadinessCheck;
    storage: ReadinessCheck;
  };
};

function errorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length < 80 ? code : fallback;
}

export async function getReadinessReport(): Promise<ReadinessReport> {
  const configurationIssues = runtimeConfigurationIssues();
  const configuration: ReadinessCheck = configurationIssues.length
    ? { status: "error", code: configurationIssues[0].code }
    : { status: "ok" };
  let storage: ReadinessCheck = { status: "error", code: "not_checked" };
  let database: ReadinessCheck = { status: "error", code: "not_checked" };
  let schema: ReadinessCheck = { status: "error", code: "not_checked" };

  if (configuration.status === "ok") {
    try {
      await checkRuntimeStorage({ createDirectories: false, probeWritable: true });
      storage = { status: "ok" };
    } catch (error) {
      storage = { status: "error", code: errorCode(error, "storage_not_ready") };
    }
    try {
      await query("select 1 as ready");
      database = { status: "ok" };
    } catch (error) {
      database = { status: "error", code: errorCode(error, "database_unavailable") };
    }
    if (database.status === "ok") {
      try {
        const status = await readDatabaseSchemaStatus();
        schema = status.current
          ? { status: "ok" }
          : { status: "error", code: status.unknownVersions.length ? "schema_unknown_migration" : status.changedVersions.length ? "schema_changed_migration" : "schema_pending_migration" };
      } catch (error) {
        schema = { status: "error", code: errorCode(error, "schema_unavailable") };
      }
    }
  } else {
    storage = { status: "error", code: "configuration_invalid" };
    database = { status: "error", code: "configuration_invalid" };
    schema = { status: "error", code: "configuration_invalid" };
  }

  const checks = {
    application: { status: "ok" as const },
    configuration,
    database,
    schema,
    storage,
  };
  const ready = Object.values(checks).every((check) => check.status === "ok");
  return { service: "web", status: ready ? "ok" : "not_ready", checks };
}
