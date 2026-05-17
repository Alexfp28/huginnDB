/**
 * i18next setup for HuginnDB.
 *
 * Two locales ship in-bundle (English + Spanish). The active language is
 * driven by `usePreferences().prefs.ui.language` — when the user changes
 * it in Settings, the preferences store calls `setLanguage(...)` from
 * this module, which forwards to i18next. A separate effect in App.tsx
 * subscribes to the preferences store and keeps the two in sync on
 * hydration too.
 *
 * We initialise synchronously (no Suspense, no HTTP backend) so the
 * topbar renders with the right strings on first paint.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import type { AppLanguage } from "@/types";

export const SUPPORTED_LANGUAGES: AppLanguage[] = ["en", "es"];

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    // React already escapes injected values.
    escapeValue: false,
  },
  // We hand-curate a small set of keys; warning on missing keys would
  // be noisy while we incrementally migrate the rest of the UI.
  returnNull: false,
});

/** Idempotent language switch. Safe to call before `init` completes. */
export function setLanguage(lang: AppLanguage) {
  if (i18n.language !== lang) {
    void i18n.changeLanguage(lang);
  }
}

export default i18n;
