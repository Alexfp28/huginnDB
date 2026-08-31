/**
 * A sparkline, drawn by hand.
 *
 * There is no charting library in this tree and adding one for a 120×20 line
 * would be a poor trade — the whole component is an SVG path and a fill. Two
 * things it does that a naive `points` join would not:
 *
 *  - **Gaps break the line.** A `null` in the series is an interval Pulse
 *    could not measure (a server restart, a sample it missed). Drawing through
 *    it invents a slope; the path is split into runs instead, so the break is
 *    visible.
 *  - **Colour comes from a token.** Never a literal, so a custom theme
 *    recolours Pulse along with everything else (see `lib/themes.ts`).
 */

import { useId } from "react";

interface SparklineProps {
  /** Oldest first. `null` marks an interval with no reading. */
  values: readonly (number | null)[];
  /** A CSS colour — pass a token (`var(--brand)`), not a hex literal. */
  color: string;
  width?: number;
  height?: number;
  className?: string;
  /** Screen-reader description. Omit for a chart that only repeats a figure
   *  already written next to it, and the SVG is hidden instead. */
  label?: string;
}

export function Sparkline({
  values,
  color,
  width = 120,
  height = 20,
  className,
  label,
}: SparklineProps) {
  const gradientId = useId();
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));

  // One point cannot describe a trend and a flat line at the top of the box
  // reads as "pinned at maximum", which is a claim. Draw nothing.
  if (real.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={className}
        aria-hidden
      />
    );
  }

  const min = Math.min(...real);
  const max = Math.max(...real);
  // A perfectly flat series has no range to scale into; centre it rather than
  // dividing by zero.
  const span = max - min || 1;
  const pad = 1.5;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  // Split into runs of consecutive readings so a gap leaves a gap.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ i, v });
  });
  if (run.length) runs.push(run);

  const lines = runs
    .filter((r) => r.length >= 2)
    .map((r) => r.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" "));

  // The fill sits under the last run only. Filling under a broken line would
  // close the shape across the gap and paint over it.
  const lastRun = runs[runs.length - 1];
  const area =
    lastRun && lastRun.length >= 2
      ? `M${x(lastRun[0].i).toFixed(1)} ${height} ` +
        lastRun.map((p) => `L${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ") +
        ` L${x(lastRun[lastRun.length - 1].i).toFixed(1)} ${height} Z`
      : null;

  const tip = lastRun?.[lastRun.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${gradientId})`} />}
      {lines.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {tip && <circle cx={x(tip.i)} cy={y(tip.v)} r="1.8" fill={color} />}
    </svg>
  );
}
