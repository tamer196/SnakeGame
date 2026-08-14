/**
 * The entity renderers: hazards, power-up runes and food orbs.
 *
 * Scene-graph order inside the masked world container is
 * `hazards -> orbs -> runes -> snake`, and the hazard renderer keeps portals
 * below the other five kinds internally, so adding the three containers in
 * that order is all a scene has to do.
 *
 * Both texture caches (baked hazard slabs, baked rune emblems) outlive a
 * renderer on purpose - a level restart reuses them. {@link clearEntityTextures}
 * is the theme-change / context-loss hook that drops them.
 */

export { HazardRenderer, hazardLayerOrder } from "./HazardRenderer";
export { RuneRenderer } from "./RuneRenderer";
export { OrbRenderer } from "./OrbRenderer";
export type { FrameClocks } from "./clocks";

export {
  GLOW_STEP_PX,
  addGlow,
  addGlowLine,
  addSlabGlow,
  glowDiscRadius,
  neonLine,
  slabGlowShape,
  type SlabGlowShape,
} from "./hazardGlow";
export {
  clearHazardSlabCache,
  hazardSlabCacheSize,
  hazardSlabTexture,
} from "./hazardSlab";
export {
  clearRuneGlyphCache,
  glyphSizeBucket,
  runeGlyphCacheSize,
  runeGlyphTexture,
} from "./runeGlyphs";

import { clearHazardSlabCache } from "./hazardSlab";
import { clearRuneGlyphCache } from "./runeGlyphs";

/**
 * Drop every texture this directory bakes.
 *
 * Slabs are keyed on their colours and emblems on their kind and size, so a
 * theme change leaves both caches holding textures nothing will ask for again.
 * Call this on a theme change or a lost GL context; the renderers rebuild what
 * they need on the next `setLevel` / `draw`.
 */
export function clearEntityTextures(): void {
  clearHazardSlabCache();
  clearRuneGlyphCache();
}
