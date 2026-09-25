import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input, type InputProps } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/**
 * Password field with a themed show/hide toggle.
 *
 * The WebView2 (Edge/Chromium) native `::-ms-reveal` eye is rendered near-black
 * and can't be themed, so it's invisible on dark surfaces — it's hidden
 * globally in `index.css` and this component provides a legible, theme-aware
 * reveal instead. Drop-in for `<Input type="password" />`: forwards the ref to
 * the underlying input and passes every other prop straight through.
 *
 * The toggle is `tabIndex={-1}` so keyboard focus flows field-to-field as
 * before (reveal is a mouse affordance); it never submits a form (`type=
 * "button"`).
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type">
>(({ className, ...props }, ref) => {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState(false);
  const label = visible ? t("common.hidePassword") : t("common.showPassword");
  return (
    // `w-full` mirrors the underlying Input's own width so the wrapper is a
    // drop-in replacement in both block layouts (a Field) and flex rows (it
    // grows to fill beside a sibling button, as the bare Input did).
    <div className="relative w-full">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-9", className)}
        {...props}
      />
      {/* Same geometry as `SearchField`'s clear button: the 24px square fits
          every field height the app renders this at (h-7 to h-9). */}
      <IconButton
        type="button"
        flat
        size="xs"
        tabIndex={-1}
        label={label}
        icon={visible ? EyeOff : Eye}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-1 top-1/2 -translate-y-1/2"
      />
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
