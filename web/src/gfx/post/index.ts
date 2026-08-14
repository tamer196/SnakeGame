/**
 * The post-processing chain and the screen-feedback state behind it.
 *
 * Wire it up with two lines: put {@link PostChain.view} where the scene roots
 * used to be added, then add the scene roots to {@link PostChain.scene} and
 * call `chain.update(realDt)` once a frame. Gameplay talks to
 * {@link PostChain.fx} - `shake`, `flash`, `slowmo`, `beginTransition` - and
 * the wipe renderer draws into {@link PostChain.top}.
 */

export { AberrationFilter } from "./AberrationFilter";
export { BloomFilter } from "./BloomFilter";
export { CrtFilter } from "./CrtFilter";
export { GrainFilter } from "./GrainFilter";
export { buildFlareTexture, PostChain, type FrameRect } from "./PostChain";
export {
  fieldBlend,
  hash01,
  noise1,
  ScreenFx,
  smoothstep,
  ABERRATION_FULL,
  ABERRATION_START,
  BLOOM_MAX,
  BLOOM_STRENGTH,
  DISSOLVE_GRID,
  DISSOLVE_STEPS,
  FIELD,
  FLARE_DECAY,
  FLARE_HEIGHT,
  FLARE_MAX,
  FLASH_MAX,
  GLITCH_BANDS,
  GRAIN_FPS,
  GRAIN_FRAMES,
  GRAIN_JITTER,
  QUALITY_LEVELS,
  SHAKE_CUTOFF,
  SHAKE_DIR_CUTOFF,
  SHAKE_DIR_DECAY,
  SHAKE_DIR_FREQ,
  SHAKE_DIR_SHARE,
  SHAKE_MAX,
  TRANSITION_BAND,
  TRANSITION_MODES,
  TRANSITION_STYLES,
  WIPE_SKIP_CHEAP,
  WIPE_SKIP_HEAVY,
  type FlareOptions,
  type PostFlags,
  type QualityLevel,
  type ShakeOptions,
  type TransitionMode,
  type TransitionOptions,
  type TransitionStyle,
} from "./ScreenFx";
