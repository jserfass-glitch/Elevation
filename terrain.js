// WebGL2 overlays computed from a Web Mercator elevation grid.
//
// SunRenderer: shades ground in shadow. A pixel is lit when its slope faces the sun and no terrain
// between it and the sun rises above the ray toward the sun (cast shadows).
// AspectRenderer: a pixel is shaded when the direction its slope faces falls
// inside a compass arc.

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Shared by both shaders: grid lookup, pixel size and slope gradient.
const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uDem;   // meters, row 0 = north edge
uniform ivec2 uSize;      // grid size in pixels
uniform float uWorldPx;   // 256 * 2^z, the world width in grid pixels
uniform float uOriginY;   // global pixel row of the grid's north edge
uniform vec3 uColor;
out vec4 outColor;

const float PI = 3.141592653589793;

float elev(ivec2 p) { return texelFetch(uDem, clamp(p, ivec2(0), uSize - 1), 0).r; }

ivec2 gridPixel() { return ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y)); }

// Meters per grid pixel at this row (Mercator scale varies with latitude).
float pixelMeters(ivec2 p) {
  float gy = (uOriginY + float(p.y) + 0.5) / uWorldPx;
  float lat = atan(sinh(PI * (1.0 - 2.0 * gy)));
  return 40075016.686 * cos(lat) / uWorldPx;
}

// Elevation gradient (east, north) in m/m, Horn's 3x3 method.
vec2 gradient(ivec2 p, float pix) {
  float a = elev(p + ivec2(-1, -1)), b = elev(p + ivec2(0, -1)), c = elev(p + ivec2(1, -1));
  float d = elev(p + ivec2(-1, 0)),                              f = elev(p + ivec2(1, 0));
  float g = elev(p + ivec2(-1, 1)),  h = elev(p + ivec2(0, 1)),  i = elev(p + ivec2(1, 1));
  float dzdx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * pix);
  float dzdn = ((a + 2.0 * b + c) - (g + 2.0 * h + i)) / (8.0 * pix); // row 0 is north
  return vec2(dzdx, dzdn);
}
`;

const SUN_FRAGMENT = `${COMMON}
uniform vec3 uSun;        // unit vector toward the sun: east, north, up
uniform float uMaxElev;
const int MAX_STEPS = 1500;
const float MAX_ALPHA = 0.7;

// Shadowed ground gets a dark veil and sunlit ground is left clear, so the
// map and other overlays stay readable where the sun is. Slopes the sun only
// grazes fade in gradually instead of switching on at a hard edge.
void main() {
  ivec2 p = gridPixel();
  vec4 shadow = vec4(uColor * MAX_ALPHA, MAX_ALPHA); // premultiplied
  outColor = shadow;
  if (uSun.z <= 0.0) return; // sun below the horizon

  float pix = pixelMeters(p);
  float e = elev(p);
  vec2 grad = gradient(p, pix);
  vec3 n = normalize(vec3(-grad, 1.0));
  float incidence = dot(n, uSun);
  if (incidence <= 0.0) return; // slope faces away from the sun

  float hl = length(uSun.xy);
  if (hl > 1e-4) {
    vec2 dir = vec2(uSun.x, -uSun.y) / hl; // grid y points south
    float rise = pix * uSun.z / hl;        // ray height gained per pixel
    vec2 q = vec2(p) + 0.5;
    for (int i = 1; i < MAX_STEPS; i++) {
      float h = e + float(i) * rise;
      if (h > uMaxElev) break;
      vec2 s = q + dir * float(i);
      if (s.x < 0.0 || s.y < 0.0 || s.x >= float(uSize.x) || s.y >= float(uSize.y)) break;
      if (texelFetch(uDem, ivec2(s), 0).r > h + 1.0) return; // blocked by terrain
    }
  }
  outColor = shadow * (1.0 - smoothstep(0.0, 0.2, incidence));
}`;

const ASPECT_FRAGMENT = `${COMMON}
uniform float uFrom;      // arc start, radians clockwise from north
uniform float uSpan;      // arc width clockwise from uFrom, radians
uniform float uMinSlope;  // tan of the gentlest slope that counts

const float SOFT = 0.07;    // radians (~4°) of fade at each edge of the arc

void main() {
  ivec2 p = gridPixel();
  float pix = pixelMeters(p);
  // Average the gradient over the 3x3 neighborhood to smooth DEM noise.
  vec2 grad = vec2(0.0);
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) grad += gradient(p + ivec2(dx, dy), pix);
  grad /= 9.0;

  float steep = smoothstep(uMinSlope * 0.7, uMinSlope * 1.3, length(grad)); // flat ground faces no direction
  float facing = atan(-grad.x, -grad.y); // downhill direction, clockwise from north
  float rel = mod(facing - uFrom, 2.0 * PI);
  // Signed angular distance inside the arc (negative outside), faded at the edges.
  float inside = rel <= uSpan ? min(rel, uSpan - rel) : -min(rel - uSpan, 2.0 * PI - rel);
  float within = uSpan >= 2.0 * PI - 1e-3 ? 1.0 : smoothstep(-SOFT, SOFT, inside);
  float a = 0.85 * steep * within;
  outColor = vec4(uColor * a, a); // premultiplied
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

class GridRenderer {
  constructor(canvas, fragment, uniforms, color) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const name of ['uDem', 'uSize', 'uWorldPx', 'uOriginY', 'uColor', ...uniforms]) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    // One triangle covering the viewport.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.u.uDem, 0);
    gl.uniform3f(this.u.uColor, ...color);
    this.grid = null;
  }

  /** grid: { data: Float32Array, width, height, z, originY (global pixel row), maxElev } */
  setGrid(grid) {
    const gl = this.gl;
    this.grid = grid;
    this.canvas.width = grid.width;
    this.canvas.height = grid.height;
    gl.viewport(0, 0, grid.width, grid.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, grid.width, grid.height, 0, gl.RED, gl.FLOAT, grid.data);
    gl.uniform2i(this.u.uSize, grid.width, grid.height);
    gl.uniform1f(this.u.uWorldPx, 256 * 2 ** grid.z);
    gl.uniform1f(this.u.uOriginY, grid.originY);
  }

  draw() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export class SunRenderer extends GridRenderer {
  constructor(canvas) {
    super(canvas, SUN_FRAGMENT, ['uSun', 'uMaxElev'], [0.06, 0.1, 0.26]);
  }

  setGrid(grid) {
    super.setGrid(grid);
    this.gl.uniform1f(this.u.uMaxElev, grid.maxElev);
  }

  /** azimuth: radians clockwise from north; altitude: radians above the horizon. */
  render(azimuth, altitude) {
    if (!this.grid) return;
    const gl = this.gl;
    const c = Math.cos(altitude);
    gl.uniform3f(this.u.uSun, Math.sin(azimuth) * c, Math.cos(azimuth) * c, Math.sin(altitude));
    this.draw();
  }
}

export class AspectRenderer extends GridRenderer {
  constructor(canvas) {
    super(canvas, ASPECT_FRAGMENT, ['uFrom', 'uSpan', 'uMinSlope'], [0.42, 0.25, 0.95]);
    this.gl.uniform1f(this.u.uMinSlope, Math.tan((5 * Math.PI) / 180));
  }

  /** Shades slopes facing clockwise from `fromDeg` to `toDeg` (compass degrees). */
  render(fromDeg, toDeg) {
    if (!this.grid) return;
    const span = (((toDeg - fromDeg) % 360) + 360) % 360;
    this.gl.uniform1f(this.u.uFrom, (fromDeg * Math.PI) / 180);
    this.gl.uniform1f(this.u.uSpan, ((span || 360) * Math.PI) / 180);
    this.draw();
  }
}
