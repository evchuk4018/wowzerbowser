import { bootstrapOwner, closeOwnerAuthRepository, getOwnerCredentialsById, ownerIdFromEnvironment } from "../app/server/auth/owner-auth-repository.mjs";
import { hashPassword } from "../app/server/auth/password.mjs";
import { configuredOwner, hasArgument, loadEnvironmentFile, passwordFromPrivateInput, validateArguments } from "./owner-auth-cli.mjs";

async function main() {
  validateArguments(new Set(["--env-file", "--password-stdin"]));
  await loadEnvironmentFile();
  const { email, ownerId } = configuredOwner();
  if (ownerId !== ownerIdFromEnvironment()) throw new Error("APP_OWNER_ID could not be loaded from the deployment environment.");

  const existing = await getOwnerCredentialsById(ownerId);
  if (existing) {
    if (existing.email !== email) throw new Error("The configured APP_OWNER_EMAIL does not match the existing owner.");
    console.log("owner-bootstrap\talready-configured");
    return;
  }

  if (!hasArgument("--password-stdin") && !process.env.APP_OWNER_PASSWORD && !process.stdin.isTTY) {
    throw new Error("Owner bootstrap needs APP_OWNER_PASSWORD or --password-stdin with a private password stream.");
  }
  const passwordHash = await hashPassword(await passwordFromPrivateInput());
  await bootstrapOwner({ ownerId, email, passwordHash });
  console.log("owner-bootstrap\tcreated");
}

main().catch((error) => {
  console.error(`owner-bootstrap-failed\t${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}).finally(() => closeOwnerAuthRepository().catch(() => undefined));
