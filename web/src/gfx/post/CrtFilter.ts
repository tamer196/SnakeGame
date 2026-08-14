/**
 * The CRT overlay: vignette, squircle edge rolloff, rounded corner cut,
 * scanlines and the glass rim highlight, in one pass.
 *
 * `effects.py` bakes all of this into cached surfaces because evaluating it per
 * pixel on a CPU is out of the question; it then splits the result into an
 * opaque multiply half and an additive rim, which is a pygame blit-cost trick
 * with no GPU equivalent. What survives the translation is the *arithmetic*:
 *
 *   overlay = pure black at alpha (vignette + curvature + corner + scanlines),
 *             tinted (2, 3, 9) because the vignette layer carries that colour
 *             and the others add nothing to its RGB
 *   frame  *= (1 - a) + tint * a          <- exactly the multiply pygame bakes
 *   frame  += rim * 30/255                <- a light colour cannot ride a multiply
 *
 * Note this is a multiply, not a mix toward the tint: at the corners, where the
 * alphas compound past 0.7, the difference is the whole reason the tuning
 * comment in the Python exists. The corners must keep more than 40% of their
 * light (`tools/playtest.py` enforces `BEZEL_FLOOR`) or the settings title and
 * the level-select star readout stop being readable - do not "improve" these
 * curves.
 *
 * There is **no per-pixel warp**. The curvature is entirely an overlay
 * illusion: a squircle band hugging the rim, plus the hard corner cut that
 * sells the tube.
 *
 * Two deliberate departures: the ramps are evaluated analytically rather than
 * on Python's 160x90 and 128x72 grids (they are closed-form and have no high
 * frequencies to lose, and the spec offers this explicitly), and the corner cut
 * and rim are antialiased over one design pixel. Python rasterises them hard at
 * 720p and then smooth-scales the whole frame to the window, so a hard cut at
 * device resolution would be *harsher* than the original, not truer to it.
 */

import { defaultFilterVert, Filter, GlProgram } from "pixi.js";

import { WINDOW_H, WINDOW_W } from "../../core/config";

/** Constant, not themed (effects.py:115). */
const VIGNETTE_TINT: readonly [number, number, number] = [2, 3, 9];
/** Peak alpha at the very corners, 0..1. */
const VIGNETTE_STRENGTH = 0.42;
/** Normalised radius where the darkening starts. */
const VIGNETTE_INNER = 0.55;

/** Peak alpha of the squircle edge rolloff. */
const CURVATURE_STRENGTH = 0.28;
/** Squircle radius where the rolloff starts. */
const CURVATURE_INNER = 0.8;
/** Corner cut radius as a fraction of min(w, h) - 21 px at 720. */
const CURVATURE_CORNER = 0.03;
const CURVATURE_RIM: readonly [number, number, number] = [150, 176, 214];
const CURVATURE_RIM_ALPHA = 30;

/** One dark line every N rows ... */
const SCANLINE_GAP = 3;
/** ... at this alpha. Very subtle - it should read as texture, not stripes. */
const SCANLINE_ALPHA = 15;

const rim = (i: number): number =>
  ((CURVATURE_RIM[i] ?? 0) / 255) * (CURVATURE_RIM_ALPHA / 255);

const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform highp vec4 uOutputFrame;

uniform vec2 uFrameSize;
uniform float uCornerRadius;
uniform float uVignette;
uniform float uCurvature;
uniform float uScanlines;

const vec3 TINT = vec3(${(VIGNETTE_TINT[0] / 255).toFixed(6)}, ${(VIGNETTE_TINT[1] / 255).toFixed(6)}, ${(VIGNETTE_TINT[2] / 255).toFixed(6)});
const vec3 RIM = vec3(${rim(0).toFixed(6)}, ${rim(1).toFixed(6)}, ${rim(2).toFixed(6)});
const float SCAN_GAP = ${SCANLINE_GAP.toFixed(1)};
const float SCAN_ALPHA = ${(SCANLINE_ALPHA / 255).toFixed(6)};

// Signed distance to a rounded rectangle centred on the origin, in design px.
float roundedRect(vec2 p, vec2 halfSize, float r) {
    vec2 d = abs(p) - halfSize + vec2(r);
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main(void)
{
    vec4 src = texture(uTexture, vTextureCoord);
    vec2 uv = vTextureCoord * uInputSize.xy / uOutputFrame.zw;
    vec2 n = uv * 2.0 - 1.0;

    // Vignette: Euclidean radius scaled so the corners land at 1. The ^1.6
    // keeps the centre perfectly clean and bites hard at the rim.
    float vr = length(n) * 0.70710678;
    float vig = pow(smoothstep(${VIGNETTE_INNER.toFixed(2)}, 1.0, vr), 1.6) * ${VIGNETTE_STRENGTH.toFixed(2)} * uVignette;

    // Curvature: a squircle (|x|^4 + |y|^4)^(1/4), which darkens the whole rim
    // in a band rather than only the corners - what the part of a real tube
    // that turns away from you actually looks like.
    vec2 n2 = n * n;
    float e = pow(dot(n2, n2), 0.25);
    float crv = pow(smoothstep(${CURVATURE_INNER.toFixed(2)}, 1.02, e), 1.35) * ${CURVATURE_STRENGTH.toFixed(2)};

    // Hard rounded corner cut, opaque, and the 2 px glass rim just inside it.
    vec2 p = (uv - 0.5) * uFrameSize;
    vec2 halfSize = uFrameSize * 0.5;
    float cut = clamp(roundedRect(p, halfSize, uCornerRadius) + 0.5, 0.0, 1.0);
    float rimSdf = roundedRect(p, halfSize - vec2(1.0), uCornerRadius);
    float rimBand = clamp(min(rimSdf + 2.0, -rimSdf) + 0.5, 0.0, 1.0);

    float scan = (1.0 - step(1.0, mod(floor(uv.y * uFrameSize.y), SCAN_GAP))) * SCAN_ALPHA * uScanlines;

    // All four layers are one overlay in the Python, so their alphas sum and
    // saturate together before the single multiply. With the vignette off that
    // overlay is pure black, tint included - hence the mask on TINT.
    float a = clamp(vig + (crv + cut) * uCurvature + scan, 0.0, 1.0);
    vec3 rgb = src.rgb * mix(vec3(1.0), TINT * uVignette, a);
    rgb += RIM * rimBand * uCurvature;

    finalColor = vec4(min(rgb, vec3(1.0)), src.a);
}
`;

export class CrtFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ fragment: FRAGMENT, vertex: defaultFilterVert, name: "neon-crt" }),
      resources: {
        crtUniforms: {
          uFrameSize: { value: new Float32Array([WINDOW_W, WINDOW_H]), type: "vec2<f32>" },
          uCornerRadius: { value: 0, type: "f32" },
          uVignette: { value: 1, type: "f32" },
          uCurvature: { value: 1, type: "f32" },
          uScanlines: { value: 1, type: "f32" },
        },
      },
      resolution: "inherit",
    });
    this.setFrameSize(WINDOW_W, WINDOW_H);
  }

  /**
   * Re-frame the overlay. The corner radius follows Python's
   * `int(CURVATURE_CORNER * min(w, h))` - truncated, not rounded.
   */
  setFrameSize(w: number, h: number): void {
    const uniforms = this.resources.crtUniforms.uniforms;
    const size = uniforms.uFrameSize as Float32Array;
    size[0] = w;
    size[1] = h;
    uniforms.uCornerRadius = Math.floor(CURVATURE_CORNER * Math.min(w, h));
  }

  /** The three layers the settings screen and the quality presets gate. */
  setLayers(vignette: boolean, curvature: boolean, scanlines: boolean): void {
    const uniforms = this.resources.crtUniforms.uniforms;
    uniforms.uVignette = vignette ? 1 : 0;
    uniforms.uCurvature = curvature ? 1 : 0;
    uniforms.uScanlines = scanlines ? 1 : 0;
  }
}
