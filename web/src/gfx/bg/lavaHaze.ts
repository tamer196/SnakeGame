/**
 * The heat-haze refraction pass for stage 4 (`lava`).
 *
 * Python copies a horizontal band out of the finished background and re-blits
 * it in four-pixel slices with a sinusoidal horizontal offset, so the band
 * genuinely refracts whatever is behind it rather than tinting over the top of
 * it. On the GPU that copy is free: the filter reads the container it is
 * attached to and samples sideways inside the band.
 *
 * Two details are load-bearing:
 *
 * - **The rows stay quantised to four.** Python shifts whole four-pixel slices,
 *   which gives the band a slightly ribbed edge. A smooth per-row offset would
 *   look cleaner and wrong.
 * - **The sample is shifted the other way.** Python *writes* each slice `dx` to
 *   the right; reading the same image back means sampling `dx` to the *left*.
 *
 * The shader works in the filter's own 0..1 region rather than in pixels, so
 * it does not care what the viewport scale is. That only holds while the
 * filtered region is the arena, which is why the caller pins `filterArea` to
 * the arena rect and the filter turns viewport clipping off.
 */

import { Filter, GlProgram, UniformGroup } from "pixi.js";

const vertex = `
in vec2 aPosition;

out vec2 vTextureCoord;
out vec2 vLocal;
out vec2 vScale;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void)
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);

    vScale = uOutputFrame.zw * uInputSize.zw;
    vTextureCoord = aPosition * vScale;
    // aPosition is the unit quad, so this is 0..1 across the filtered region.
    vLocal = aPosition;
}
`;

// The precision line has to be the very first thing in the source: that is how
// Pixi detects one is already present, and how it gets to downgrade us to
// mediump on hardware that cannot do highp in a fragment shader.
const fragment = `precision highp float;

in vec2 vTextureCoord;
in vec2 vLocal;
in vec2 vScale;

out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputClamp;

uniform vec2 uArena;   // arena size in design px
uniform vec4 uBand;    // top, bottom, band origin y, band height (design px)
uniform float uTime;   // seconds since the background was built

void main(void)
{
    vec2 uv = vTextureCoord;
    float y = vLocal.y * uArena.y;

    if (y >= uBand.x && y < uBand.y)
    {
        // Slices are four design pixels tall, exactly as the Python blits them.
        float i = floor((y - uBand.x) * 0.25) * 4.0;
        float f = sin(3.141592653589793 * (i + uBand.x - uBand.z) / uBand.w);
        float dx = sin(uTime * 3.1 + i * 0.13) * 7.0 * max(0.0, f);
        uv.x = clamp(vLocal.x - dx / uArena.x, 0.0, 1.0) * vScale.x;
    }

    finalColor = texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw));
}
`;

export class HeatHazeFilter extends Filter {
  /** (top, bottom, band origin y, band height), mutated in place each frame. */
  private readonly band: Float32Array;
  private readonly group: UniformGroup<{
    uArena: { value: Float32Array; type: "vec2<f32>" };
    uBand: { value: Float32Array; type: "vec4<f32>" };
    uTime: { value: number; type: "f32" };
  }>;

  constructor(arenaW: number, arenaH: number) {
    const band = new Float32Array([0, 0, 0, 1]);
    // A scalar `f32` is synced by value, not by reference, so uTime has to be
    // written back through the group; the vectors can be mutated in place.
    const group = new UniformGroup({
      uArena: { value: new Float32Array([arenaW, arenaH]), type: "vec2<f32>" as const },
      uBand: { value: band, type: "vec4<f32>" as const },
      uTime: { value: 0, type: "f32" as const },
    });
    super({
      glProgram: GlProgram.from({ fragment, vertex, name: "lava-heat-haze" }),
      resources: { hazeUniforms: group },
      // No padding, no clipping: the region must stay exactly the arena rect
      // the caller pinned with `filterArea`, or the 0..1 mapping above lies.
      padding: 0,
      antialias: "off",
      resolution: "inherit",
      clipToViewport: false,
    });
    this.band = band;
    this.group = group;
  }

  /**
   * Point the band at rows `top..bottom` of a band whose origin is `hazeY`.
   *
   * `hazeY` is the unclipped top of the travelling band, which is what drives
   * the sine envelope; `top` is that clamped to the arena.
   */
  setBand(top: number, bottom: number, hazeY: number, height: number, t: number): void {
    this.band[0] = top;
    this.band[1] = bottom;
    this.band[2] = hazeY;
    this.band[3] = height;
    this.group.uniforms.uTime = t;
  }
}
