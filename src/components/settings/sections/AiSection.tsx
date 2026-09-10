/**
 * AI settings: where the model lives, how much it is trusted, and which
 * connections it may read.
 *
 * The panel's whole argument is made here rather than in documentation, because
 * this is the screen a consultant opens before deciding whether to point the
 * feature at a client's database. Three things are therefore stated on the
 * screen and not merely enforced underneath:
 *
 * - **The endpoint's trust level is a declaration.** Nothing is sniffed; the
 *   loopback/RFC1918 guess only pre-fills, and the row that shows it says so.
 * - **The two axes are separate.** "Read-only" does not mean "nothing leaves",
 *   so the connection picker has two columns — reach and rows — and the rows
 *   column reads as checked-and-locked while the endpoint is trusted, because
 *   that is what the coupling rule actually does.
 * - **Agent mode is gated on a measurement**, not on a preference. The probe's
 *   note is shown verbatim: a paraphrase would drop the detail that identifies
 *   the misconfiguration.
 *
 * The empty state points at Settings → MCP rather than pretending this is the
 * only option, which is the honest answer to "I already pay for Claude" (see
 * `docs/AI_ROADMAP.md` §1).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { SearchField } from "@/components/ui/search-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Segmented } from "@/components/ui/segmented";
import { Spinner } from "@/components/ui/spinner";
import { PasswordInput } from "@/components/common/PasswordInput";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { guessEndpointTrust } from "@/lib/ai/endpointTrust";
import { MAX_AI_NOTES_CHARS } from "@/lib/ai/scope";
import {
  filterByScope,
  isFromOrigin,
  originIdOf,
  type ProfileScope,
} from "@/lib/connection/origin";
import { buildRailSections } from "@/lib/connection/railSections";
import { useOrigins } from "@/stores/sync/origins";
import {
  usePreferences,
  selectAiPrefs,
} from "@/stores/preferences/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type { AiProbeReport, ConnectionProfile } from "@/types";
import { PrefRow } from "./PrefRow";
import { AiConnectionTree } from "./AiConnectionTree";
import { ReasoningPicker } from "@/components/ai/ReasoningPicker";

export function AiSection() {
  const { t } = useTranslation();
  const ai = usePreferences(selectAiPrefs);
  const updateAi = usePreferences((s) => s.updateAi);
  const setSection = useSettingsDialog((s) => s.setSection);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ProfileScope>("all");
  const [probe, setProbe] = useState<AiProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  // The connection whose notes are being edited, and the draft. Kept here
  // rather than in the tree: a note is written once per database and read on
  // every question, so it is a block of its own under the list, not a control
  // repeated on every row.
  const [notesFor, setNotesFor] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  useEffect(() => {
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // Re-asked whenever the endpoint changes, because the key is stored per
  // origin: pointing the base URL at a different host is pointing it at a
  // different credential, and a stale "key stored" badge would be a lie about
  // which one is in play.
  useEffect(() => {
    void api
      .aiHasKey()
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [ai.baseUrl]);

  const shared = useMemo(() => profiles.filter(isFromOrigin), [profiles]);
  const hasShared = shared.length > 0;
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = filterByScope(profiles, scope);
    if (!q) return inScope;
    return inScope.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter, scope]);

  const originsById = useOrigins((s) => s.byId);
  const sections = useMemo(() => {
    const nameOf = (id: string) => originsById[id]?.name ?? null;
    const labels = {
      shared: (origin: string) => t("connections.sharedSection", { origin }),
      orphaned: t("connections.orphanedSection"),
    };
    return [
      ...buildRailSections(filteredProfiles, "local", nameOf, labels).map(
        (section) => ({ ...section, label: t("settings.mcp.localSection") }),
      ),
      ...buildRailSections(filteredProfiles, "shared", nameOf, labels),
    ];
  }, [filteredProfiles, originsById, t]);

  const sharedTooltip = (p: ConnectionProfile) => {
    const name = originsById[originIdOf(p) ?? ""]?.name;
    return name
      ? t("connections.sharedBadgeTooltip", { origin: name })
      : t("connections.sharedBadgeTooltipUnknown");
  };

  /** Optimistic, resynced from disk on failure — the shape `PulseSection` uses,
   *  and for the same reason it goes through a dedicated command rather than
   *  `saveProfile`: it writes the one field it means to. */
  async function writeFlag(
    ids: string[],
    field: "ai_enabled" | "ai_rows_allowed",
    value: boolean,
  ) {
    const wanted = new Set(ids);
    setProfiles((prev) =>
      prev.map((p) => (wanted.has(p.id) ? { ...p, [field]: value } : p)),
    );
    try {
      if (field === "ai_enabled") await api.setAiEnabled(ids, value);
      else await api.setAiRowsAllowed(ids, value);
    } catch (e) {
      notify.error(String(e));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /** The connections a note could be written for: the ones it can reach. */
  const notable = useMemo(
    () => profiles.filter((p) => p.ai_enabled),
    [profiles],
  );

  // Follow the list: the first enabled connection when nothing is selected,
  // and away from one the user just switched off (its notes are kept on disk,
  // they are simply not in play).
  useEffect(() => {
    if (notable.length === 0) {
      if (notesFor) setNotesFor("");
      return;
    }
    if (notable.some((p) => p.id === notesFor)) return;
    const next = notable[0];
    setNotesFor(next.id);
    setNotesDraft(next.ai_notes ?? "");
  }, [notable, notesFor]);

  /**
   * Persist the draft, on blur.
   *
   * On blur rather than on every keystroke: this is prose, a debounce would
   * write a dozen half-sentences to `profiles.json`, and there is no reactive
   * consumer that needs it sooner — the next turn reads the profile fresh.
   */
  async function saveNotes() {
    const profile = profiles.find((p) => p.id === notesFor);
    if (!profile) return;
    const next = notesDraft.trim();
    if ((profile.ai_notes ?? "") === next) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === profile.id ? { ...p, ai_notes: next } : p)),
    );
    try {
      await api.setAiNotes(profile.id, next);
    } catch (e) {
      notify.error(String(e));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  async function runProbe() {
    setProbing(true);
    try {
      setProbe(await api.aiProbe(true));
    } catch (e) {
      // Only a *configuration* error lands here — an unreachable endpoint comes
      // back as a report, not a rejection.
      notify.error(String(e));
      setProbe(null);
    } finally {
      setProbing(false);
    }
  }

  const capability = probe?.capability.kind;
  const toolCapable = capability === "toolCapable";
  const guessed = guessEndpointTrust(ai.baseUrl);
  const trustDiffersFromGuess = guessed !== ai.endpointTrust;

  const numeric =
    (apply: (n: number) => void, min: number, max: number) => (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= min && n <= max) apply(n);
    };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[12px] text-muted-foreground">
        {t("settings.ai.intro")}
      </p>

      <div className="space-y-1">
        <PrefRow
          label={t("settings.ai.enabled.label")}
          prefId="ai.enabled"
          description={t("settings.ai.enabled.desc")}
        >
          <Switch
            checked={ai.enabled}
            onCheckedChange={(v) => updateAi({ enabled: v })}
            aria-label={t("settings.ai.enabled.label")}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.ai.baseUrl.label")}
          prefId="ai.baseUrl"
          description={t("settings.ai.baseUrl.desc")}
          htmlFor="prefs-ai-base-url"
        >
          <Input
            id="prefs-ai-base-url"
            value={ai.baseUrl}
            spellCheck={false}
            placeholder="http://localhost:11434/v1"
            onChange={(e) => updateAi({ baseUrl: e.target.value })}
            className="h-8 w-64 font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.ai.model.label")}
          prefId="ai.model"
          description={t("settings.ai.model.desc")}
          htmlFor="prefs-ai-model"
        >
          {probe && probe.models.length > 0 ? (
            <NativeSelect
              id="prefs-ai-model"
              size="sm"
              mono
              value={ai.model}
              onChange={(e) => updateAi({ model: e.target.value })}
              className="w-64"
            >
              <option value="">{t("settings.ai.modelPlaceholder")}</option>
              {probe.models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </NativeSelect>
          ) : (
            <Input
              id="prefs-ai-model"
              value={ai.model}
              spellCheck={false}
              placeholder={t("settings.ai.modelPlaceholder")}
              onChange={(e) => updateAi({ model: e.target.value })}
              className="h-8 w-64 font-mono text-xs"
            />
          )}
        </PrefRow>

        <PrefRow
          label={t("settings.ai.trust.label")}
          prefId="ai.endpointTrust"
          description={t("settings.ai.trust.desc")}
        >
          <Segmented
            size="sm"
            value={ai.endpointTrust}
            onValueChange={(v) => updateAi({ endpointTrust: v })}
            aria-label={t("settings.ai.trust.label")}
            options={[
              {
                value: "untrusted",
                label: t("settings.ai.trust.untrusted"),
              },
              { value: "trusted", label: t("settings.ai.trust.trusted") },
            ]}
          />
        </PrefRow>
        {trustDiffersFromGuess && (
          <p className="px-1 text-[12px] text-muted-foreground">
            {guessed === "trusted"
              ? t("settings.ai.trust.looksLocal")
              : t("settings.ai.trust.looksRemote")}
          </p>
        )}

        <PrefRow
          label={t("settings.ai.mode.label")}
          prefId="ai.mode"
          description={t("settings.ai.mode.desc")}
        >
          <Segmented
            size="sm"
            value={ai.mode}
            onValueChange={(v) => updateAi({ mode: v })}
            aria-label={t("settings.ai.mode.label")}
            options={[
              { value: "assisted", label: t("settings.ai.mode.assisted") },
              { value: "agent", label: t("settings.ai.mode.agent") },
            ]}
          />
        </PrefRow>
        {ai.mode === "agent" && probe && !toolCapable && (
          <p className="px-1 text-[12px] text-amber-500">
            {t("settings.ai.mode.notToolCapable")}
          </p>
        )}

        <PrefRow
          label={t("settings.ai.maxContextRows.label")}
          prefId="ai.maxContextRows"
          description={t("settings.ai.maxContextRows.desc")}
          htmlFor="prefs-ai-max-context-rows"
        >
          <Input
            id="prefs-ai-max-context-rows"
            type="number"
            min={1}
            max={1000}
            value={ai.maxContextRows}
            onChange={(e) =>
              numeric((n) => updateAi({ maxContextRows: n }), 1, 1000)(
                e.target.value,
              )
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.ai.reasoningEffort.label")}
          prefId="ai.reasoningEffort"
          description={t("settings.ai.reasoningEffort.desc")}
        >
          {/* The same control the panel's composer carries, rather than a
              second vocabulary for one setting: a slider here and a dropdown
              there would leave the two surfaces disagreeing about what the
              choice even is. */}
          <ReasoningPicker
            value={ai.reasoningEffort}
            onChange={(reasoningEffort) => updateAi({ reasoningEffort })}
          />
        </PrefRow>

        <PrefRow
          label={t("settings.ai.requestTimeoutSecs.label")}
          prefId="ai.requestTimeoutSecs"
          description={t("settings.ai.requestTimeoutSecs.desc")}
          htmlFor="prefs-ai-timeout"
        >
          <Input
            id="prefs-ai-timeout"
            type="number"
            min={5}
            max={3600}
            step={5}
            value={ai.requestTimeoutSecs}
            onChange={(e) =>
              numeric((n) => updateAi({ requestTimeoutSecs: n }), 5, 3600)(
                e.target.value,
              )
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            {t("settings.ai.keyLabel")}
          </span>
          {hasKey && (
            <Badge tone="success" size="xs">
              {t("settings.ai.keyStored")}
            </Badge>
          )}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {t("settings.ai.keyHint")}
        </p>
        <div className="flex items-center gap-1.5">
          <PasswordInput
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={
              hasKey
                ? t("settings.ai.keyReplacePlaceholder")
                : t("settings.ai.keyPlaceholder")
            }
            className="h-8 flex-1 font-mono text-xs"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={keyDraft.trim().length === 0}
            onClick={() => {
              void api
                .aiSetKey(keyDraft)
                .then(() => {
                  setKeyDraft("");
                  setHasKey(true);
                })
                .catch((e) => notify.error(String(e)));
            }}
          >
            {t("common.save")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            disabled={!hasKey}
            onClick={() => {
              void api
                .aiClearKey()
                .then(() => setHasKey(false))
                .catch((e) => notify.error(String(e)));
            }}
          >
            {t("settings.ai.keyClear")}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            {t("settings.ai.probeLabel")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-2xs"
            disabled={probing || !ai.enabled}
            onClick={() => void runProbe()}
          >
            {probing ? <Spinner className="h-3 w-3" /> : null}
            {t("settings.ai.probeRun")}
          </Button>
        </div>
        {probe ? (
          <div className="space-y-1 rounded-md border border-border px-3 py-2">
            <Badge
              tone={
                capability === "toolCapable"
                  ? "success"
                  : capability === "chatOnly"
                    ? "warning"
                    : "destructive"
              }
              size="xs"
            >
              {t(`settings.ai.capability.${probe.capability.kind}`)}
            </Badge>
            {/* Verbatim: a paraphrase loses the one detail that identifies the
                misconfiguration. */}
            <p className="text-[12px] text-muted-foreground">{probe.note}</p>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            {ai.enabled
              ? t("settings.ai.probeUntested")
              : t("settings.ai.probeDisabled")}
          </p>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-2xs uppercase tracking-wider text-muted-foreground">
            {t("settings.ai.connectionsLabel")}
          </span>
          {profiles.length > 0 && (
            <span className="text-2xs text-muted-foreground">
              {t("settings.ai.enabledCount", {
                enabled: profiles.filter((p) => p.ai_enabled).length,
                total: profiles.length,
              })}
            </span>
          )}
        </div>
        <p className="mb-1.5 text-[12px] text-muted-foreground">
          {t("settings.ai.connectionsHint")}
        </p>

        {profiles.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t("settings.ai.noConnections")}
          </p>
        ) : (
          <>
            {hasShared && (
              <Segmented
                size="sm"
                variant="underline"
                className="mb-1.5"
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "all",
                    label: `${t("settings.mcp.scopeAll")} ${profiles.length}`,
                  },
                  {
                    value: "local",
                    label: `${t("connections.scope.local")} ${
                      profiles.length - shared.length
                    }`,
                  },
                  {
                    value: "shared",
                    label: `${t("connections.scope.shared")} ${shared.length}`,
                  },
                ]}
                aria-label={t("connections.scopeLabel")}
              />
            )}
            <div className="mb-1.5 flex items-center gap-1.5">
              <SearchField
                size="xs"
                value={filter}
                onValueChange={setFilter}
                placeholder={t("settings.mcp.filterPlaceholder")}
                onClear={() => setFilter("")}
                clearLabel={t("common.clear")}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-2xs"
                disabled={filteredProfiles.length === 0}
                onClick={() =>
                  void writeFlag(
                    filteredProfiles.map((p) => p.id),
                    "ai_enabled",
                    !filteredProfiles.every((p) => p.ai_enabled),
                  )
                }
              >
                {filteredProfiles.every((p) => p.ai_enabled)
                  ? t("settings.ai.disableAll")
                  : t("settings.ai.enableAll")}
              </Button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {filteredProfiles.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-muted-foreground">
                  {t("settings.mcp.noMatches", { query: filter })}
                </p>
              ) : (
                <AiConnectionTree
                  sections={sections}
                  trust={ai.endpointTrust}
                  onToggleEnabled={(p) =>
                    void writeFlag([p.id], "ai_enabled", !p.ai_enabled)
                  }
                  onToggleEnabledAll={(ids, enabled) =>
                    void writeFlag(ids, "ai_enabled", enabled)
                  }
                  onToggleRows={(p) =>
                    void writeFlag([p.id], "ai_rows_allowed", !p.ai_rows_allowed)
                  }
                  sharedTooltip={sharedTooltip}
                  searching={filter.trim().length > 0}
                />
              )}
            </div>
            {/* The one piece of context no tool can discover. A model can read
                every table and still not know which of two similar ones is
                live — see `ConnectionProfile::ai_notes`. */}
            <div className="mt-3 space-y-1.5 border-t border-border pt-3">
              <p className="text-[12px] font-medium">
                {t("settings.ai.notesTitle")}
              </p>
              <p className="text-2xs text-muted-foreground">
                {t("settings.ai.notesHint")}
              </p>
              {notable.length === 0 ? (
                <p className="text-2xs text-muted-foreground">
                  {t("settings.ai.notesNone")}
                </p>
              ) : (
                <>
                  <NativeSelect
                    size="xs"
                    aria-label={t("settings.ai.notesConnection")}
                    value={notesFor}
                    onChange={(e) => {
                      // Save what is on screen before moving: switching the
                      // selector is the same gesture as leaving the field.
                      void saveNotes();
                      const next = e.target.value;
                      setNotesFor(next);
                      setNotesDraft(
                        profiles.find((p) => p.id === next)?.ai_notes ?? "",
                      );
                    }}
                  >
                    {notable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onBlur={() => void saveNotes()}
                    maxLength={MAX_AI_NOTES_CHARS}
                    rows={5}
                    spellCheck={false}
                    className="font-mono text-2xs"
                    placeholder={t("settings.ai.notesPlaceholder")}
                  />
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="space-y-1 rounded-md border border-dashed border-border px-3 py-2">
        <p className="text-[12px] text-muted-foreground">
          {t("settings.ai.mcpAlternative")}
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-[12px]"
          onClick={() => setSection("mcp")}
        >
          {t("settings.ai.mcpAlternativeLink")}
        </Button>
      </div>
    </div>
  );
}
