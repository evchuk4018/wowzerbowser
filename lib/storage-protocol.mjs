export const STORAGE_OBJECT_STATES = ["uploading", "complete", "failed"];
export const STORAGE_OBJECT_KINDS = ["document", "image", "document-image", "artifact", "revision-source", "other"];

export const STORAGE_OBJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const STORAGE_OBJECT_KEY_PATTERN = /^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isStorageObjectId(value) {
  return typeof value === "string" && STORAGE_OBJECT_ID_PATTERN.test(value);
}

export function validateStorageObjectKey(value) {
  if (typeof value !== "string" || !STORAGE_OBJECT_KEY_PATTERN.test(value) || value.includes("\\") || value.includes("..")) {
    throw new Error("The storage object key is invalid.");
  }
  return value;
}
