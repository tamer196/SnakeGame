/**
 * The result screens' little string formatters - a port of `_fmt_time` and
 * `_fmt_delta` (`snake/scenes/gameover.py:135-150`).
 */

import { clamp } from "../../core/mathx";
import { grouped } from "../../ui/format";

/**
 * Seconds -> `m:ss`, clamped to something a scoreboard can print.
 *
 * The ceiling is 59:59 and there is never an hours field. Non-numeric input
 * reads as zero, because a results screen must not crash over a bad clock.
 */
export function fmtTime(seconds: number): string {
  const raw = Number.isFinite(seconds) ? seconds : 0;
  const s = Math.trunc(clamp(raw, 0, 59 * 60 + 59));
  return `${Math.trunc(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A signed, thousands-separated delta: `+1,240` / `-90` / `+0`.
 *
 * The sign is written explicitly and the absolute value formatted, so `-0`
 * is impossible.
 */
export function fmtDelta(delta: number): string {
  const n = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return `${n >= 0 ? "+" : "-"}${grouped(Math.abs(n))}`;
}
