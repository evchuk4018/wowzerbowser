"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ChatSettings } from "../chat/conversation-types";

export type UsageRange = "day" | "week" | "month" | "all";

export type SettingsUsageData = {
  summary: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    currency?: string;
  };
  bars: Array<{
    label: string;
    value: number;
    cost?: number;
  }>;
  pricing: Array<{
    model: string;
    inputPerMillion: number;
    outputPerMillion: number;
    currency?: string;
  }>;
};

export type SettingsModalProps = {
  settings: ChatSettings;
  onClose: () => void;
  onSave: (settings: ChatSettings) => void;
  loadUsage?: (range: UsageRange) => Promise<SettingsUsageData>;
};

type SettingsSection = "general" | "usage" | "models" | "api-keys" | "data";

const sections: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "usage", label: "Usage" },
  { id: "models", label: "Models" },
  { id: "api-keys", label: "API keys" },
  { id: "data", label: "Data controls" },
];

const ranges: Array<{ id: UsageRange; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All time" },
];

const numberFormat = new Intl.NumberFormat("en-US");

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value < 0.01 ? 4 : 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function GeneralSettings({
  draft,
  systemPrompt,
  onChange,
}: {
  draft: ChatSettings;
  systemPrompt: string;
  onChange: (userPresence: string) => void;
}) {
  return (
    <>
      <div className="settings-panel-heading">
        <h3>General</h3>
        <p>Customize the context used for your conversations.</p>
      </div>
      <label className="settings-field">
        <span>System prompt</span>
        <textarea value={systemPrompt} readOnly aria-readonly="true" rows={7} />
      </label>
      <label className="settings-field">
        <span>User presence</span>
        <textarea
          value={draft.userPresence}
          maxLength={12000}
          onChange={(event) => onChange(event.target.value)}
          rows={5}
          placeholder="Optional context about you"
        />
      </label>
    </>
  );
}

function UsageSettings({ loadUsage }: Pick<SettingsModalProps, "loadUsage">) {
  const [range, setRange] = useState<UsageRange>("week");
  const [response, setResponse] = useState<{
    range: UsageRange;
    usage: SettingsUsageData | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!loadUsage) return;

    let active = true;
    loadUsage(range).then(
      (result) => {
        if (!active) return;
        setResponse({ range, usage: result, failed: false });
      },
      () => {
        if (!active) return;
        setResponse({ range, usage: null, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [loadUsage, range]);

  const usage = response?.range === range ? response.usage : null;
  const status = !loadUsage
    ? "idle"
    : response?.range !== range
      ? "loading"
      : response.failed
        ? "error"
        : "idle";
  const maximum = Math.max(1, ...(usage?.bars.map(({ value }) => value) ?? []));
  const currency = usage?.summary.currency ?? "USD";

  return (
    <>
      <div className="settings-panel-heading settings-usage-heading">
        <div>
          <h3>Usage</h3>
          <p>Review token volume and estimated costs.</p>
        </div>
        <div className="settings-range" role="group" aria-label="Usage period">
          {ranges.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={range === option.id}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {status === "loading" && <p className="settings-status" role="status">Loading usage…</p>}
      {status === "error" && <p className="settings-status settings-error" role="alert">Usage could not be loaded.</p>}
      {!loadUsage && (
        <p className="settings-status">
          Usage reporting is ready to connect. Provide <code>loadUsage</code> to display account data.
        </p>
      )}

      <div className="settings-summary" aria-label="Usage summary">
        <div><span>Requests</span><strong>{numberFormat.format(usage?.summary.requests ?? 0)}</strong></div>
        <div><span>Input tokens</span><strong>{numberFormat.format(usage?.summary.inputTokens ?? 0)}</strong></div>
        <div><span>Output tokens</span><strong>{numberFormat.format(usage?.summary.outputTokens ?? 0)}</strong></div>
        <div><span>Estimated cost</span><strong>{formatCurrency(usage?.summary.estimatedCost ?? 0, currency)}</strong></div>
      </div>

      <div className="settings-chart" aria-label={`${ranges.find(({ id }) => id === range)?.label} usage chart`}>
        {usage?.bars.length ? usage.bars.map((bar) => (
          <div className="settings-bar-column" key={bar.label}>
            <button
              type="button"
              className="settings-bar-target"
              aria-label={`${bar.label}: ${numberFormat.format(bar.value)} tokens${bar.cost == null ? "" : `, ${formatCurrency(bar.cost, currency)}`}`}
            >
              <span className="settings-bar-tooltip" role="tooltip">
                <strong>{numberFormat.format(bar.value)} tokens</strong>
                {bar.cost != null && <span>{formatCurrency(bar.cost, currency)}</span>}
              </span>
              <span
                className="settings-bar"
                style={{ height: `${Math.max(4, (bar.value / maximum) * 100)}%` }}
                aria-hidden="true"
              />
            </button>
            <span className="settings-bar-label">{bar.label}</span>
          </div>
        )) : (
          <div className="settings-chart-empty">No usage in this period</div>
        )}
      </div>

      <div className="settings-pricing">
        <div className="settings-pricing-heading">
          <h4>Pricing</h4>
          <span>per 1M tokens</span>
        </div>
        <div className="settings-table-wrap">
          <table>
            <thead>
              <tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th></tr>
            </thead>
            <tbody>
              {usage?.pricing.length ? usage.pricing.map((item) => (
                <tr key={item.model}>
                  <th scope="row">{item.model}</th>
                  <td>{formatCurrency(item.inputPerMillion, item.currency)}</td>
                  <td>{formatCurrency(item.outputPerMillion, item.currency)}</td>
                </tr>
              )) : (
                <tr><td colSpan={3} className="settings-table-empty">Pricing will appear with usage data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PlaceholderSettings({ label }: { label: string }) {
  return (
    <div className="settings-placeholder">
      <span aria-hidden="true">◇</span>
      <h3>{label}</h3>
      <p>This section is coming soon.</p>
    </div>
  );
}

export function SettingsModal({ settings, onClose, onSave, loadUsage }: SettingsModalProps) {
  const [draft, setDraft] = useState(settings);
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".settings-nav-item")?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const activeLabel = sections.find(({ id }) => id === activeSection)?.label ?? "Settings";

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <div className="settings-kicker">Preferences</div>
            <h2 id={titleId}>Settings</h2>
          </div>
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className="settings-nav-item"
                aria-current={activeSection === section.id ? "page" : undefined}
                onClick={() => setActiveSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <span className="settings-mobile-title">{activeLabel}</span>
            <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>×</button>
          </header>
          <div className="settings-content">
            {activeSection === "general" && (
              <GeneralSettings
                draft={draft}
                systemPrompt={settings.systemPrompt}
                onChange={(userPresence) => setDraft((current) => ({ ...current, userPresence }))}
              />
            )}
            {activeSection === "usage" && <UsageSettings loadUsage={loadUsage} />}
            {!["general", "usage"].includes(activeSection) && <PlaceholderSettings label={activeLabel} />}
          </div>
          {activeSection === "general" && (
            <div className="settings-actions">
              <button type="button" className="settings-cancel" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="settings-save"
                onClick={() => onSave({
                  systemPrompt: settings.systemPrompt,
                  userPresence: draft.userPresence.trim(),
                })}
              >
                Save
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
