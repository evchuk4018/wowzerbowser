"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  UsageModelSummary,
  UsageRange,
  UsageReport,
} from "../../lib/usage-protocol";
import type { ChatSettings } from "../chat/conversation-types";

export type SettingsModalProps = {
  settings: ChatSettings;
  onClose: () => void;
  onSave: (settings: ChatSettings) => void;
  loadUsage?: (range: UsageRange) => Promise<UsageReport>;
};

type SettingsSection =
  | "general"
  | "usage"
  | "notifications"
  | "personalization"
  | "plugins"
  | "voice"
  | "storage"
  | "safety"
  | "security"
  | "account"
  | "keyboard";

type SettingsSectionIcon =
  | "sliders" | "chart" | "bell" | "sparkles" | "puzzle" | "mic"
  | "database" | "shield" | "lock" | "user" | "keyboard";

const sections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: SettingsSectionIcon;
}> = [
  { id: "general", label: "General", description: "Core preferences and context", icon: "sliders" },
  { id: "usage", label: "Usage", description: "Tokens, costs, and activity", icon: "chart" },
  { id: "notifications", label: "Notifications", description: "Alerts and updates", icon: "bell" },
  { id: "personalization", label: "Personalization", description: "Tailor your experience", icon: "sparkles" },
  { id: "plugins", label: "Plugins", description: "Connected tools and services", icon: "puzzle" },
  { id: "voice", label: "Voice", description: "Speech and audio controls", icon: "mic" },
  { id: "storage", label: "Storage", description: "Data and saved content", icon: "database" },
  { id: "safety", label: "Safety", description: "Content and privacy controls", icon: "shield" },
  { id: "security", label: "Security and login", description: "Access and authentication", icon: "lock" },
  { id: "account", label: "Account", description: "Profile and account details", icon: "user" },
  { id: "keyboard", label: "Keyboard", description: "Shortcuts and navigation", icon: "keyboard" },
];

function SectionIcon({ icon }: { icon: SettingsSectionIcon }) {
  const paths: Record<SettingsSectionIcon, ReactNode> = {
    sliders: <><path d="M4 6h10M18 6h2M14 4v4M4 18h2M10 18h10M8 16v4M4 12h4M12 12h8M10 10v4" /></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    sparkles: <><path d="m12 3-1.2 3.8L7 8l3.8 1.2L12 13l1.2-3.8L17 8l-3.8-1.2L12 3ZM5 14l-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8L5 14ZM19 13l-.6 1.4L17 15l1.4.6L19 17l.6-1.4L21 15l-1.4-.6L19 13Z" /></>,
    puzzle: <path d="M19 13h-2.2a2.8 2.8 0 1 0-5.6 0H9V9H5V5h4V2.8a2.8 2.8 0 1 1 5.6 0V5H19v4h2.2a2.8 2.8 0 1 1 0 5.6H19V19h-4v2.2a2.8 2.8 0 1 1-5.6 0V19H5v-4h4" />,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
    shield: <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" />,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 22a8 8 0 0 1 16 0" /></>,
    keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h4M7 16h10" /></>,
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[icon]}
    </svg>
  );
}

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

function providerLabel(provider: string) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function modelBreakdownLabel(models: UsageModelSummary[]) {
  return models
    .map(({ provider, label, totalTokens }) =>
      `${providerLabel(provider)} ${label}: ${numberFormat.format(totalTokens)} tokens`)
    .join("; ");
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
    usage: UsageReport | null;
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
  const maximumCost = Math.max(
    Number.EPSILON,
    ...(usage?.buckets.map(({ costUsd }) => costUsd) ?? []),
  );
  const totals = usage?.totals;

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

      {status === "loading" && <p className="settings-status" role="status">Loading usage...</p>}
      {status === "error" && <p className="settings-status settings-error" role="alert">Usage could not be loaded.</p>}
      {!loadUsage && (
        <p className="settings-status">
          Usage reporting is ready to connect. Provide <code>loadUsage</code> to display account data.
        </p>
      )}

      <div className="settings-chart" aria-label={`${ranges.find(({ id }) => id === range)?.label} usage chart`}>
        {usage?.buckets.length ? usage.buckets.map((bucket) => {
          const breakdown = modelBreakdownLabel(bucket.models);
          const indicators = [
            bucket.estimatedRequestCount
              ? `${numberFormat.format(bucket.estimatedRequestCount)} estimated`
              : "",
            bucket.unpricedRequestCount
              ? `${numberFormat.format(bucket.unpricedRequestCount)} unpriced`
              : "",
          ].filter(Boolean).join(", ");
          return (
            <div className="settings-bar-column" key={bucket.key}>
              <button
                type="button"
                className="settings-bar-target"
                aria-label={`${bucket.label}: ${formatCurrency(bucket.costUsd)}, ${numberFormat.format(bucket.totalTokens)} tokens${breakdown ? `. ${breakdown}` : ""}${indicators ? `. ${indicators}` : ""}`}
              >
                <span className="settings-bar-tooltip" role="tooltip">
                  <span className="settings-tooltip-heading">
                    <strong>{bucket.label}</strong>
                    <span>{formatCurrency(bucket.costUsd)}</span>
                  </span>
                  <span className="settings-tooltip-total">{numberFormat.format(bucket.totalTokens)} tokens</span>
                  {bucket.models.map((model) => (
                    <span className="settings-tooltip-model" key={`${model.provider}:${model.model}`}>
                      <span>{providerLabel(model.provider)} / {model.label}</span>
                      <strong>{numberFormat.format(model.totalTokens)}</strong>
                    </span>
                  ))}
                  {!!(bucket.estimatedRequestCount || bucket.unpricedRequestCount) && (
                    <span className="settings-tooltip-flags">
                      {!!bucket.estimatedRequestCount && <span>{bucket.estimatedRequestCount} estimated</span>}
                      {!!bucket.unpricedRequestCount && <span>{bucket.unpricedRequestCount} unpriced</span>}
                    </span>
                  )}
                </span>
                <span
                  className="settings-bar"
                  style={{ height: `${Math.max(4, (bucket.costUsd / maximumCost) * 100)}%` }}
                  aria-hidden="true"
                />
              </button>
              <span className="settings-bar-label">{bucket.label}</span>
            </div>
          );
        }) : (
          <div className="settings-chart-empty">No usage in this period</div>
        )}
      </div>

      <div className="settings-summary" aria-label="Usage summary">
        <div><span>Provider calls</span><strong>{numberFormat.format(totals?.requestCount ?? 0)}</strong></div>
        <div><span>Input tokens</span><strong>{numberFormat.format(totals?.promptTokens ?? 0)}</strong></div>
        <div><span>Output tokens</span><strong>{numberFormat.format(totals?.completionTokens ?? 0)}</strong></div>
        <div>
          <span>Estimated cost</span>
          <strong>{formatCurrency(totals?.costUsd ?? 0)}</strong>
          {!!totals?.unpricedRequestCount && <small>Partial / {totals.unpricedRequestCount} unpriced</small>}
        </div>
      </div>
      {!!(totals?.estimatedRequestCount || totals?.unpricedRequestCount) && (
        <div className="settings-usage-flags" aria-label="Usage data notes">
          {!!totals.estimatedRequestCount && (
            <span><i aria-hidden="true">~</i>{numberFormat.format(totals.estimatedRequestCount)} estimated</span>
          )}
          {!!totals.unpricedRequestCount && (
            <span><i aria-hidden="true">!</i>{numberFormat.format(totals.unpricedRequestCount)} unpriced</span>
          )}
        </div>
      )}

      <div className="settings-pricing">
        <div className="settings-pricing-heading">
          <h4>Pricing</h4>
          <span>per 1M tokens</span>
        </div>
        <div className="settings-table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Model</th>
                <th scope="col">Input</th>
                <th scope="col">Cached input</th>
                <th scope="col">Output</th>
              </tr>
            </thead>
            <tbody>
              {usage?.pricing.length ? usage.pricing.map((item) => (
                <tr key={`${item.provider}:${item.model}`}>
                  <td>{providerLabel(item.provider)}</td>
                  <th scope="row">{item.label}</th>
                  <td>{formatCurrency(item.inputUsdPerMillion)}</td>
                  <td>{item.cachedInputUsdPerMillion == null ? "N/A" : formatCurrency(item.cachedInputUsdPerMillion)}</td>
                  <td>{formatCurrency(item.outputUsdPerMillion)}</td>
                </tr>
              )) : (
                <tr><td colSpan={5} className="settings-table-empty">Pricing will appear with usage data.</td></tr>
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const navigationId = useId();

  useEffect(() => {
    const initialFocusSelector = window.matchMedia("(max-width: 700px)").matches
      ? ".settings-menu-toggle"
      : ".settings-nav-item";
    dialogRef.current?.querySelector<HTMLButtonElement>(initialFocusSelector)?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const mobileViewport = window.matchMedia("(max-width: 700px)").matches;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) =>
        !element.hasAttribute("hidden")
        && !(mobileViewport && !mobileMenuOpen && element.closest(".settings-sidebar")),
      );
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
  }, [onClose, mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    dialogRef.current
      ?.querySelector<HTMLButtonElement>('.settings-nav-item[aria-current="page"]')
      ?.focus();
  }, [mobileMenuOpen]);

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
        <aside className={`settings-sidebar${mobileMenuOpen ? " settings-sidebar-open" : ""}`}>
          <div className="settings-brand">
            <div className="settings-kicker">Preferences</div>
            <h2 id={titleId}>Settings</h2>
          </div>
          <nav id={navigationId} className="settings-nav" aria-label="Settings sections">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className="settings-nav-item"
                aria-current={activeSection === section.id ? "page" : undefined}
                onClick={() => {
                  setActiveSection(section.id);
                  setMobileMenuOpen(false);
                  requestAnimationFrame(() => {
                    if (!window.matchMedia("(max-width: 700px)").matches) return;
                    dialogRef.current?.querySelector<HTMLButtonElement>(".settings-menu-toggle")?.focus();
                  });
                }}
              >
                <span className="settings-nav-icon"><SectionIcon icon={section.icon} /></span>
                <span className="settings-nav-copy">
                  <span className="settings-nav-label">{section.label}</span>
                  <span className="settings-nav-description">{section.description}</span>
                </span>
                <svg className="settings-nav-chevron" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m7.5 4.5 5 5-5 5" />
                </svg>
              </button>
            ))}
          </nav>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <button
              type="button"
              className="settings-menu-toggle"
              aria-controls={navigationId}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              Sections
            </button>
            <span className="settings-mobile-title">{activeLabel}</span>
            <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
              &times;
            </button>
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
