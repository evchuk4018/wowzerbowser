"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuthSession } from "../auth/use-auth-session";
import type { Project, ProjectDetail, ProjectFile } from "./project-types";
import {
  createProject,
  createProjectChat,
  deleteProject,
  deleteProjectFile,
  getProjectDetail,
  listProjects,
  projectFileUrl,
  updateProject,
} from "./projects-service";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function FileState({ file }: { file: ProjectFile }) {
  if (file.state === "complete") return null;
  return <span className={`project-file-state is-${file.state}`}>{file.state}</span>;
}

export function ProjectPage() {
  const router = useRouter();
  const { state: authState } = useAuthSession();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [instructionsDraft, setInstructionsDraft] = useState("");

  const loadDetail = useCallback(async (projectId: string) => {
    try {
      const nextDetail = await getProjectDetail(projectId);
      setDetail(nextDetail);
      setTitleDraft(nextDetail.project.title);
      setInstructionsDraft(nextDetail.project.instructions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The project is unavailable.");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState.status === "anonymous") {
      router.replace("/login?callbackUrl=/projects");
      return;
    }
    if (authState.status !== "authenticated") return;
    let active = true;
    void listProjects().then((items) => {
      if (!active) return;
      setProjects(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
      if (items[0]) {
        setDetailLoading(true);
        void loadDetail(items[0].id);
      }
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Projects are unavailable.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [authState.status, loadDetail, router]);

  function selectProject(projectId: string) {
    setSelectedId(projectId);
    setDetailLoading(true);
    setError(null);
    void loadDetail(projectId);
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setBusyAction("create");
    setError(null);
    try {
      const project = await createProject(title);
      setProjects((current) => [project, ...current]);
      selectProject(project.id);
      setNewTitle("");
      setCreateOpen(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The project could not be created.");
    } finally {
      setBusyAction(null);
    }
  }

  async function saveChanges(changes: Partial<Pick<Project, "title" | "instructions">>, action: string) {
    if (!detail) return;
    setBusyAction(action);
    setError(null);
    try {
      const project = await updateProject(detail.project.id, changes);
      setDetail((current) => current ? { ...current, project } : current);
      setProjects((current) => current.map((item) => item.id === project.id ? project : item));
      setTitleDraft(project.title);
      setInstructionsDraft(project.instructions);
      setEditingTitle(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The project could not be updated.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteProject() {
    if (!detail || !window.confirm(`Delete “${detail.project.title}”? Its shared files will also be deleted.`)) return;
    setBusyAction("delete-project");
    try {
      await deleteProject(detail.project.id);
      const remaining = projects.filter((project) => project.id !== detail.project.id);
      setProjects(remaining);
      setDetail(null);
      if (remaining[0]) selectProject(remaining[0].id);
      else setSelectedId(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The project could not be deleted.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDeleteFile(file: ProjectFile) {
    if (!detail || !window.confirm(`Delete “${file.name}” from this project?`)) return;
    setBusyAction(`file-${file.id}`);
    try {
      await deleteProjectFile(detail.project.id, file.id);
      setDetail((current) => current ? { ...current, files: current.files.filter((item) => item.id !== file.id) } : current);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The file could not be deleted.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleNewChat() {
    if (!detail) return;
    setBusyAction("new-chat");
    setError(null);
    try {
      const chat = await createProjectChat(detail.project.id);
      router.push(`/chat/${encodeURIComponent(chat.id)}`);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The chat could not be created.");
      setBusyAction(null);
    }
  }

  return (
    <main className="projects-shell">
      <aside className={`projects-index ${selectedId ? "has-selection" : ""}`} aria-label="Projects">
        <header className="projects-index-header">
          <Link className="projects-back-link" href="/chat" aria-label="Back to chat">←</Link>
          <div><span className="projects-eyebrow">Workspace</span><h1>Projects</h1></div>
          <button className="projects-create-trigger" type="button" aria-label="Create project" onClick={() => setCreateOpen(true)}>+</button>
        </header>
        {createOpen && (
          <form className="project-create-form" onSubmit={handleCreate}>
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" autoFocus maxLength={160} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="New project" />
            <div className="project-inline-actions">
              <button type="button" onClick={() => { setCreateOpen(false); setNewTitle(""); }}>Cancel</button>
              <button className="is-primary" type="submit" disabled={!newTitle.trim() || busyAction === "create"}>{busyAction === "create" ? "Creating…" : "Create"}</button>
            </div>
          </form>
        )}
        <div className="projects-list" aria-live="polite">
          {loading && <p className="projects-status">Loading projects…</p>}
          {!loading && projects.length === 0 && <div className="projects-empty"><span aria-hidden="true">◇</span><h2>No projects yet</h2><p>Group chats, instructions, and shared files in one place.</p><button type="button" onClick={() => setCreateOpen(true)}>Create a project</button></div>}
          {projects.map((project) => (
            <button key={project.id} type="button" className={`project-list-item ${selectedId === project.id ? "is-active" : ""}`} onClick={() => selectProject(project.id)}>
              <span className="project-list-mark" aria-hidden="true">◆</span>
              <span><strong>{project.title}</strong><small>Updated {formatDate(project.updatedAt)}</small></span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      </aside>

      <section className={`project-detail ${selectedId ? "is-visible" : ""}`} aria-label="Project details" aria-busy={detailLoading}>
        <div className="project-detail-topbar">
          <button className="project-mobile-back" type="button" onClick={() => setSelectedId(null)}>← <span>Projects</span></button>
          <Link href="/chat">Back to chat</Link>
        </div>
        {error && <div className="projects-error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
        {detailLoading && <div className="project-detail-loading">Loading project…</div>}
        {!detailLoading && detail && (
          <div className="project-detail-content">
            <header className="project-hero">
              <div className="project-hero-copy">
                <span className="projects-eyebrow">Project</span>
                {editingTitle ? (
                  <form className="project-title-form" onSubmit={(event) => { event.preventDefault(); void saveChanges({ title: titleDraft.trim() }, "title"); }}>
                    <label className="sr-only" htmlFor="project-title">Project title</label>
                    <input id="project-title" autoFocus maxLength={160} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
                    <button type="submit" disabled={!titleDraft.trim() || busyAction === "title"}>Save</button>
                    <button type="button" onClick={() => { setTitleDraft(detail.project.title); setEditingTitle(false); }}>Cancel</button>
                  </form>
                ) : (
                  <div className="project-title-row"><h2>{detail.project.title}</h2><button type="button" onClick={() => setEditingTitle(true)} aria-label="Rename project">Rename</button></div>
                )}
                <p>Created {formatDate(detail.project.createdAt)} · {detail.chats.length} {detail.chats.length === 1 ? "chat" : "chats"} · {detail.files.length} {detail.files.length === 1 ? "file" : "files"}</p>
              </div>
              <div className="project-hero-actions">
                <button className="project-new-chat" type="button" onClick={() => void handleNewChat()} disabled={busyAction === "new-chat"}><span>+</span>{busyAction === "new-chat" ? "Creating…" : "New chat"}</button>
                <button className="project-delete" type="button" onClick={() => void handleDeleteProject()} disabled={busyAction === "delete-project"}>Delete project</button>
              </div>
            </header>

            <section className="project-section" aria-labelledby="instructions-heading">
              <div className="project-section-heading"><div><span className="project-section-icon" aria-hidden="true">✦</span><h3 id="instructions-heading">Project instructions</h3></div><span>{instructionsDraft.length}/12,000</span></div>
              <p className="project-section-note">These instructions apply to every chat in this project.</p>
              <textarea aria-label="Project instructions" maxLength={12000} value={instructionsDraft} onChange={(event) => setInstructionsDraft(event.target.value)} placeholder="Add context, goals, preferred tone, or anything the assistant should know…" />
              <div className="project-section-actions"><button type="button" onClick={() => setInstructionsDraft(detail.project.instructions)} disabled={instructionsDraft === detail.project.instructions}>Reset</button><button className="is-primary" type="button" onClick={() => void saveChanges({ instructions: instructionsDraft }, "instructions")} disabled={instructionsDraft === detail.project.instructions || busyAction === "instructions"}>{busyAction === "instructions" ? "Saving…" : "Save instructions"}</button></div>
            </section>

            <section className="project-section" aria-labelledby="files-heading">
              <div className="project-section-heading"><div><span className="project-section-icon" aria-hidden="true">↥</span><h3 id="files-heading">Shared files</h3></div><span>{detail.files.length}</span></div>
              <p className="project-section-note">Files attached in project chats are available across the project.</p>
              {detail.files.length === 0 ? <p className="project-row-empty">No shared files yet.</p> : <ul className="project-resource-list">{detail.files.map((file) => <li key={file.id}><span className="project-file-glyph" aria-hidden="true">▤</span><span className="project-resource-copy"><strong>{file.name}</strong><small>{formatSize(file.size)} · {formatDate(file.createdAt)} <FileState file={file} /></small></span><a href={projectFileUrl(detail.project.id, file.id)} download={file.name} aria-label={`Download ${file.name}`}>Download</a><button type="button" aria-label={`Delete ${file.name}`} disabled={busyAction === `file-${file.id}`} onClick={() => void handleDeleteFile(file)}>Delete</button></li>)}</ul>}
            </section>

            <section className="project-section" aria-labelledby="chats-heading">
              <div className="project-section-heading"><div><span className="project-section-icon" aria-hidden="true">◌</span><h3 id="chats-heading">Chats</h3></div><button type="button" onClick={() => void handleNewChat()} disabled={busyAction === "new-chat"}>+ New chat</button></div>
              {detail.chats.length === 0 ? <p className="project-row-empty">No chats yet. Start one to begin working in this project.</p> : <ul className="project-resource-list project-chat-list">{detail.chats.map((chat) => <li key={chat.id}><span className="project-chat-glyph" aria-hidden="true">◜</span><Link className="project-resource-copy" href={`/chat/${encodeURIComponent(chat.id)}`}><strong>{chat.title}</strong><small>Updated {formatDate(chat.updatedAt)}{chat.isStreaming ? " · Response in progress" : ""}</small></Link><span aria-hidden="true">›</span></li>)}</ul>}
            </section>
          </div>
        )}
        {!selectedId && !loading && projects.length > 0 && <div className="project-detail-placeholder"><span aria-hidden="true">◆</span><h2>Select a project</h2><p>Choose a project to view its instructions, files, and chats.</p></div>}
      </section>
    </main>
  );
}
