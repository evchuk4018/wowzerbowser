import { closeOwnerAuthRepository, ownerIdFromEnvironment, resetOwnerPassword } from "../app/server/auth/owner-auth-repository.mjs";
import { hashPassword } from "../app/server/auth/password.mjs";
import { configuredOwner, loadEnvironmentFile, passwordFromPrivateInput, validateArguments } from "./owner-auth-cli.mjs";

async function main() {
  validateArguments(new Set(["--env-file", "--password-stdin"]));
  await loadEnvironmentFile();
  const { email, ownerId } = configuredOwner();
  if (ownerId !== ownerIdFromEnvironment()) throw new Error("APP_OWNER_ID could not be loaded from the deployment environment.");
  await resetOwnerPassword({ ownerId, email, passwordHash: await hashPassword(await passwordFromPrivateInput()) });
  console.log("owner-password-reset\tcompleted");
}

main().catch((error) => {
  console.error(`owner-password-reset-failed\t${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}).finally(() => closeOwnerAuthRepository().catch(() => undefined));
