/**
 * The background registry.
 *
 * Themes name their background with a style key (`Theme.bgStyle`), which is
 * what `makeBackground` resolves here. Every stage is imported eagerly and
 * listed once: the twelve are small, they are all reachable from level select,
 * and a lazy import would only move the cost to the least welcome moment.
 *
 * The factory never throws. A background is decoration - if a stage fails to
 * build, the player should get the plain themed gradient and a warning in the
 * console, not a dead game.
 */

import type { Renderer } from "pixi.js";

import type { Theme } from "../../core/palette";
import type { DesignRect } from "../../app/Viewport";
import { Background } from "./Background";
import { GridBackground } from "./GridBackground";
import { NebulaBackground } from "./NebulaBackground";
import { CircuitBackground } from "./CircuitBackground";
import { LavaBackground } from "./LavaBackground";
import { OceanBackground } from "./OceanBackground";
import { StaticBackground } from "./StaticBackground";
import { IceBackground } from "./IceBackground";
import { SporeBackground } from "./SporeBackground";
import { MachineBackground } from "./MachineBackground";
import { AuroraBackground } from "./AuroraBackground";
import { VoidWarpBackground } from "./VoidWarpBackground";
import { PrismBackground } from "./PrismBackground";

export { Background } from "./Background";
export type { ParallaxLayer } from "./Background";

type BackgroundCtor = new (
  style: string,
  theme: Theme,
  rect: DesignRect,
  renderer: Renderer,
) => Background;

/** Every style key a theme may name, in campaign order. */
export const STYLES = [
  "grid",
  "nebula",
  "circuit",
  "lava",
  "ocean",
  "static",
  "ice",
  "spores",
  "machine",
  "aurora",
  "voidwarp",
  "prism",
] as const;

export type StyleKey = (typeof STYLES)[number];

const REGISTRY: Record<string, BackgroundCtor> = {
  grid: GridBackground,
  nebula: NebulaBackground,
  circuit: CircuitBackground,
  lava: LavaBackground,
  ocean: OceanBackground,
  static: StaticBackground,
  ice: IceBackground,
  spores: SporeBackground,
  machine: MachineBackground,
  aurora: AuroraBackground,
  voidwarp: VoidWarpBackground,
  prism: PrismBackground,
};

/**
 * Build the background for a style key.
 *
 * Unknown keys fall back to the grid stage, and a stage that throws during
 * construction falls back to the plain base class.
 */
export function makeBackground(
  style: string,
  theme: Theme,
  rect: DesignRect,
  renderer: Renderer,
): Background {
  const key = String(style ?? "").trim().toLowerCase();
  const Ctor = REGISTRY[key] ?? REGISTRY["grid"];
  try {
    // init() is separate from the constructor on purpose - see Background.init.
    if (Ctor) return new Ctor(key, theme, rect, renderer).init();
  } catch (err) {
    console.warn(`[bg] "${key}" failed to construct; using the plain gradient`, err);
  }
  return new Background(key, theme, rect, renderer).init();
}
