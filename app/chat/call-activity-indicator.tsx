"use client";

export function CallActivityIndicator() {
  return (
    <div className="call-activity-indicator" role="status" aria-label="Waiting for response">
      <span aria-hidden="true">âœ¦</span>
    </div>
  );
}
