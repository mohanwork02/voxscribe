import { useEffect } from "react";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%235f6773'/%3E%3Cpath d='M18 18h10l8 24 8-24h10L38 50h-12z' fill='white'/%3E%3C/svg%3E";

const TAB_TOKEN_STORAGE_KEY = "voxscribe_tab_token";
const TAB_TOKEN_HEADER_NAME = "x-voxscribe-tab";

export function usePageMeta(title) {
  useEffect(() => {
    document.title = title;

    let favicon = document.querySelector("link[rel='icon']");

    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }

    favicon.type = "image/svg+xml";
    favicon.href = FAVICON;
  }, [title]);
}

export function getTabToken() {
  try {
    return String(window.sessionStorage.getItem(TAB_TOKEN_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function getOrCreateTabToken() {
  const existing = getTabToken();

  if (existing) {
    return existing;
  }

  let token = "";

  try {
    token = window.crypto?.randomUUID?.() || "";
  } catch {
    token = "";
  }

  if (!token) {
    token = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  try {
    window.sessionStorage.setItem(TAB_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore
  }

  return token;
}

export function clearTabToken() {
  try {
    window.sessionStorage.removeItem(TAB_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function readJson(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function apiJson(url, options = {}) {
  const tabToken = getOrCreateTabToken();
  const headers = {
    ...(options.headers || {}),
    [TAB_TOKEN_HEADER_NAME]: tabToken,
  };

  const response = await fetch(url, { ...options, headers });
  const data = await readJson(response);
  return { response, data };
}

export function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
