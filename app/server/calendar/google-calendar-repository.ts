import "server-only";

import { getServerClient } from "../../auth/supabase-server-adapter";
import type { EncryptedCalendarToken } from "./google-calendar-crypto";

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
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

export async function getGoogleCalendarCredential(ownerId: string): Promise<GoogleCalendarCredential | null> {
  const { data, error } = await getServerClient().from("google_calendar_credentials")
    .select(columns).eq("owner_id", ownerId).maybeSingle();
  if (error) throw error;
  return data ? credential(data as CredentialRow) : null;
}

export async function saveGoogleCalendarCredential(
  ownerId: string,
  token: EncryptedCalendarToken,
  scope: string,
): Promise<GoogleCalendarCredential> {
  const { data, error } = await getServerClient().from("google_calendar_credentials").upsert({
    owner_id: ownerId,
    refresh_token_ciphertext: token.ciphertext,
    refresh_token_nonce: token.nonce,
    refresh_token_auth_tag: token.authTag,
    scope,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id" }).select(columns).single();
  if (error) throw error;
  return credential(data as CredentialRow);
}

export async function deleteGoogleCalendarCredential(ownerId: string): Promise<void> {
  const { error } = await getServerClient().from("google_calendar_credentials").delete().eq("owner_id", ownerId);
  if (error) throw error;
}
