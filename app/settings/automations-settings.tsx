"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../auth/auth-fetch";
import type { Automation, AutomationKind, AutomationSchedule } from "../../lib/automation-protocol";
import type { Reminder } from "../../lib/reminder-protocol";

const empty = () => ({ name: "", kind: "report" as AutomationKind, instructions: "", schedule: { kind: "daily", localTime: "09:00" } as AutomationSchedule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC" });
const localDateTimeInput = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const emptyReminder = () => ({ title: "", message: "", at: localDateTimeInput(new Date(Date.now() + 60 * 60_000)), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC" });

export function AutomationsSettings({ hasSession }: { hasSession: () => Promise<boolean> }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [draft, setDraft] = useState(empty);
  const [reminderDraft, setReminderDraft] = useState(emptyReminder);
  const [editing, setEditing] = useState<string | null>(null);
  const [reminderEditing, setReminderEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const request = useCallback(async (path = "", init?: RequestInit) => {
    if (!(await hasSession())) throw new Error("Your session expired.");
    const response = await authFetch(`/api/automations${path}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Automation request failed.");
    return response.status === 204 ? null : response.json();
  }, [hasSession]);
  const reminderRequest = useCallback(async (path = "", init?: RequestInit) => {
    if (!(await hasSession())) throw new Error("Your session expired.");
    const response = await authFetch(`/api/reminders${path}`, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}) } });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Reminder request failed.");
    return response.status === 204 ? null : response.json();
  }, [hasSession]);
  const load = useCallback(() => {
    void Promise.all([request(), reminderRequest()]).then(([automationBody, reminderBody]) => {
      setItems((automationBody as { automations: Automation[] }).automations);
      setReminders((reminderBody as { reminders: Reminder[] }).reminders);
      setStatus("ready");
    }).catch(() => setStatus("error"));
  }, [request, reminderRequest]);
  useEffect(() => {
    load();
  }, [load]);
  const edit = (item: Automation) => { setEditing(item.id); setDraft({ name: item.name, kind: item.kind, instructions: item.instructions, schedule: item.schedule, timeZone: item.timeZone }); };
  const save = async () => {
    setStatus("saving");
    try {
      await request(editing ? `/${editing}` : "", { method: editing ? "PATCH" : "POST", body: JSON.stringify(draft) });
      setEditing(null); setDraft(empty()); load();
    } catch { setStatus("error"); }
  };
  const editReminder = (item: Reminder) => {
    setReminderEditing(item.id);
    setReminderDraft({ title: item.title, message: item.message, at: item.at, timeZone: item.timeZone });
  };
  const saveReminder = async () => {
    setStatus("saving");
    try {
      await reminderRequest(reminderEditing ? `/${reminderEditing}` : "", { method: reminderEditing ? "PATCH" : "POST", body: JSON.stringify(reminderDraft) });
      setReminderEditing(null); setReminderDraft(emptyReminder()); load();
    } catch { setStatus("error"); }
  };
  const mutate = async (item: Automation, action: "toggle" | "delete") => {
    if (action === "delete" && !confirm(`Delete “${item.name}”?`)) return;
    setStatus("saving");
    try {
      await request(`/${item.id}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", body: JSON.stringify({ status: item.status === "active" ? "paused" : "active" }) });
      load();
    } catch { setStatus("error"); }
  };
  const cancelReminderItem = async (item: Reminder) => {
    if (!confirm(`Cancel “${item.title}”?`)) return;
    setStatus("saving");
    try { await reminderRequest(`/${item.id}`, { method: "DELETE" }); load(); } catch { setStatus("error"); }
  };
  return <div className="automations-settings">
    <div className="settings-panel-heading"><h3>Automations and reminders</h3><p>Run recurring reports, monitor conditions, or receive a one-off reminder at a specific local time.</p></div>
    {status === "error" && <p className="settings-status settings-error" role="alert">Automations or reminders could not be saved or loaded.</p>}
    <div className="automation-list">
      {items.map((item) => <article className="automation-row" key={item.id}>
        <div><strong>{item.name}</strong><small>{item.kind === "report" ? "Recurring report" : "Live check"} · {item.status} · Next {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "not scheduled"}</small></div>
        <div><button type="button" onClick={() => edit(item)}>Edit</button><button type="button" onClick={() => void mutate(item, "toggle")}>{item.status === "active" ? "Pause" : "Resume"}</button><button type="button" className="skill-danger" onClick={() => void mutate(item, "delete")}>Delete</button></div>
        {item.lastError && <p>{item.lastError}</p>}
      </article>)}
      {status === "ready" && !items.length && <p className="settings-status">No automations yet.</p>}
    </div>
    <div className="automation-list">
      <h4>One-off reminders</h4>
      {reminders.map((item) => <article className="automation-row" key={item.id}>
        <div><strong>{item.title}</strong><small>Reminder · {item.status} · {item.at.replace("T", " ")} ({item.timeZone})</small></div>
        <div>{!(["completed", "cancelled"] as string[]).includes(item.status) && <button type="button" onClick={() => editReminder(item)}>Edit</button>}{item.status !== "completed" && item.status !== "cancelled" && <button type="button" className="skill-danger" onClick={() => void cancelReminderItem(item)}>Cancel</button>}</div>
        <p>{item.message}</p>
      </article>)}
      {status === "ready" && !reminders.length && <p className="settings-status">No one-off reminders yet.</p>}
    </div>
    <div className="automation-editor">
      <h4>{editing ? "Edit automation" : "New automation"}</h4>
      <label className="settings-field"><span>Name</span><input value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="settings-field"><span>Type</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as AutomationKind })}><option value="report">Recurring report</option><option value="live_check">Live check</option></select></label>
      <label className="settings-field"><span>Instructions {draft.kind === "live_check" ? "and exact match condition" : ""}</span><textarea rows={5} value={draft.instructions} maxLength={12000} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
      <label className="settings-field"><span>Schedule</span><select value={draft.schedule.kind} onChange={(event) => {
        const kind = event.target.value;
        setDraft({ ...draft, schedule: kind === "interval" ? { kind, everyMinutes: 60 } : kind === "weekly" ? { kind, localTime: "09:00", weekday: 1 } : { kind: kind as "daily" | "weekdays", localTime: "09:00" } });
      }}><option value="interval">Interval</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option></select></label>
      {draft.schedule.kind === "interval" ? <label className="settings-field"><span>Every minutes</span><input type="number" min={15} value={draft.schedule.everyMinutes} onChange={(event) => setDraft({ ...draft, schedule: { kind: "interval", everyMinutes: Number(event.target.value) } })} /></label> : draft.schedule.kind === "once" ? <label className="settings-field"><span>Date and time</span><input type="datetime-local" value={draft.schedule.at} onChange={(event) => setDraft({ ...draft, schedule: { kind: "once", at: event.target.value } })} /></label> : <label className="settings-field"><span>Local time</span><input type="time" value={draft.schedule.localTime} onChange={(event) => setDraft((current) => ({ ...current, schedule: current.schedule.kind === "weekly" ? { kind: "weekly", weekday: current.schedule.weekday, localTime: event.target.value } : { kind: current.schedule.kind === "weekdays" ? "weekdays" : "daily", localTime: event.target.value } }))} /></label>}
      {draft.schedule.kind === "weekly" && <label className="settings-field"><span>Day</span><select value={draft.schedule.weekday} onChange={(event) => setDraft((current) => ({ ...current, schedule: { kind: "weekly", localTime: current.schedule.kind === "weekly" ? current.schedule.localTime : "09:00", weekday: Number(event.target.value) } }))}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>}
      <label className="settings-field"><span>Timezone</span><input value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} /></label>
      <div className="settings-actions automation-actions">{editing && <button className="settings-cancel" type="button" onClick={() => { setEditing(null); setDraft(empty()); }}>Cancel</button>}<button className="settings-save" type="button" disabled={status === "saving" || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()}>{status === "saving" ? "Saving…" : editing ? "Save changes" : "Create automation"}</button></div>
    </div>
    <div className="automation-editor">
      <h4>{reminderEditing ? "Edit reminder" : "New reminder"}</h4>
      <label className="settings-field"><span>Title</span><input value={reminderDraft.title} maxLength={100} onChange={(event) => setReminderDraft({ ...reminderDraft, title: event.target.value })} /></label>
      <label className="settings-field"><span>Message</span><textarea rows={4} value={reminderDraft.message} maxLength={12000} onChange={(event) => setReminderDraft({ ...reminderDraft, message: event.target.value })} /></label>
      <label className="settings-field"><span>Date and time</span><input type="datetime-local" value={reminderDraft.at} onChange={(event) => setReminderDraft({ ...reminderDraft, at: event.target.value })} /></label>
      <label className="settings-field"><span>Timezone</span><input value={reminderDraft.timeZone} onChange={(event) => setReminderDraft({ ...reminderDraft, timeZone: event.target.value })} /></label>
      <div className="settings-actions automation-actions">{reminderEditing && <button className="settings-cancel" type="button" onClick={() => { setReminderEditing(null); setReminderDraft(emptyReminder()); }}>Cancel</button>}<button className="settings-save" type="button" disabled={status === "saving" || !reminderDraft.title.trim() || !reminderDraft.message.trim()} onClick={() => void saveReminder()}>{status === "saving" ? "Saving…" : reminderEditing ? "Save reminder" : "Create reminder"}</button></div>
    </div>
  </div>;
}
