import "server-only";

import type { EncryptedCalendarToken } from "./google-calendar-crypto";
import { databaseOwnerId, isoTimestamp, query } from "../database/database";

export type GoogleCalendarCredential = EncryptedCalendarToken & {
  ownerId: string;
  scope: string;
  connectedAt: string;
  updatedAt: string;
};

type CredentialRow = {
  owner_id: string; refresh_token_ciphertext: string; refresh_token_nonce: string;
  refresh_token_auth_tag: string; scope: string; connected_at: string; updated_at: string;
};

const columns = "owner_id,refresh_token_ciphertext,refresh_token_nonce,refresh_token_auth_tag,scope,connected_at,updated_at";

function credential(row: CredentialRow): GoogleCalendarCredential {
  return {
    ownerId: row.owner_id,
    ciphertext: row.refresh_token_ciphertext,
    nonce: row.refresh_token_nonce,
    authTag: row.refresh_token_auth_tag,
    scope: row.scope,
    connectedAt: isoTimestamp(row.connected_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

export async function getGoogleCalendarCredential(ownerId: string): Promise<GoogleCalendarCredential | null> {
  const [row] = await query<CredentialRow>(`select ${columns} from google_calendar_credentials where owner_id=$1`, [databaseOwnerId(ownerId)]);
  return row ? credential(row) : null;
}

export async function saveGoogleCalendarCredential(
  ownerId: string,
  token: EncryptedCalendarToken,
  scope: string,
): Promise<GoogleCalendarCredential> {
  const now = new Date().toISOString();
  const [row] = await query<CredentialRow>(`insert into google_calendar_credentials(owner_id,refresh_token_ciphertext,refresh_token_nonce,refresh_token_auth_tag,scope,connected_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$6)
    on conflict(owner_id) do update set refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_nonce=excluded.refresh_token_nonce,refresh_token_auth_tag=excluded.refresh_token_auth_tag,scope=excluded.scope,connected_at=excluded.connected_at,updated_at=excluded.updated_at
    returning ${columns}`, [databaseOwnerId(ownerId), token.ciphertext, token.nonce, token.authTag, scope, now]);
  return credential(row);
}

export async function deleteGoogleCalendarCredential(ownerId: string): Promise<void> {
  await query("delete from google_calendar_credentials where owner_id=$1", [databaseOwnerId(ownerId)]);
}
