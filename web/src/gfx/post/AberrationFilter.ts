/**
 * Shake-driven chromatic aberration: a radial RGB split that is zero on the
 * optical axis and widens toward the rim.
 *
 * The Python (`effects.py::_blit_aberrated`) cannot afford two scaled copies of
 * the canvas per frame, so it fakes the radial ramp with five nested
 * rectangular bands, each of whose four strips is blitted along its own outward
 * normal. That quantisation is visible in the shipped game - the split steps
 * rather than sweeps - so it is ported as-is rather than "improved" into the
 * continuous ramp the bands were approximating (spec §17 Q2 is still open; a
 * continuous `d = dmax * m` is a one-line change here if the lead wants it).
 *
 * Two deliberate differences from the CPU version:
 *
 * - The bands are anchored to the frame rect, not to the shaken copy of it.
 *   Python offsets the whole band grid by the shake, which moves the ring
 *   boundaries by up to 26 px; at five bands across 1280 px that is inside the
 *   width of one band.
 * - Samples that fall outside the frame contribute black, which is what
 *   `_fill_edges` paints into the strips the shake uncovers.
 */

import { defaultFilterVert, Filter, GlProgram } from "pixi.js";

import { WINDOW_H, WINDOW_W } from "../../core/config";

/** Maximum channel offset in design px, at the rim (effects.py:110). */
const ABERRATION_MAX_PX = 5.0;
/** Channel-tint strength at the faintest split ... */
const ABERRATION_MASK_MIN = 62;
/** ... and at the strongest, out of 255. */
const ABERRATION_MASK_MAX = 118;
/** Nested bands used to fake the radial ramp. */
const ABERRATION_RINGS = 5;

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;
uniform highp vec4 uInputClamp;

uniform float uStrength;
uniform vec2 uFrameSize;

const float MAX_PX   = ${ABERRATION_MAX_PX.toFixed(1)};
const float RINGS    = ${ABERRATION_RINGS.toFixed(1)};
const float MASK_MIN = ${ABERRATION_MASK_MIN.toFixed(1)};
const float MASK_MAX = ${ABERRATION_MASK_MAX.toFixed(1)};

// Outside the frame there is nothing but the black the shake uncovered.
vec3 frameSample(vec2 uv) {
    vec2 lo = step(uInputClamp.xy, uv);
    vec2 hi = step(uv, uInputClamp.zw);
    float inside = lo.x * lo.y * hi.x * hi.y;
    return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)).rgb * inside;
}

void main(void)
{
    vec4 base = texture(uTexture, vTextureCoord);

    // -1..1 across the frame. The ramp metric is Chebyshev, not Euclidean:
    // in the CPU version the horizontal strips own the corners.
    vec2 n = (vTextureCoord * uInputSize.xy / uOutputFrame.zw) * 2.0 - 1.0;
    float m = max(abs(n.x), abs(n.y));

    float dmax  = floor(1.0 + uStrength * MAX_PX + 0.5);
    float rings = clamp(dmax + 1.0, 2.0, RINGS);
    float band  = min(floor((1.0 - m) * rings), rings - 1.0);
    // The innermost block sits on the optical axis, so it is not displaced.
    float d = band >= rings - 1.0 ? 0.0 : floor(dmax * (rings - band) / rings + 0.5);

    vec2 axis = abs(n.y) >= abs(n.x) ? vec2(0.0, sign(n.y)) : vec2(sign(n.x), 0.0);
    // One design pixel, in the texture coordinates of this pass.
    vec2 texel = (uOutputFrame.zw * uInputSize.zw) / uFrameSize;
    vec2 shift = axis * d * texel;

    // Pulling the sample back is the same as pushing the copy out: red spreads
    // outward and blue contracts inward, so edges fringe red on the outside and
    // cyan-blue on the inside, exactly like cheap glass.
    vec3 red  = frameSample(vTextureCoord - shift);
    vec3 blue = frameSample(vTextureCoord + shift);
    // Python truncates the interpolated tint to an integer 0..255.
    float mask = floor(mix(MASK_MIN, MASK_MAX, uStrength)) / 255.0;

    // The channel copies are added; pygame saturates at 255 and so do we.
    vec3 rgb = min(base.rgb + vec3(red.r * mask, 0.0, blue.b * mask), vec3(1.0));
    finalColor = vec4(rgb, base.a);
}
`;

export class AberrationFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ fragment: FRAGMENT, vertex: defaultFilterVert, name: "neon-aberration" }),
      resources: {
        aberrationUniforms: {
          uStrength: { value: 0, type: "f32" },
          uFrameSize: { value: new Float32Array([WINDOW_W, WINDOW_H]), type: "vec2<f32>" },
        },
      },
      // The copies only ever move inward from the rim, so no padding is needed;
      // 'inherit' keeps the pass at the render target's resolution instead of
      // dropping the whole frame to 1 CSS px per texel.
      resolution: "inherit",
    });
  }

  /** 0..1, from `smoothstep(ABERRATION_START, ABERRATION_FULL, shake)`. */
  get strength(): number {
    return this.resources.aberrationUniforms.uniforms.uStrength as number;
  }

  set strength(value: number) {
    this.resources.aberrationUniforms.uniforms.uStrength = value;
  }

  /** The design-space size of the framed rect, so the offsets stay in design px. */
  setFrameSize(w: number, h: number): void {
    const size = this.resources.aberrationUniforms.uniforms.uFrameSize as Float32Array;
    size[0] = w;
    size[1] = h;
  }
}
