import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import {
  bridgeAvailable,
  callBridge,
  currentInstanceId,
  fetchBoard,
  getBoardPrefs,
  isUserId,
  mergeSelfIntoBoard,
  readBoardView,
  setBoardPrefs,
  subscribeBoardPrefs,
  writeBoardView,
} from "../lib/maplex-board.js";

export function useBoardPrefs() {
  const prefs = useSyncExternalStore(subscribeBoardPrefs, getBoardPrefs, getBoardPrefs);
  return [prefs, setBoardPrefs];
}

// Bridge link status (Maplex → official leaderboard), shared by the
// leaderboard page and the settings section.
let bridgeCache = { userId: null, status: null };
const bridgeListeners = new Set();
function publishBridge(userId, status) {
  bridgeCache = { userId, status };
  bridgeListeners.forEach((fn) => fn());
}
export function useBridgeStatus() {
  const { signedIn = false, user = null, getAccessToken = null } = useInsforgeAuth() || {};
  const snapshot = useSyncExternalStore(
    (fn) => { bridgeListeners.add(fn); return () => bridgeListeners.delete(fn); },
    () => bridgeCache,
    () => bridgeCache,
  );
  const enabled = signedIn && Boolean(user?.id) && bridgeAvailable();
  const run = useCallback(async (action, extra) => {
    const token = getAccessToken ? await getAccessToken() : null;
    const status = await callBridge(token, action, extra);
    publishBridge(user?.id || null, status);
    return status;
  }, [getAccessToken, user?.id]);
  useEffect(() => {
    if (!enabled || bridgeCache.userId === user.id) return;
    run(null).catch(() => publishBridge(user.id, null));
  }, [enabled, run, user?.id]);
  const status = enabled && snapshot.userId === user?.id ? snapshot.status : null;
  return { available: enabled, status, run };
}

// Which board is shown and whose point of view ("me") it is rendered for.
// Only local state: the signed-in account of the app never changes.
export function useBoardView() {
  const [prefs] = useBoardPrefs();
  const [view, setViewState] = useState(readBoardView);
  const current = currentInstanceId();
  const setView = useCallback((patch) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      writeBoardView(next);
      return next;
    });
  }, []);
  const source = prefs.showOfficialBoard && view.source ? view.source : current;
  const preview = prefs.previewSwitcher ? view.preview || "self" : "self";
  const customUserId = preview === "custom" && isUserId(view.customUserId) ? view.customUserId.trim() : "";
  const isDefault = (source === current || source === "current") && preview === "self";
  return { prefs, source, preview, customUserId, rawCustomUserId: view.customUserId || "", isDefault, current, setView };
}

export async function loadBoard({ view, bridge, cloudUserId, period, limit, offset }) {
  const native = view.source === view.current || view.source === "current";
  let userId = null;
  let merge = false;
  if (view.preview === "custom") userId = view.customUserId || null;
  else if (view.preview === "self") {
    if (native) userId = cloudUserId || null;
    else if (view.source === "official" && bridge?.linked && bridge.official_user_id) userId = bridge.official_user_id;
    else merge = view.prefs.mergeSelf && Boolean(cloudUserId);
  }
  let data = await fetchBoard(view.source, { period, limit, offset, userId });
  if (merge) {
    const mine = await fetchBoard(view.current, { period, limit: 1, offset: 0, userId: cloudUserId }).catch(() => null);
    if (mine?.me) data = await mergeSelfIntoBoard(data, mine.me, { source: view.source, period, offset, limit });
  }
  return { ...data, maplex: { source: view.source, native, merged: merge } };
}
