import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input, type InputProps } from "@/components/ui/input";
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
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-2.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
