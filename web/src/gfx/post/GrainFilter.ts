/**
 * Film grain: a handful of pre-rendered speck layers, cycled at film rate and
 * jittered so the same layer never lands twice in the same place.
 *
 * The specks stay pre-baked rather than becoming a hash-noise shader, and that
 * is the whole point of the port. Silver-halide grain is *sparse* - individual
 * bright specks on a dark image, not a full-field noise floor - and a per-pixel
 * noise function looks like video static instead. Three 1296x736 layers at
 * 3400 specks each, cycled at 24 Hz across 17x17 jitter offsets, give
 * 3 * 289 visually distinct frames out of three textures and one sample.
 *
 * The layers are additive, as in Python: `frame + speck`. That is also why they
 * are opaque black - there is nothing to alpha-blend.
 *
 * The one thing to know before enabling this on a low-end device: three
 * frame-sized RGBA textures are about 11 MB of texture memory, so they are
 * built lazily, on the first frame the grain is actually switched on, and
 * dropped again by {@link GrainFilter.destroy}.
 */

import { defaultFilterVert, Filter, GlProgram, Texture } from "pixi.js";

import { WINDOW_H, WINDOW_W } from "../../core/config";
import { clamp8 } from "../../core/palette";
import { makeSeededRng } from "../rng";
import { canvasTexture, clearToBlack, context2d, createCanvas, cssRgb } from "../textures";

/** Pre-rendered layers (effects.py:172). */
const GRAIN_FRAMES = 3;
/** Specks per layer. */
const GRAIN_SPECKS = 3400;
/** Layers are this many px larger than the frame, so they can be shifted. */
const GRAIN_JITTER = 16;
/** Speck brightness added to the frame ... */
const GRAIN_MIN = 6;
/** ... at most. */
const GRAIN_MAX = 34;

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uGrainTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;

uniform vec2 uFrameSize;
uniform vec2 uGrainSize;
uniform vec2 uJitter;

void main(void)
{
    vec4 src = texture(uTexture, vTextureCoord);
    vec2 uv = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
    // Python blits the oversized layer at (-jx, -jy): frame pixel (x, y) reads
    // layer pixel (x + jx, y + jy).
    vec2 g = (uv * uFrameSize + uJitter) / uGrainSize;
    vec3 speck = texture(uGrainTexture, g).rgb;
    finalColor = vec4(min(src.rgb + speck, vec3(1.0)), src.a);
}
`;

export class GrainFilter extends Filter {
  private layers: Texture[] = [];
  private layerW = 0;
  private layerH = 0;
  private frameW = WINDOW_W;
  private frameH = WINDOW_H;
  private current = -1;

  constructor() {
    super({
      glProgram: GlProgram.from({ fragment: FRAGMENT, vertex: defaultFilterVert, name: "neon-grain" }),
      resources: {
        grainUniforms: {
          uFrameSize: { value: new Float32Array([WINDOW_W, WINDOW_H]), type: "vec2<f32>" },
          uGrainSize: {
            value: new Float32Array([WINDOW_W + GRAIN_JITTER, WINDOW_H + GRAIN_JITTER]),
            type: "vec2<f32>",
          },
          uJitter: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
        },
        uGrainTexture: Texture.EMPTY.source,
        uGrainSampler: Texture.EMPTY.source.style,
      },
      resolution: "inherit",
    });
    this.setFrameSize(WINDOW_W, WINDOW_H);
  }

  /** The design-space rect the grain covers. Rebuilds the layers if it moves. */
  setFrameSize(w: number, h: number): void {
    this.frameW = w;
    this.frameH = h;
    const uniforms = this.resources.grainUniforms.uniforms;
    const frame = uniforms.uFrameSize as Float32Array;
    frame[0] = w;
    frame[1] = h;
    if (this.layers.length > 0 && (this.layerW !== this.wanted(w) || this.layerH !== this.wanted(h))) {
      this.dropLayers();
    }
  }

  /**
   * Show layer `index` at jitter `(jx, jy)`.
   *
   * Returns false when the layers could not be built (no canvas, out of
   * memory), so the caller can leave the pass switched off rather than paint a
   * blank sheet over the frame.
   */
  setLayer(index: number, jx: number, jy: number): boolean {
    if (!this.ensureLayers()) return false;
    const i = ((index % this.layers.length) + this.layers.length) % this.layers.length;
    if (i !== this.current) {
      const tex = this.layers[i];
      if (!tex) return false;
      this.current = i;
      this.resources.uGrainTexture = tex.source;
      this.resources.uGrainSampler = tex.source.style;
    }
    const jitter = this.resources.grainUniforms.uniforms.uJitter as Float32Array;
    jitter[0] = jx;
    jitter[1] = jy;
    return true;
  }

  /** Build the speck layers. Cheap enough to do inline, once. */
  private ensureLayers(): boolean {
    if (this.layers.length > 0) return true;
    const w = this.wanted(this.frameW);
    const h = this.wanted(this.frameH);
    const size = this.resources.grainUniforms.uniforms.uGrainSize as Float32Array;
    size[0] = w;
    size[1] = h;

    // Seeded, so a rebuild after a resize comes back with the same grain the
    // player was already looking at. Python seeds 0xC0FFEE; the generator
    // differs, so only the character of the layout carries over, not the specks.
    const rng = makeSeededRng(0xc0ffee);
    try {
      for (let k = 0; k < GRAIN_FRAMES; k++) {
        const canvas = createCanvas(w, h);
        const ctx = context2d(canvas);
        clearToBlack(ctx, w, h);
        for (let i = 0; i < GRAIN_SPECKS; i++) {
          const x = rng.randrange(w);
          const y = rng.randrange(h);
          const g = rng.randint(GRAIN_MIN, GRAIN_MAX);
          // A hint of colour noise: real grain is not perfectly neutral.
          ctx.fillStyle = cssRgb([
            g,
            clamp8(g * rng.uniform(0.82, 1.0)),
            clamp8(g * rng.uniform(0.86, 1.12)),
          ]);
          const sz = rng.random() < 0.1 ? 2 : 1;
          ctx.fillRect(x, y, sz, sz);
        }
        this.layers.push(canvasTexture(canvas));
      }
    } catch (err) {
      console.warn("[post] film grain unavailable", err);
      this.dropLayers();
      return false;
    }
    this.layerW = w;
    this.layerH = h;
    this.current = -1;
    return true;
  }

  private wanted(v: number): number {
    return Math.max(2, Math.round(v)) + GRAIN_JITTER;
  }

  /**
   * Free the layers - unbinding them FIRST, which is not a stylistic choice.
   *
   * A Pixi `BindGroup` subscribes to `change` on every resource it holds, and
   * `TextureSource.destroy()` sets `destroyed = true` and then emits `change`.
   * The listener sees a destroyed resource and destroys the bind group, which
   * nulls its own `resources` array - so destroying a texture that is still
   * bound leaves this filter permanently unbindable, and the next
   * `this.resources.x = ...` throws `Cannot read properties of null` from
   * inside `BindGroup.setResource`.
   *
   * That throw lands in `Ticker.update`, which requests the next frame only
   * after its listeners return, so the whole game loop stops for good. The
   * only trigger needed is a frame-size change with layers already built:
   * dragging a desktop window edge, or rotating a phone.
   *
   * Rebinding to `Texture.EMPTY` first is the fix, because `setResource`
   * detaches the listener from the resource it replaces. By the time the
   * layers are destroyed, nothing is watching them.
   */
  private dropLayers(): void {
    this.resources.uGrainTexture = Texture.EMPTY.source;
    this.resources.uGrainSampler = Texture.EMPTY.source.style;
    for (const tex of this.layers) tex.destroy(true);
    this.layers.length = 0;
    this.layerW = 0;
    this.layerH = 0;
    this.current = -1;
  }

  override destroy(destroyPrograms?: boolean): void {
    this.dropLayers();
    super.destroy(destroyPrograms);
  }
}
