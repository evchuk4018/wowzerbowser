"use client";

import { useEffect, useId, useRef, useState } from "react";
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
  | "storage"
  | "safety"
  | "security"
  | "account"
  | "keyboard";

const sections: Array<{ id: SettingsSection; label: string; description: string; icon: string }> = [
  { id: "general", label: "General", description: "Conversation context and app preferences.", icon: "⚙" },
  { id: "usage", label: "Usage", description: "Review token volume and estimated costs.", icon: "◫" },
  { id: "notifications", label: "Notifications", description: "Choose how and when you get updates.", icon: "♢" },
  { id: "personalization", label: "Personalization", description: "Shape how the experience works for you.", icon: "✦" },
  { id: "plugins", label: "Plugins", description: "Manage connected tools and extensions.", icon: "⌘" },
  { id: "storage", label: "Storage", description: "Review stored data and retention options.", icon: "▱" },
  { id: "safety", label: "Safety", description: "Control safeguards and content preferences.", icon: "◇" },
  { id: "security", label: "Security and login", description: "Protect your account and active sessions.", icon: "⌾" },
  { id: "account", label: "Account", description: "Manage your profile and account details.", icon: "◎" },
  { id: "keyboard", label: "Keyboard", description: "View and customize keyboard shortcuts.", icon: "⌨" },
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

      {usage && (
        <>
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
                  {usage.pricing.length ? usage.pricing.map((item) => (
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
      )}
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
  const [showIndex, setShowIndex] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
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

  useEffect(() => {
    const selector = showIndex
      ? `.settings-section-card[data-section="${activeSection}"]`
      : ".settings-sections-button";
    dialogRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [activeSection, showIndex]);

  const activeLabel = sections.find(({ id }) => id === activeSection)?.label ?? "Settings";
  const openSection = (section: SettingsSection) => {
    setActiveSection(section);
    setShowIndex(false);
  };
  const returnToIndex = () => {
    setShowIndex(true);
  };

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
        <div className="settings-main">
          <header className="settings-header">
            {!showIndex && (
              <button type="button" className="settings-sections-button" onClick={returnToIndex}>
                <span aria-hidden="true">←</span> Sections
              </button>
            )}
            <h2 id={titleId}>{showIndex ? "Settings" : activeLabel}</h2>
            <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
              &times;
            </button>
          </header>
          <div className="settings-content">
            {showIndex ? (
              <div className="settings-section-grid" aria-label="Settings sections">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="settings-section-card"
                    data-section={section.id}
                    aria-current={activeSection === section.id ? "page" : undefined}
                    onClick={() => openSection(section.id)}
                  >
                    <span className="settings-card-icon" aria-hidden="true">{section.icon}</span>
                    <span className="settings-card-copy">
                      <strong>{section.label}</strong>
                      <span>{section.description}</span>
                    </span>
                    <span className="settings-card-arrow" aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
            ) : activeSection === "general" ? (
              <GeneralSettings
                draft={draft}
                systemPrompt={settings.systemPrompt}
                onChange={(userPresence) => setDraft((current) => ({ ...current, userPresence }))}
              />
            ) : activeSection === "usage" ? (
              <UsageSettings loadUsage={loadUsage} />
            ) : (
              <PlaceholderSettings label={activeLabel} />
            )}
          </div>
          {(showIndex || activeSection === "general") && (
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
