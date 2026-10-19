import React, { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";
import { useBoardPrefs, useBridgeStatus } from "../../hooks/use-maplex-board.js";

// maplex: every leaderboard extra is an opt-in/opt-out switch here.
//  - show the official board / merge my totals into it / "preview as"
//    (all local display preferences), and
//  - the Maplex → official upload bridge (server side, per account).
const STATUS_LABELS = {
  linked: () => copy("settings.officialboard.status.linked"),
  ok: () => copy("settings.officialboard.status.ok"),
  up_to_date: () => copy("settings.officialboard.status.up_to_date"),
  throttled: () => copy("settings.officialboard.status.throttled"),
  token_rejected: () => copy("settings.officialboard.status.token_rejected"),
  error: () => copy("settings.officialboard.status.error"),
};

function formatTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

const PREF_COPY = {
  showOfficialBoard: () => [copy("settings.officialboard.showOfficialBoard.label"), copy("settings.officialboard.showOfficialBoard.hint")],
  mergeSelf: () => [copy("settings.officialboard.mergeSelf.label"), copy("settings.officialboard.mergeSelf.hint")],
  previewSwitcher: () => [copy("settings.officialboard.previewSwitcher.label"), copy("settings.officialboard.previewSwitcher.hint")],
};

function PrefRow({ id, prefs, setPrefs }) {
  const [label, hint] = PREF_COPY[id]();
  return (
    <SettingsRow
      label={label}
      hint={hint}
      control={
        <ToggleSwitch
          checked={Boolean(prefs[id])}
          onChange={() => setPrefs({ [id]: !prefs[id] })}
          ariaLabel={label}
        />
      }
    />
  );
}

function BridgeRows() {
  const { available, status, run } = useBridgeStatus();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const pollTimer = useRef(null);

  const act = async (action, extra) => {
    setBusy(action);
    setError(null);
    try {
      return await run(action, extra);
    } catch (e) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const pending = status?.pending || null;
  useEffect(() => {
    if (!pending) return undefined;
    pollTimer.current = setInterval(() => { run("link_poll").catch(() => {}); }, 5000);
    return () => clearInterval(pollTimer.current);
  }, [pending, run]);

  if (!available) {
    return <SettingsRow label={copy("settings.officialboard.bridge.label")} hint={copy("settings.officialboard.bridge.unavailable")} control={null} />;
  }
  const linked = Boolean(status?.linked);
  const statusText = status?.last_status && STATUS_LABELS[status.last_status] ? STATUS_LABELS[status.last_status]() : "";
  const detail = [
    statusText,
    status?.last_relay_at ? copy("settings.officialboard.bridge.last_relay", { ts: formatTime(status.last_relay_at) }) : "",
    status?.next_allowed_at ? copy("settings.officialboard.bridge.next_allowed", { ts: formatTime(status.next_allowed_at) }) : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <SettingsRow
        label={copy("settings.officialboard.bridge.label")}
        hint={linked ? copy("settings.officialboard.bridge.hint_linked") : copy("settings.officialboard.bridge.hint")}
        control={linked ? (
          <ToggleSwitch
            checked={status.enabled !== false}
            disabled={busy !== null}
            onChange={() => act("set_enabled", { enabled: status.enabled === false })}
            ariaLabel={copy("settings.officialboard.bridge.label")}
          />
        ) : (
          <Button type="button" size="sm" onClick={() => act("link_start")} disabled={busy !== null || Boolean(pending)}>
            {busy === "link_start" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {copy("settings.officialboard.bridge.link")}
          </Button>
        )}
      />
      {pending && !linked && (
        <SettingsRow
          label={copy("settings.officialboard.bridge.code", { code: pending.user_code })}
          hint={copy("settings.officialboard.bridge.code_hint")}
          control={
            <a href={pending.verification_uri} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-oai-brand-600 underline-offset-2 hover:underline dark:text-oai-brand-400">
              {copy("settings.officialboard.bridge.open_official")}
            </a>
          }
        />
      )}
      {linked && (
        <SettingsRow
          label={copy("settings.officialboard.bridge.status_label")}
          hint={detail || null}
          control={
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => act("relay_now")} disabled={busy !== null || status.enabled === false}>
                {busy === "relay_now" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                {copy("settings.officialboard.bridge.relay_now")}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => act("unlink")} disabled={busy !== null}>
                {copy("settings.officialboard.bridge.unlink")}
              </Button>
            </div>
          }
        />
      )}
      {error && <p role="alert" className="py-2 text-xs text-red-600 dark:text-red-400">{copy("settings.officialboard.bridge.error", { error })}</p>}
    </>
  );
}

export function OfficialBoardSection() {
  const [prefs, setPrefs] = useBoardPrefs();
  return (
    <div className="space-y-4">
      <SectionCard title={copy("settings.officialboard.display_title")}>
        <PrefRow id="showOfficialBoard" prefs={prefs} setPrefs={setPrefs} />
        <PrefRow id="mergeSelf" prefs={prefs} setPrefs={setPrefs} />
        <PrefRow id="previewSwitcher" prefs={prefs} setPrefs={setPrefs} />
      </SectionCard>
      <SectionCard title={copy("settings.officialboard.bridge_title")}>
        <BridgeRows />
      </SectionCard>
    </div>
  );
}
