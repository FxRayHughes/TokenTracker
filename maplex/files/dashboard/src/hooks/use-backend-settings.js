import { useCallback, useEffect, useState } from "react";
import { isLocalDashboardHost } from "../lib/host-mode";

// maplex: read / switch the cloud backend the local CLI server talks to.
// Only meaningful where a local server exists (dashboard served by the CLI or
// embedded in the native apps); a public web deploy keeps its build backend.
const BACKEND_CONFIG_PATH = "/functions/tokentracker-backend-config";

async function authHeaders() {
  const { getLocalApiAuthHeaders } = await import("../lib/local-api-auth");
  return getLocalApiAuthHeaders();
}

function normalize(data) {
  if (!data || typeof data.choice !== "string" || !Array.isArray(data.presets)) return null;
  return data;
}

export function useBackendSettings() {
  const [available, setAvailable] = useState(false);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    if (!isLocalDashboardHost()) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(BACKEND_CONFIG_PATH, { headers: { Accept: "application/json" }, cache: "no-store" });
        const data = res.ok ? normalize(await res.json().catch(() => null)) : null;
        if (!cancelled && data) {
          setConfig(data);
          setAvailable(true);
        }
      } catch {
        /* no local server: section stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next) => {
    const res = await fetch(BACKEND_CONFIG_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(await authHeaders()) },
      cache: "no-store",
      body: JSON.stringify(next),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    const loaded = normalize(data);
    if (loaded) setConfig(loaded);
    return loaded;
  }, []);

  return { available, config, save };
}
