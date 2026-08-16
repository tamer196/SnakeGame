/**
 * The bridge to a native wrapper, when one is present.
 *
 * A browser tab cannot close itself, so the menu's QUIT button is honest only
 * where a real window exists to close. The Electron wrapper's preload script
 * exposes `window.neonSerpentShell` with a `quit()`; Capacitor or any future
 * wrapper can do the same. The game probes for the capability rather than
 * sniffing a user agent, so the contract is one object and one method.
 */

export interface ShellBridge {
  /** Close the application window. Desktop wrappers only. */
  quit?: () => void;
}

/** The wrapper's bridge object, or null in a plain browser tab. */
export function shellBridge(): ShellBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as { neonSerpentShell?: ShellBridge };
  return w.neonSerpentShell ?? null;
}

/** True when a wrapper can genuinely close the window. */
export function canQuit(): boolean {
  return typeof shellBridge()?.quit === "function";
}
