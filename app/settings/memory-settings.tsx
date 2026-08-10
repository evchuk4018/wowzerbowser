"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryView } from "../../lib/memory-protocol";
import type { UserMemory } from "../../lib/user-memory";
import { deleteMemory, fetchMemoryView, updateMemory } from "./memory-service";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date);
}

function writerLabel(writer: UserMemory["writer"]): string {
  return writer === "dreaming" ? "Dreaming model" : "Chat model";
}

export function MemorySettings({ hasSession }: { hasSession: () => Promise<boolean> }) {
  const [view, setView] = useState<MemoryView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!(await hasSession())) throw new Error("Sign in to view memory.");
    return fetchMemoryView();
  }, [hasSession]);

  const reload = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      setView(await load());
      setStatus("ready");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Memory could not be loaded.");
    }
  }, [load]);

  useEffect(() => {
    let active = true;
    void load().then(
      (result) => {
        if (!active) return;
        setView(result);
        setStatus("ready");
      },
      (reason) => {
        if (!active) return;
        setStatus("error");
        setError(reason instanceof Error ? reason.message : "Memory could not be loaded.");
      },
    );
    return () => { active = false; };
  }, [load]);

  const memoriesByFolder = useMemo(() => {
    const groups = new Map<string, UserMemory[]>();
    for (const memory of view?.profile.memories ?? []) {
      const memories = groups.get(memory.folderId) ?? [];
      memories.push(memory);
      groups.set(memory.folderId, memories);
    }
    return groups;
  }, [view]);

  async function ensureMutationSession(): Promise<void> {
    if (!(await hasSession())) throw new Error("Sign in to manage memory.");
  }

  async function saveMemory(memoryId: string) {
    setMutatingId(memoryId);
    setError("");
    try {
      await ensureMutationSession();
      await updateMemory(memoryId, editingContent);
      setEditingId(null);
      setEditingContent("");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The memory could not be updated.");
    } finally {
      setMutatingId(null);
    }
  }

  async function removeMemory(memoryId: string) {
    setMutatingId(memoryId);
    setError("");
    try {
      await ensureMutationSession();
      await deleteMemory(memoryId);
      setConfirmingId(null);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The memory could not be deleted.");
    } finally {
      setMutatingId(null);
    }
  }

  return (
    <div className="memory-settings">
      <div className="settings-panel-heading">
        <h3>Memory</h3>
        <p>Review what the model remembers about you and the summaries it keeps for conversations.</p>
      </div>

      {status === "loading" && <p className="settings-status" role="status">Loading memory...</p>}
      {status === "error" && <p className="settings-status settings-error" role="alert">{error}</p>}
      {error && status === "ready" && <p className="settings-status settings-error" role="alert">{error}</p>}

      {view && (
        <>
          <section className="memory-section" aria-labelledby="memory-profile-heading">
            <div className="memory-section-heading">
              <div>
                <h4 id="memory-profile-heading">What the model remembers</h4>
                <p>{view.profile.memories.length} {view.profile.memories.length === 1 ? "memory" : "memories"} across {view.profile.folders.length} {view.profile.folders.length === 1 ? "folder" : "folders"}.</p>
              </div>
              <button type="button" className="memory-refresh" onClick={() => void reload()} disabled={status === "loading"}>
                Refresh
              </button>
            </div>

            {!view.profile.memories.length ? (
              <div className="memory-empty">No durable memories have been stored yet.</div>
            ) : (
              <div className="memory-folder-list">
                {view.profile.folders.map((folder) => {
                  const memories = memoriesByFolder.get(folder.id) ?? [];
                  return (
                    <section className="memory-folder" key={folder.id}>
                      <div className="memory-folder-heading">
                        <strong>{folder.name}</strong>
                        <span>{folder.path.slice(0, -1).join(" / ") || "User Profile"}</span>
                      </div>
                      {memories.length ? memories.map((memory) => (
                        <article className="memory-card" key={memory.id}>
                          {editingId === memory.id ? (
                            <label className="memory-editor">
                              <span>Memory content</span>
                              <textarea
                                value={editingContent}
                                maxLength={2000}
                                rows={4}
                                onChange={(event) => setEditingContent(event.target.value)}
                                disabled={mutatingId === memory.id}
                              />
                            </label>
                          ) : (
                            <p className="memory-content">{memory.content}</p>
                          )}

                          <div className="memory-card-footer">
                            <div className="memory-meta">
                              <span>{writerLabel(memory.writer)}</span>
                              {memory.sensitive && <span>Hashed sensitive value</span>}
                              <time dateTime={memory.updatedAt}>Updated {formatDate(memory.updatedAt)}</time>
                            </div>
                            {editingId === memory.id ? (
                              <div className="memory-card-actions">
                                <button type="button" onClick={() => { setEditingId(null); setEditingContent(""); }} disabled={mutatingId === memory.id}>Cancel</button>
                                <button type="button" className="memory-primary-action" onClick={() => void saveMemory(memory.id)} disabled={mutatingId === memory.id || !editingContent.trim()}>
                                  {mutatingId === memory.id ? "Saving..." : "Save"}
                                </button>
                              </div>
                            ) : confirmingId === memory.id ? (
                              <div className="memory-card-actions memory-delete-confirm">
                                <span>Delete this memory?</span>
                                <button type="button" onClick={() => setConfirmingId(null)} disabled={mutatingId === memory.id}>Cancel</button>
                                <button type="button" className="memory-danger-action" onClick={() => void removeMemory(memory.id)} disabled={mutatingId === memory.id}>
                                  {mutatingId === memory.id ? "Deleting..." : "Delete"}
                                </button>
                              </div>
                            ) : (
                              <div className="memory-card-actions">
                                {!memory.sensitive && <button type="button" onClick={() => { setEditingId(memory.id); setEditingContent(memory.content); setConfirmingId(null); }}>Edit</button>}
                                <button type="button" className="memory-danger-action" onClick={() => setConfirmingId(memory.id)}>Delete</button>
                              </div>
                            )}
                          </div>
                        </article>
                      )) : <p className="memory-folder-empty">No memories in this folder.</p>}
                    </section>
                  );
                })}
              </div>
            )}
          </section>

          <section className="memory-section" aria-labelledby="memory-summaries-heading">
            <div className="memory-section-heading">
              <div>
                <h4 id="memory-summaries-heading">Conversation summaries</h4>
                <p>Durable summaries used to keep long conversations in context.</p>
              </div>
            </div>
            {view.summaries.length ? (
              <div className="memory-summary-list">
                {view.summaries.map((summary) => (
                  <article className="memory-summary-card" key={summary.conversationId}>
                    <div className="memory-summary-heading">
                      <div>
                        <h5>{summary.title}</h5>
                        <time dateTime={summary.updatedAt}>Updated {formatDate(summary.updatedAt)}</time>
                      </div>
                      <span>Revision {summary.revision}</span>
                    </div>
                    <p>{summary.summary}</p>
                  </article>
                ))}
              </div>
            ) : <div className="memory-empty">No conversation summaries are available yet.</div>}
          </section>
        </>
      )}
    </div>
  );
}
