/**
 * Picks which variants of a VS Code extension become the two halves of one
 * HuginnDB theme family.
 *
 * The dialog exists because the units do not match. An extension contributes
 * a LIST of colour themes — nine in GitHub Theme, six in Gruvbox, five in One
 * Dark Pro — while a `ThemeFamily` is exactly one light palette plus one dark
 * one. There is no reliable way to guess the intended pairing: `uiTheme` says
 * which side a variant belongs on, but "Gruvbox Dark Hard" and "Gruvbox Light
 * Medium" are no more each other's counterpart than any other pair in the
 * list. So the user pairs them, with the sides pre-selected to the first
 * candidate of each so the common case is one click.
 *
 * It also sets expectations before anything is committed. The preview swatches
 * are the DERIVED chrome palette, not the theme's own workbench colours (see
 * `lib/vscodeTheme/map.ts`), and that is exactly what the user needs to see:
 * the editor will look like the theme they chose, while the app around it is
 * a reading of it. Showing that here, rather than after the theme is applied,
 * is the difference between a documented derivation and a surprise.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildThemeImport,
  describeVariants,
  type ThemeImportResult,
  type VsixPayload,
} from "@/lib/vscodeTheme";
import type { ThemeColors } from "@/lib/themes";

interface Props {
  /** `null` closes the dialog — the caller owns the picked-file lifecycle. */
  payload: VsixPayload | null;
  onCancel: () => void;
  onConfirm: (result: ThemeImportResult) => void;
}

/** Sentinel for "this side has no variant of its own". Radix `Select` cannot
 *  hold an empty string as a value, so the absence needs a name. */
const NONE = "__none__";

/** The tokens worth previewing: one from each group in the Appearance editor,
 *  which is enough to tell a warm theme from a cold one at a glance without
 *  turning the dialog into a second colour editor. */
const PREVIEW_TOKENS: (keyof ThemeColors)[] = [
  "background",
  "card",
  "accent",
  "brand",
  "success",
  "warning",
  "destructive",
  "border",
];

export function ImportVsCodeThemeDialog({ payload, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const variants = useMemo(() => (payload ? describeVariants(payload) : []), [payload]);
  const lightVariants = variants.filter((v) => v.side === "light");
  const darkVariants = variants.filter((v) => v.side === "dark");

  const [lightPath, setLightPath] = useState<string>(() => lightVariants[0]?.path ?? NONE);
  const [darkPath, setDarkPath] = useState<string>(() => darkVariants[0]?.path ?? NONE);
  const [name, setName] = useState<string>(() => payload?.displayName ?? "");

  const selection = {
    lightPath: lightPath === NONE ? undefined : lightPath,
    darkPath: darkPath === NONE ? undefined : darkPath,
    name,
  };

  // Building is cheap and pure, so the preview IS the result — there is no
  // second code path that could disagree with what gets committed.
  const preview = useMemo(() => {
    if (!payload) return null;
    try {
      return buildThemeImport(payload, selection);
    } catch {
      return null;
    }
    // `selection` is rebuilt every render; its three fields are the real deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, lightPath, darkPath, name]);

  if (!payload) return null;

  const attribution = [payload.identifier, payload.version && `v${payload.version}`, payload.license]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent tier="panel" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.appearance.vscodeImport.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.appearance.vscodeImport.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {attribution && (
            <p className="text-xs text-muted-foreground">{attribution}</p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="vscode-theme-name">
              {t("settings.appearance.vscodeImport.name")}
            </Label>
            <Input
              id="vscode-theme-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <VariantPicker
              label={t("settings.appearance.vscodeImport.lightVariant")}
              value={lightPath}
              onChange={setLightPath}
              options={lightVariants}
              noneLabel={t("settings.appearance.vscodeImport.noVariant")}
            />
            <VariantPicker
              label={t("settings.appearance.vscodeImport.darkVariant")}
              value={darkPath}
              onChange={setDarkPath}
              options={darkVariants}
              noneLabel={t("settings.appearance.vscodeImport.noVariant")}
            />
          </div>

          {/* The honest caveat, stated before committing rather than after:
              one variant fills both halves, so light mode will show a dark
              palette (or the reverse). */}
          {(lightPath === NONE || darkPath === NONE) && (
            <p className="text-xs text-warning">
              {t("settings.appearance.vscodeImport.singleVariantNote")}
            </p>
          )}

          {preview && (
            <div className="space-y-2">
              <span className="text-xs text-muted-foreground">
                {t("settings.appearance.vscodeImport.preview")}
              </span>
              <div className="flex gap-3">
                <Swatches colors={preview.family.light} label={t("settings.appearance.modeLight")} />
                <Swatches colors={preview.family.dark} label={t("settings.appearance.modeDark")} />
              </div>
            </div>
          )}

          {preview && preview.warnings.length > 0 && (
            <p className="text-xs text-warning">
              {t("settings.appearance.vscodeImport.contrastWarning", {
                pairs: preview.warnings.join(", "),
              })}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!preview} onClick={() => preview && onConfirm(preview)}>
            {t("settings.appearance.vscodeImport.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VariantPicker({
  label,
  value,
  onChange,
  options,
  noneLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { path: string; label: string }[];
  noneLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.path} value={o.path}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A row of derived colours. Inline `style` is unavoidable here: these are
 *  values that exist only in this render, not tokens on `<html>`. */
function Swatches({ colors, label }: { colors: ThemeColors; label: string }) {
  return (
    <div className="flex-1 space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div
        className="flex gap-1 rounded border border-border p-1.5"
        style={{ backgroundColor: colors.background }}
      >
        {PREVIEW_TOKENS.map((token) => (
          // `aria-label`, not `title`: an OS tooltip on each of eight 16px
          // swatches is noise, and `uiAdoption.test.ts` ratchets native
          // `title=` downward — a preview strip is not the place to spend it.
          <span
            key={token}
            aria-label={token}
            className="h-4 w-4 rounded-sm border border-black/10"
            style={{ backgroundColor: colors[token] }}
          />
        ))}
      </div>
    </div>
  );
}
