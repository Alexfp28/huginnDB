# Gotcha #047: PrefId is derived from Preferences, making gotcha #32's contract a compile error

**Fecha:** 2026-09-03

`lib/prefId.ts` builds the settings-navigation string union from the `Preferences` type plus `ActionId` for shortcut rows, so a `prefId` typo that used to silently fail to highlight now fails to compile.

## Detail

**`PrefId` is derived from `Preferences`, so gotcha #32's string contract is now a compile error.** `SETTINGS_INDEX[].prefId` and the `prefId` prop on that setting's `PrefRow` are joined by that string alone, and a mismatch used to degrade silently to "the section opens, nothing is highlighted". `lib/prefId.ts` builds the union as `` `${group}.${keyof Preferences[group]}` `` for the four row-rendering groups, plus `` `keybinding.${ActionId}` `` for the shortcut rows (`version` and `keybindings` are not rows, which is why they are excluded from the path side). Adding a preference still means touching both files — the compiler just tells you when you forgot.
