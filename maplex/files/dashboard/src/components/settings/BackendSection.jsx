import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SegmentedControl, SettingsRow, SETTINGS_INPUT_CLASS } from "./Controls.jsx";

// maplex: choose which TokenTracker cloud backend this installation syncs to.
// Switching changes the backend instance; the local server then clears the
// previous instance's device token and session, so the user signs in again.
// Local usage data on this machine is never deleted.
function draftFrom(config) {
  return {
    choice: config.choice,
    baseUrl: config.custom?.baseUrl || "",
    anonKey: config.custom?.anonKey || "",
    dashboardUrl: config.custom?.dashboardUrl || "",
  };
}

const PRESET_LABELS = {
  maplex: () => copy("settings.backend.preset.maplex"),
  official: () => copy("settings.backend.preset.official"),
  custom: () => copy("settings.backend.preset.custom"),
};

export function BackendSection({ backendSettings }) {
  const { config, save } = backendSettings;
  const [draft, setDraft] = useState(() => draftFrom(config));
  const [state, setState] = useState({ status: "idle", error: null });

  useEffect(() => {
    setDraft(draftFrom(config));
  }, [config]);

  const options = config.presets.map((preset) => ({
    value: preset.id,
    label: PRESET_LABELS[preset.id] ? PRESET_LABELS[preset.id]() : preset.id,
  }));
  const selectedPreset = config.presets.find((preset) => preset.id === draft.choice);
  const dirty =
    draft.choice !== config.choice ||
    (draft.choice === "custom" &&
      (draft.baseUrl !== (config.custom?.baseUrl || "") ||
        draft.anonKey !== (config.custom?.anonKey || "") ||
        draft.dashboardUrl !== (config.custom?.dashboardUrl || "")));

  const onSave = async () => {
    setState({ status: "saving", error: null });
    try {
      await save(draft.choice === "custom"
        ? { choice: "custom", baseUrl: draft.baseUrl.trim(), anonKey: draft.anonKey.trim(), dashboardUrl: draft.dashboardUrl.trim() }
        : { choice: draft.choice });
      setState({ status: "saved", error: null });
      // The dashboard reads the backend from /api/runtime-config.js at load.
      setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setState({ status: "error", error: error?.message || String(error) });
    }
  };

  function renderInput(key, placeholder) {
    return <input
      type="text"
      value={draft[key]}
      onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-label={copy(`settings.backend.${key}.label`)}
      className={`${SETTINGS_INPUT_CLASS} sm:w-80`}
    />;
  }
  const customFields = draft.choice === "custom";
  const presetRow = !customFields && selectedPreset;

  return (
    <SectionCard title={copy("settings.section.backend")} subtitle={copy("settings.backend.current", { url: config.active.baseUrl })}>
      <SettingsRow
        label={copy("settings.backend.choice.label")}
        hint={copy("settings.backend.choice.hint")}
        control={<SegmentedControl options={options} value={draft.choice} onChange={(choice) => setDraft((prev) => ({ ...prev, choice }))} />}
      />
      {customFields && (
        <>
          <SettingsRow label={copy("settings.backend.baseUrl.label")} control={renderInput("baseUrl", "https://")} />
          <SettingsRow label={copy("settings.backend.anonKey.label")} hint={copy("settings.backend.anonKey.hint")} control={renderInput("anonKey", "")} />
          <SettingsRow label={copy("settings.backend.dashboardUrl.label")} control={renderInput("dashboardUrl", "https://")} />
        </>
      )}
      {presetRow && (
        <SettingsRow label={copy("settings.backend.baseUrl.label")} control={<code className="text-xs text-oai-gray-600 dark:text-oai-gray-300">{selectedPreset.baseUrl}</code>} />
      )}
      <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {state.status === "error"
            ? <span role="alert" className="text-red-600 dark:text-red-400">{copy("settings.backend.save_error", { error: state.error })}</span>
            : state.status === "saved"
              ? copy("settings.backend.saved")
              : copy("settings.backend.relogin_hint")}
        </p>
        <Button type="button" size="sm" onClick={onSave} disabled={!dirty || state.status === "saving"}>
          {state.status === "saving" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {copy("settings.backend.save")}
        </Button>
      </div>
    </SectionCard>
  );
}
