import postgres from "postgres";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** @typedef {{ ownerId: string, email: string, passwordHash: string, sessionVersion: number }} OwnerCredentials */

const globals = globalThis;

function database() {
  if (globals.__wowzerbowserOwnerAuthDatabase) return globals.__wowzerbowserOwnerAuthDatabase;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for owner authentication.");
  globals.__wowzerbowserOwnerAuthDatabase = postgres(connectionString, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
  });
  return globals.__wowzerbowserOwnerAuthDatabase;
}

export function normalizeOwnerEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function ownerIdFromEnvironment() {
  const value = process.env.APP_OWNER_ID?.trim();
  if (!value || !UUID_PATTERN.test(value)) throw new Error("APP_OWNER_ID must be configured as a server-only UUID.");
  return value;
}

function mapRow(row) {
  if (!row) return null;
  return {
    ownerId: String(row.owner_id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    sessionVersion: Number(row.session_version),
  };
}

/** @returns {Promise<OwnerCredentials|null>} */
export async function getOwnerCredentialsById(ownerId = ownerIdFromEnvironment()) {
  const [row] = await database().unsafe(
    "select owner_id,email,password_hash,session_version from public.app_owner_credentials where owner_id=$1::uuid",
    [ownerId],
  );
  return mapRow(row);
}

/** @returns {Promise<OwnerCredentials|null>} */
export async function getOwnerCredentialsByEmail(email) {
  const normalized = normalizeOwnerEmail(email);
  const [row] = await database().unsafe(
    "select owner_id,email,password_hash,session_version from public.app_owner_credentials where email=$1",
    [normalized],
  );
  return mapRow(row);
}

/** @returns {Promise<{created: boolean, owner: OwnerCredentials}>} */
export async function bootstrapOwner({ ownerId, email, passwordHash }) {
  const normalizedEmail = normalizeOwnerEmail(email);
  return database().begin(async (transaction) => {
    const [existing] = await transaction.unsafe(
      "select owner_id,email,password_hash,session_version from public.app_owner_credentials where singleton=true for update",
    );
    if (existing) {
      const owner = mapRow(existing);
      if (owner.ownerId !== ownerId) throw new Error("The configured APP_OWNER_ID does not match the existing owner.");
      if (owner.email !== normalizedEmail) throw new Error("The configured APP_OWNER_EMAIL does not match the existing owner.");
      return { created: false, owner };
    }
    const [inserted] = await transaction.unsafe(
      `insert into public.app_owner_credentials(singleton,owner_id,email,password_hash,session_version)
       values(true,$1::uuid,$2,$3,0)
       returning owner_id,email,password_hash,session_version`,
      [ownerId, normalizedEmail, passwordHash],
    );
    return { created: true, owner: mapRow(inserted) };
  });
}

/** @returns {Promise<OwnerCredentials>} */
export async function resetOwnerPassword({ ownerId, email, passwordHash }) {
  const normalizedEmail = normalizeOwnerEmail(email);
  const [updated] = await database().unsafe(
    `update public.app_owner_credentials
       set password_hash=$1, session_version=session_version+1, updated_at=now()
     where singleton=true and owner_id=$2::uuid and email=$3
     returning owner_id,email,password_hash,session_version`,
    [passwordHash, ownerId, normalizedEmail],
  );
  const owner = mapRow(updated);
  if (!owner) throw new Error("The configured owner has not been bootstrapped.");
  return owner;
}

/** @returns {Promise<OwnerCredentials>} */
export async function advanceOwnerSessionVersion(ownerId) {
  const [updated] = await database().unsafe(
    `update public.app_owner_credentials
        set session_version=session_version+1, updated_at=now()
      where singleton=true and owner_id=$1::uuid
      returning owner_id,email,password_hash,session_version`,
    [ownerId],
  );
  const owner = mapRow(updated);
  if (!owner) throw new Error("The configured owner has not been bootstrapped.");
  return owner;
}

export async function closeOwnerAuthRepository() {
  const client = globals.__wowzerbowserOwnerAuthDatabase;
  globals.__wowzerbowserOwnerAuthDatabase = undefined;
  if (client) await client.end({ timeout: 5 });
}
