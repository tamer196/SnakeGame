/**
 * Number formatting shared across the UI.
 *
 * Python renders scores with `f"{value:,}"`, which is a comma-grouped en-US
 * format whatever the machine's locale. A bare `Number.toLocaleString()`
 * follows the *browser* locale instead - a de-DE device would print `1.240`
 * and an ar-EG device Arabic-Indic digits - so the locale is pinned here, once.
 *
 * This started life module-private in `ui/hud/Hud.ts`; the result screens
 * added four more call sites, which is what promoted it.
 */

/** `f"{value:,}"` - truncate, then group thousands with commas. */
export function grouped(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}
