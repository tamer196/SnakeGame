/**
 * Bloom: threshold, downsample hard, blur by resampling, add back.
 *
 * `effects.py::_refresh_bloom` never convolves and never touches full
 * resolution except to read once and write once. It reduces the canvas to a
 * quarter, subtracts a grey floor, then resamples that down to 1/16 and 1/64
 * and stretches *both* back up: the tight octave is a hot halo hugging the
 * source, the wide one is the atmospheric glow, and summing them is what
 * separates "bloom" from "slightly blurry".
 *
 * This keeps that ladder rather than reaching for `BlurFilter`, for three
 * reasons: the resample-down-then-up *is* the Python's blur (a Gaussian would
 * be a different look, not a faster one), the threshold rides along in the
 * first hop for free, and four passes of which only one is full-resolution is
 * cheaper than two full-frame separable blur passes.
 *
 *     frame  ->  1/4   threshold, 4-tap box
 *            ->  1/16  4-tap box          (tight octave)
 *            ->  1/64  4-tap box          (wide octave)
 *            ->  frame + gain * (tight + wide)
 *
 * Deliberate departures from the CPU version, all of them things the Python
 * only does because it is on a CPU:
 *
 * - **Rebuilt every frame.** Python rebuilds at 22 Hz and re-adds a stale
 *   buffer in between, purely to buy back ~0.65 ms a frame; on the GPU the
 *   whole ladder is a fraction of that, and the shimmer goes away.
 * - **One gain multiply.** Python doubles the buffer and halves the gain above
 *   1.0 because a pygame surface cannot be blitted onto itself - which quietly
 *   clamps any gain above 1.998 to exactly 2.0. One multiply covers 0..2.5.
 * - **Box taps instead of `smoothscale`, and no nearest hops.** The first
 *   reduction is nearest in Python and the last expansion is a nearest
 *   blow-up of a 426x240 intermediate; both were perf hacks whose blockiness
 *   "the blur hides". Four bilinear taps per hop is an area average, which is
 *   what `smoothscale` does.
 *
 * The saturation the sum performs is *not* dropped: pygame clips the two
 * octaves at 255 before the gain, and that clip is visible on a saturated core.
 */

import {
  defaultFilterVert,
  Filter,
  GlProgram,
  Texture,
  TexturePool,
  type FilterSystem,
  type RenderSurface,
} from "pixi.js";

/** First reduction of the frame (effects.py:142). */
const BLOOM_DOWNSCALE = 4;
/**
 * Channel value below which nothing blooms, 0..255. Deliberately high: neon
 * accents are near-saturated in one or two channels and sail over it, while
 * blocks of white UI text sit just under it and stay legible instead of
 * smearing into their own halo.
 */
const BLOOM_THRESHOLD = 172;

/** Shared by both reduction passes; `uThreshold` is 0 on the later ones. */
const DOWNSAMPLE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputPixel;
uniform highp vec4 uInputClamp;

uniform float uThreshold;

vec3 tap(vec2 uv) {
    return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).rgb;
}

void main(void)
{
    // Four bilinear taps one source texel out from the centre average the
    // whole 4x4 block the destination texel stands for - pygame's smoothscale
    // is an area average, and this is the same thing in four taps. uInputPixel,
    // not uInputSize: the former is one *texel*, the latter one texture unit,
    // and they part company as soon as the device pixel ratio is not 1.
    vec2 o = uInputPixel.zw;
    vec3 c = tap(vTextureCoord + vec2(-o.x, -o.y))
           + tap(vTextureCoord + vec2( o.x, -o.y))
           + tap(vTextureCoord + vec2(-o.x,  o.y))
           + tap(vTextureCoord + vec2( o.x,  o.y));
    c *= 0.25;
    // Subtractive, not a step: what survives keeps its shape instead of
    // becoming a hard-edged mask of it.
    finalColor = vec4(max(c - uThreshold, vec3(0.0)), 1.0);
}
`;

const COMBINE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uTightTexture;
uniform sampler2D uWideTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;

uniform float uGain;
uniform vec2 uTightScale;
uniform vec2 uWideScale;

void main(void)
{
    vec4 base = texture(uTexture, vTextureCoord);
    // The ladder textures are pooled at power-of-two sizes with the octave in
    // their top-left frame, so the frame uv has to be scaled into each one and
    // held half a texel inside it or the expansion drags in unwritten texels.
    vec2 uv = clamp(vTextureCoord * uInputSize.xy / uOutputFrame.zw, 0.0, 1.0);
    vec3 tight = texture(uTightTexture, uv * uTightScale).rgb;
    vec3 wide  = texture(uWideTexture,  uv * uWideScale).rgb;
    // pygame sums the two octaves with BLEND_RGB_ADD, which clips at 255.
    vec3 glow = min(tight + wide, vec3(1.0)) * uGain;
    finalColor = vec4(min(base.rgb + glow, vec3(1.0)), base.a);
}
`;

export class BloomFilter extends Filter {
  private readonly downsample: Filter;

  constructor() {
    super({
      glProgram: GlProgram.from({
        fragment: COMBINE_FRAGMENT,
        vertex: defaultFilterVert,
        name: "neon-bloom-combine",
      }),
      resources: {
        bloomUniforms: {
          uGain: { value: 0.72, type: "f32" },
          uTightScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
          uWideScale: { value: new Float32Array([1, 1]), type: "vec2<f32>" },
        },
        // Declared up front so the samplers exist in the bind group; the real
        // ladder textures are swapped in every frame, before the pass runs.
        uTightTexture: Texture.EMPTY.source,
        uTightSampler: Texture.EMPTY.source.style,
        uWideTexture: Texture.EMPTY.source,
        uWideSampler: Texture.EMPTY.source.style,
      },
      resolution: "inherit",
    });

    this.downsample = new Filter({
      glProgram: GlProgram.from({
        fragment: DOWNSAMPLE_FRAGMENT,
        vertex: defaultFilterVert,
        name: "neon-bloom-down",
      }),
      resources: {
        downsampleUniforms: {
          uThreshold: { value: BLOOM_THRESHOLD / 255, type: "f32" },
        },
      },
    });
  }

  /** How hard the glow is added back, 0..BLOOM_MAX. */
  get gain(): number {
    return this.resources.bloomUniforms.uniforms.uGain as number;
  }

  set gain(value: number) {
    this.resources.bloomUniforms.uniforms.uGain = value;
  }

  apply(
    filterManager: FilterSystem,
    input: Texture,
    output: RenderSurface,
    clearMode: boolean,
  ): void {
    const resolution = input.source.resolution;
    const w = input.frame.width;
    const h = input.frame.height;

    const quarter = this.ladderTexture(w, h, BLOOM_DOWNSCALE, resolution);
    const tight = this.ladderTexture(w, h, BLOOM_DOWNSCALE * 4, resolution);
    const wide = this.ladderTexture(w, h, BLOOM_DOWNSCALE * 16, resolution);

    const uniforms = this.downsample.resources.downsampleUniforms.uniforms;
    uniforms.uThreshold = BLOOM_THRESHOLD / 255;
    filterManager.applyFilter(this.downsample, input, quarter, true);
    // Only the first hop thresholds; the rest are pure reductions.
    uniforms.uThreshold = 0;
    filterManager.applyFilter(this.downsample, quarter, tight, true);
    filterManager.applyFilter(this.downsample, tight, wide, true);

    this.resources.uTightTexture = tight.source;
    this.resources.uTightSampler = tight.source.style;
    this.resources.uWideTexture = wide.source;
    this.resources.uWideSampler = wide.source.style;
    this.setScale("uTightScale", tight);
    this.setScale("uWideScale", wide);
    filterManager.applyFilter(this, input, output, clearMode);

    TexturePool.returnTexture(quarter);
    TexturePool.returnTexture(tight);
    TexturePool.returnTexture(wide);
  }

  /**
   * One rung of the ladder: the same frame at `1 / div` of the pixel density.
   *
   * It has to be spelled as a resolution rather than a smaller frame. Pixi
   * sizes the filter quad from the *input* frame and maps it onto the output
   * frame, so a hop between two different frame sizes would draw itself into
   * the wrong rectangle; dropping the resolution keeps the frame identical and
   * quarters the pixels, which is what the ladder actually wants.
   */
  private ladderTexture(w: number, h: number, div: number, resolution: number): Texture {
    const floor = 4 / Math.max(1, Math.min(w, h)); // never reduce below ~4 px
    return TexturePool.getOptimalTexture(w, h, Math.max(resolution / div, floor), false);
  }

  /** The fraction of a pooled texture its frame occupies, minus half a texel. */
  private setScale(name: "uTightScale" | "uWideScale", texture: Texture): void {
    const scale = this.resources.bloomUniforms.uniforms[name] as Float32Array;
    const source = texture.source;
    const res = source.resolution;
    scale[0] = (texture.frame.width * res - 0.5) / source.pixelWidth;
    scale[1] = (texture.frame.height * res - 0.5) / source.pixelHeight;
  }

  override destroy(destroyPrograms?: boolean): void {
    this.downsample.destroy(destroyPrograms);
    super.destroy(destroyPrograms);
  }
}
