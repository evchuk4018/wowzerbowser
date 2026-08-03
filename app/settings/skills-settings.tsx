"use client";

import { useCallback, useEffect, useState } from "react";
import {
  SKILL_LIMITS,
  type SkillDefinition,
  type SkillMutation,
} from "../../lib/skill-protocol";
import { createSkill, deleteSkill, fetchSkills, resetSkill, updateSkill } from "./skills-service";

const blankDraft = (): SkillMutation => ({ name: "", summary: "", instructions: "" });

export function SkillsSettings({ hasSession }: { hasSession: () => Promise<boolean> }) {
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<SkillMutation>(blankDraft);
  const [status, setStatus] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<"delete" | "reset" | null>(null);

  const ensureSession = useCallback(async () => {
    const value = await hasSession();
    if (!value) throw new Error("Sign in to manage skills.");
  }, [hasSession]);

  const reload = useCallback(async () => {
    await ensureSession();
    setSkills(await fetchSkills());
  }, [ensureSession]);

  useEffect(() => {
    let active = true;
    void ensureSession().then(fetchSkills).then(
      (values) => {
        if (!active) return;
        setSkills(values);
        setStatus("ready");
      },
      (reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Skills could not be loaded.");
        setStatus("ready");
      },
    );
    return () => { active = false; };
  }, [ensureSession]);

  function beginCreate() {
    setDraft(blankDraft());
    setEditingId("new");
    setConfirming(null);
    setError("");
  }

  function beginEdit(skill: SkillDefinition) {
    setDraft({ name: skill.name, summary: skill.summary, instructions: skill.instructions });
    setEditingId(skill.id);
    setExpandedId(skill.id);
    setConfirming(null);
    setError("");
  }

  function closeEditor() {
    setEditingId(null);
    setDraft(blankDraft());
    setConfirming(null);
  }

  async function save() {
    if (!editingId) return;
    setStatus("saving");
    setError("");
    try {
      await ensureSession();
      const saved = editingId === "new"
        ? await createSkill(draft)
        : await updateSkill(editingId, draft);
      await reload();
      setExpandedId(saved.id);
      closeEditor();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The skill could not be saved.");
    } finally {
      setStatus("ready");
    }
  }

  async function reset(skill: SkillDefinition) {
    setStatus("saving");
    setError("");
    try {
      await ensureSession();
      await resetSkill(skill.id);
      await reload();
      setConfirming(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The skill could not be reset.");
    } finally {
      setStatus("ready");
    }
  }

  async function remove(skill: SkillDefinition) {
    setStatus("saving");
    setError("");
    try {
      await ensureSession();
      await deleteSkill(skill.id);
      await reload();
      setExpandedId(null);
      setConfirming(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The skill could not be deleted.");
    } finally {
      setStatus("ready");
    }
  }

  const editing = editingId !== null;
  const busy = status === "saving";

  return (
    <div className="skills-settings">
      <div className="settings-panel-heading skills-heading">
        <div>
          <h3>Skills</h3>
          <p>Teach the assistant reusable workflows without keeping every instruction in each conversation.</p>
        </div>
        {!editing && (
          <button type="button" className="settings-save" onClick={beginCreate}>
            Add skill
          </button>
        )}
      </div>

      {error && <p className="settings-status settings-error" role="alert">{error}</p>}
      {status === "loading" && <p className="settings-status" role="status">Loading skills...</p>}

      {editing ? (
        <div className="skill-editor">
          <h4>{editingId === "new" ? "New skill" : "Edit skill"}</h4>
          <label className="settings-field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={SKILL_LIMITS.maxNameLength}
              placeholder="Create a presentation"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>Summary</span>
            <input
              value={draft.summary}
              maxLength={SKILL_LIMITS.maxSummaryLength}
              placeholder="When the assistant should use this skill"
              onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>Instructions</span>
            <textarea
              value={draft.instructions}
              maxLength={SKILL_LIMITS.maxInstructionsLength}
              rows={14}
              placeholder="Write the complete workflow the assistant should follow."
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>
          <div className="skill-editor-footer">
            <span>{draft.instructions.length.toLocaleString("en-US")} / {SKILL_LIMITS.maxInstructionsLength.toLocaleString("en-US")}</span>
            <div>
              <button type="button" className="settings-cancel" disabled={busy} onClick={closeEditor}>Cancel</button>
              <button
                type="button"
                className="settings-save"
                disabled={busy || !draft.name.trim() || !draft.summary.trim() || !draft.instructions.trim()}
                onClick={() => void save()}
              >
                {busy ? "Saving..." : "Save skill"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="skills-list">
          {skills.map((skill) => {
            const expanded = expandedId === skill.id;
            return (
              <article className="skill-row" key={skill.id}>
                <div className="skill-row-header">
                  <button
                    type="button"
                    className="skill-expand"
                    aria-expanded={expanded}
                    aria-controls={`skill-${skill.id}`}
                    onClick={() => {
                      setExpandedId(expanded ? null : skill.id);
                      setConfirming(null);
                    }}
                  >
                    <span aria-hidden="true">{expanded ? "−" : "+"}</span>
                    <strong>{skill.name}</strong>
                    <small>{skill.source === "builtin" ? "Built-in" : "Custom"}{skill.customized && skill.source === "builtin" ? " · Customized" : ""}</small>
                  </button>
                  <button type="button" className="skill-edit" onClick={() => beginEdit(skill)}>Edit</button>
                </div>
                {expanded && (
                  <div className="skill-details" id={`skill-${skill.id}`}>
                    <p>{skill.summary}</p>
                    <pre>{skill.instructions}</pre>
                    <div className="skill-detail-actions">
                      {skill.source === "builtin" && skill.customized && (
                        confirming === "reset" ? (
                          <span className="skill-confirm">
                            Restore the shipped version?
                            <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
                            <button type="button" disabled={busy} onClick={() => void reset(skill)}>Reset</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirming("reset")}>Reset to default</button>
                        )
                      )}
                      {skill.source === "custom" && (
                        confirming === "delete" ? (
                          <span className="skill-confirm">
                            Delete this skill?
                            <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
                            <button type="button" className="skill-danger" disabled={busy} onClick={() => void remove(skill)}>Delete</button>
                          </span>
                        ) : (
                          <button type="button" className="skill-danger" onClick={() => setConfirming("delete")}>Delete</button>
                        )
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {status !== "loading" && !skills.length && <p className="settings-status">No skills are available.</p>}
        </div>
      )}
    </div>
  );
}
