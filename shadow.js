// Renders sunlit terrain from a Web Mercator elevation grid with WebGL2.
// A pixel is lit when its slope faces the sun and no terrain between it and
// the sun rises above the ray toward the sun (cast shadows).

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uDem;   // meters, row 0 = north edge
uniform ivec2 uSize;      // grid size in pixels
uniform float uWorldPx;   // 256 * 2^z, the world width in grid pixels
uniform float uOriginY;   // global pixel row of the grid's north edge
uniform vec3 uSun;        // unit vector toward the sun: east, north, up
uniform float uMaxElev;
uniform vec3 uColor;
out vec4 outColor;

const float PI = 3.141592653589793;
const int MAX_STEPS = 1500;

float elev(ivec2 p) { return texelFetch(uDem, clamp(p, ivec2(0), uSize - 1), 0).r; }

void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), uSize.y - 1 - int(gl_FragCoord.y));
  outColor = vec4(0.0);
  if (uSun.z <= 0.0) return;

  float gy = (uOriginY + float(p.y) + 0.5) / uWorldPx;
  float lat = atan(sinh(PI * (1.0 - 2.0 * gy)));
  float pix = 40075016.686 * cos(lat) / uWorldPx; // meters per grid pixel

  float e = elev(p);
  float dzdx = (elev(p + ivec2(1, 0)) - elev(p - ivec2(1, 0))) / (2.0 * pix);
  float dzdn = (elev(p - ivec2(0, 1)) - elev(p + ivec2(0, 1))) / (2.0 * pix);
  vec3 n = normalize(vec3(-dzdx, -dzdn, 1.0));
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
      if (texelFetch(uDem, ivec2(s), 0).r > h + 1.0) return; // blocked
    }
  }
  float a = 0.35 + 0.65 * incidence;
  outColor = vec4(uColor * a, a); // premultiplied
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class ShadowRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const name of ['uDem', 'uSize', 'uWorldPx', 'uOriginY', 'uSun', 'uMaxElev', 'uColor']) {
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
    gl.uniform3f(this.u.uColor, 1.0, 0.82, 0.12);
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
    gl.uniform1f(this.u.uMaxElev, grid.maxElev);
  }

  /** azimuth: radians clockwise from north; altitude: radians above the horizon. */
  render(azimuth, altitude) {
    if (!this.grid) return;
    const gl = this.gl;
    const c = Math.cos(altitude);
    gl.uniform3f(this.u.uSun, Math.sin(azimuth) * c, Math.cos(azimuth) * c, Math.sin(altitude));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
