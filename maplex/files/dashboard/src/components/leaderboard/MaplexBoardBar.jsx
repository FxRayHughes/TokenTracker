import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { Select } from "../../ui/components";
import { isUserId } from "../../lib/maplex-board.js";

// maplex: leaderboard source + "preview as" controls. Switching here only
// changes what this page shows; the app's signed-in account is untouched.
const SOURCE_LABELS = {
  current: () => copy("leaderboard.maplex.source.current"),
  maplex: () => copy("leaderboard.maplex.source.maplex"),
  official: () => copy("leaderboard.maplex.source.official"),
};
const PREVIEW_LABELS = {
  self: () => copy("leaderboard.maplex.preview.self"),
  guest: () => copy("leaderboard.maplex.preview.guest"),
  custom: () => copy("leaderboard.maplex.preview.custom"),
};

export function MaplexBoardBar({ view, sources, bridge, merged, disabled }) {
  const { prefs, source, preview, rawCustomUserId, setView } = view;
  const [draftId, setDraftId] = useState(rawCustomUserId);
  useEffect(() => setDraftId(rawCustomUserId), [rawCustomUserId]);
  if (!prefs.showOfficialBoard && !prefs.previewSwitcher) return null;

  const invalidId = preview === "custom" && draftId.trim() !== "" && !isUserId(draftId);
  const commitId = () => {
    if (isUserId(draftId)) setView({ customUserId: draftId.trim() });
  };
  const officialHint = source === "official" && preview === "self"
    ? bridge?.linked
      ? copy("leaderboard.maplex.hint.linked")
      : merged
        ? copy("leaderboard.maplex.hint.merged")
        : null
    : null;

  return (
    <div className="mb-5 flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      {prefs.showOfficialBoard && (
        <div className="inline-flex h-9 shrink-0 items-center self-start rounded-full border border-oai-gray-200 p-1 dark:border-oai-gray-800">
          {sources.map((id) => (
            <button
              key={id}
              type="button"
              disabled={disabled}
              aria-pressed={source === id}
              onClick={() => setView({ source: id })}
              className={cn(
                "flex h-7 items-center rounded-full px-3 text-sm font-medium transition-colors",
                source === id
                  ? "bg-oai-gray-200 text-oai-black dark:bg-oai-gray-800 dark:text-white"
                  : "text-oai-gray-500 hover:text-oai-gray-800 dark:text-oai-gray-400 dark:hover:text-oai-gray-200",
              )}
            >
              {SOURCE_LABELS[id]()}
            </button>
          ))}
        </div>
      )}
      {prefs.previewSwitcher && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="whitespace-nowrap text-oai-gray-500 dark:text-oai-gray-400">{copy("leaderboard.maplex.preview.label")}</span>
          <Select
            value={preview}
            onValueChange={(value) => setView({ preview: String(value) })}
            disabled={disabled}
            ariaLabel={copy("leaderboard.maplex.preview.label")}
            options={["self", "guest", "custom"].map((id) => ({ value: id, label: PREVIEW_LABELS[id]() }))}
            className="px-3 py-1 text-oai-gray-700 dark:text-oai-gray-300"
          />
          {preview === "custom" && (
            <input
              type="text"
              value={draftId}
              onChange={(event) => setDraftId(event.target.value)}
              onBlur={commitId}
              onKeyDown={(event) => { if (event.key === "Enter") commitId(); }}
              placeholder={copy("leaderboard.maplex.preview.custom_placeholder")}
              aria-label={copy("leaderboard.maplex.preview.custom")}
              aria-invalid={invalidId}
              spellCheck={false}
              className={cn(
                "h-8 w-72 max-w-full rounded-md border bg-transparent px-2.5 font-mono text-xs outline-none transition-colors focus:border-oai-brand-500 dark:text-white",
                invalidId ? "border-red-400" : "border-oai-gray-300 dark:border-oai-gray-700",
              )}
            />
          )}
        </div>
      )}
      {officialHint && <span className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{officialHint}</span>}
      {source === "official" && preview === "self" && !bridge?.linked && bridge?.available && (
        <Link to="/settings?section=leaderboard" className="text-xs text-oai-brand-600 underline-offset-2 hover:underline dark:text-oai-brand-400">
          {copy("leaderboard.maplex.hint.link_cta")}
        </Link>
      )}
    </div>
  );
}
