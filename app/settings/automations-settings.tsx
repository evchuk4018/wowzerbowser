"use client";

import { useCallback, useEffect, useState } from "react";
import type { Automation, AutomationKind, AutomationSchedule } from "../../lib/automation-protocol";

const empty = () => ({ name: "", kind: "report" as AutomationKind, instructions: "", schedule: { kind: "daily", localTime: "09:00" } as AutomationSchedule, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC" });

export function AutomationsSettings({ getAccessToken }: { getAccessToken: () => Promise<string | null> }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [draft, setDraft] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const request = useCallback(async (path = "", init?: RequestInit) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Your session expired.");
    const response = await fetch(`/api/automations${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) } });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Automation request failed.");
    return response.status === 204 ? null : response.json();
  }, [getAccessToken]);
  const load = useCallback(() => {
    void request().then((body) => { setItems((body as { automations: Automation[] }).automations); setStatus("ready"); }).catch(() => setStatus("error"));
  }, [request]);
  useEffect(() => {
    void request().then((body) => { setItems((body as { automations: Automation[] }).automations); setStatus("ready"); }).catch(() => setStatus("error"));
  }, [request]);
  const edit = (item: Automation) => { setEditing(item.id); setDraft({ name: item.name, kind: item.kind, instructions: item.instructions, schedule: item.schedule, timeZone: item.timeZone }); };
  const save = async () => {
    setStatus("saving");
    try {
      await request(editing ? `/${editing}` : "", { method: editing ? "PATCH" : "POST", body: JSON.stringify(draft) });
      setEditing(null); setDraft(empty()); load();
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
  return <div className="automations-settings">
    <div className="settings-panel-heading"><h3>Automations</h3><p>Run recurring reports or monitor a condition and create a chat only when it matches.</p></div>
    {status === "error" && <p className="settings-status settings-error" role="alert">Automations could not be saved or loaded.</p>}
    <div className="automation-list">
      {items.map((item) => <article className="automation-row" key={item.id}>
        <div><strong>{item.name}</strong><small>{item.kind === "report" ? "Recurring report" : "Live check"} · {item.status} · Next {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : "not scheduled"}</small></div>
        <div><button type="button" onClick={() => edit(item)}>Edit</button><button type="button" onClick={() => void mutate(item, "toggle")}>{item.status === "active" ? "Pause" : "Resume"}</button><button type="button" className="skill-danger" onClick={() => void mutate(item, "delete")}>Delete</button></div>
        {item.lastError && <p>{item.lastError}</p>}
      </article>)}
      {status === "ready" && !items.length && <p className="settings-status">No automations yet.</p>}
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
      {draft.schedule.kind === "interval" ? <label className="settings-field"><span>Every minutes</span><input type="number" min={15} value={draft.schedule.everyMinutes} onChange={(event) => setDraft({ ...draft, schedule: { kind: "interval", everyMinutes: Number(event.target.value) } })} /></label> : <label className="settings-field"><span>Local time</span><input type="time" value={draft.schedule.localTime} onChange={(event) => setDraft((current) => ({ ...current, schedule: current.schedule.kind === "weekly" ? { kind: "weekly", weekday: current.schedule.weekday, localTime: event.target.value } : { kind: current.schedule.kind === "weekdays" ? "weekdays" : "daily", localTime: event.target.value } }))} /></label>}
      {draft.schedule.kind === "weekly" && <label className="settings-field"><span>Day</span><select value={draft.schedule.weekday} onChange={(event) => setDraft((current) => ({ ...current, schedule: { kind: "weekly", localTime: current.schedule.kind === "weekly" ? current.schedule.localTime : "09:00", weekday: Number(event.target.value) } }))}>{["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>}
      <label className="settings-field"><span>Timezone</span><input value={draft.timeZone} onChange={(event) => setDraft({ ...draft, timeZone: event.target.value })} /></label>
      <div className="settings-actions automation-actions">{editing && <button className="settings-cancel" type="button" onClick={() => { setEditing(null); setDraft(empty()); }}>Cancel</button>}<button className="settings-save" type="button" disabled={status === "saving" || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()}>{status === "saving" ? "Saving…" : editing ? "Save changes" : "Create automation"}</button></div>
    </div>
  </div>;
}
