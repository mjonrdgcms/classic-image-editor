/**
 * GLSL for the compositor. The blend math mirrors src/core/blend.ts exactly;
 * the e2e suite compares the two for every mode.
 */

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
// A quad covering the current viewport (scissor narrows it further).
const vec2 P[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

/**
 * Blend one layer tile over the backdrop. Coordinates: gl_FragCoord in the
 * 256x256 work buffer = canvas pixel - uTileOrigin.
 */
export const BLEND_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBackdrop;   // work buffer (what's below)
uniform sampler2D uSource;     // assembled layer source (or a finished set), same 256 space
uniform sampler2D uClip;       // clipping base alpha
uniform int uUseClip;
uniform ivec2 uTileOrigin;     // canvas position of the work buffer
uniform int uMode;
uniform float uOpacity;
out vec4 outColor;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}

float colorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float colorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float screenF(float b, float s) { return b + s - b * s; }
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : screenF(b, 2.0 * s - 1.0); }
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float vividLight(float b, float s) { return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * s - 1.0); }
float pinLight(float b, float s) { return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0); }

float sep(int m, float b, float s) {
  if (m == 2) return min(b, s);
  if (m == 3) return b * s;
  if (m == 4) return colorBurn(b, s);
  if (m == 5) return clamp(b + s - 1.0, 0.0, 1.0);
  if (m == 6) return max(b, s);
  if (m == 7) return screenF(b, s);
  if (m == 8) return colorDodge(b, s);
  if (m == 9) return clamp(b + s, 0.0, 1.0);
  if (m == 10) return hardLight(s, b);
  if (m == 11) return softLight(b, s);
  if (m == 12) return hardLight(b, s);
  if (m == 13) return vividLight(b, s);
  if (m == 14) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == 15) return pinLight(b, s);
  if (m == 16) return abs(b - s);
  if (m == 17) return b + s - 2.0 * b * s;
  return s;
}

vec3 blendRGB(int m, vec3 b, vec3 s) {
  if (m == 18) return setLum(setSat(s, sat(b)), lum(b));
  if (m == 19) return setLum(setSat(b, sat(s)), lum(b));
  if (m == 20) return setLum(s, lum(b));
  if (m == 21) return setLum(b, lum(s));
  return vec3(sep(m, b.r, s.r), sep(m, b.g, s.g), sep(m, b.b, s.b));
}

float dissolveHash(uvec2 p) {
  uint h = p.x * 374761393u + p.y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h & 0xffffffu) / 16777216.0;
}

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy);
  ivec2 canvas = uTileOrigin + local;
  vec4 bd = texelFetch(uBackdrop, local, 0);
  vec4 src = texelFetch(uSource, local, 0);
  float a = src.a;
  if (uUseClip == 1) a *= texelFetch(uClip, local, 0).a;
  float as = a * uOpacity;
  if (uMode == 1) as = dissolveHash(uvec2(canvas)) < as ? 1.0 : 0.0;
  if (as <= 0.0) { outColor = bd; return; }
  vec3 mixed = src.rgb;
  if (uMode > 1 && bd.a > 0.0) mixed = (1.0 - bd.a) * src.rgb + bd.a * blendRGB(uMode, bd.rgb, src.rgb);
  float ao = as + bd.a * (1.0 - as);
  outColor = vec4((mixed * as + bd.rgb * bd.a * (1.0 - as)) / ao, ao);
}
`;

/**
 * Assemble a layer's source for one work tile: its pixels with the layer
 * mask multiplied into alpha. Drawn once per overlapping layer tile.
 */
export const ASSEMBLE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTile;       // layer pixels tile (RGBA)
uniform sampler2D uMaskTex;    // layer mask tile (R)
uniform int uMaskMode;         // 0 none, 1 texture, 2 constant
uniform float uMaskValue;      // constant mask value (0..1)
uniform ivec2 uTileOrigin;     // canvas position of the work buffer
uniform ivec2 uSourceOrigin;   // canvas position of the layer tile's (0,0)
uniform sampler2D uGMaskTex;   // Pass Through set's mask tile, aligned with the work tile
uniform int uGMaskMode;        // 0 none, 1 texture, 2 constant
uniform float uGMaskValue;
out vec4 outColor;
void main() {
  ivec2 canvas = uTileOrigin + ivec2(gl_FragCoord.xy);
  ivec2 t = canvas - uSourceOrigin;
  vec4 c = texelFetch(uTile, t, 0);
  float m = 1.0;
  if (uMaskMode == 1) m = texelFetch(uMaskTex, t, 0).r;
  else if (uMaskMode == 2) m = uMaskValue;
  if (uGMaskMode == 1) m *= texelFetch(uGMaskTex, ivec2(gl_FragCoord.xy), 0).r;
  else if (uGMaskMode == 2) m *= uGMaskValue;
  outColor = vec4(c.rgb, c.a * m);
}
`;

/** Multiply a work buffer's alpha by a mask tile (an isolated set's mask). */
export const MASKMUL_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSource;
uniform sampler2D uMaskTex;
uniform int uMaskMode;   // 1 texture, 2 constant
uniform float uMaskValue;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uSource, p, 0);
  float m = uMaskMode == 1 ? texelFetch(uMaskTex, p, 0).r : uMaskValue;
  outColor = vec4(c.rgb, c.a * m);
}
`;

/** Fade a Pass Through set's effect by its opacity and mask (premultiplied mix). */
export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSaved;
uniform sampler2D uCurrent;
uniform float uOpacity;
uniform sampler2D uMaskTex;
uniform int uMaskMode;   // 0 none, 1 texture, 2 constant
uniform float uMaskValue;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSaved, p, 0);
  vec4 c = texelFetch(uCurrent, p, 0);
  float m = uMaskMode == 1 ? texelFetch(uMaskTex, p, 0).r : uMaskMode == 2 ? uMaskValue : 1.0;
  float t = uOpacity * m;
  float a = s.a * (1.0 - t) + c.a * t;
  if (a <= 0.0) { outColor = vec4(0.0); return; }
  outColor = vec4((s.rgb * s.a * (1.0 - t) + c.rgb * c.a * t) / a, a);
}
`;

/** Draw the composite to the screen over a checkerboard, with zoom and pan. */
export const DISPLAY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uDocSize;      // canvas pixels
uniform vec2 uOffset;       // device px of the canvas's top-left on screen
uniform float uZoom;        // device px per canvas pixel
uniform float uScreenH;     // device px
uniform vec3 uPasteboard;
uniform vec3 uCheckA;
uniform vec3 uCheckB;
uniform float uCheckSize;   // device px
uniform sampler2D uSel;     // overlay mask (R): Quick Mask or the viewed layer mask
uniform int uOverlay;       // 0 none, 1 tinted overlay, 2 mask in grayscale
uniform vec3 uOverlayColor;
uniform float uOverlayOpacity;
out vec4 outColor;
void main() {
  vec2 screen = vec2(gl_FragCoord.x, uScreenH - gl_FragCoord.y);
  vec2 doc = (screen - uOffset) / uZoom;
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= uDocSize.x || doc.y >= uDocSize.y) {
    outColor = vec4(uPasteboard, 1.0);
    return;
  }
  vec2 cell = floor((screen - uOffset) / uCheckSize);
  vec3 check = mod(cell.x + cell.y, 2.0) < 1.0 ? uCheckA : uCheckB;
  vec4 c = texture(uImage, doc / uDocSize);
  vec3 rgb = mix(check, c.rgb, c.a);
  if (uOverlay == 1) {
    // Quick Mask / rubylith: masked areas tinted (50% red by default, as in PS7).
    float sel = texture(uSel, doc / uDocSize).r;
    rgb = mix(rgb, uOverlayColor, uOverlayOpacity * (1.0 - sel));
  } else if (uOverlay == 2) {
    rgb = vec3(texture(uSel, doc / uDocSize).r);
  }
  outColor = vec4(rgb, 1.0);
}
`;
