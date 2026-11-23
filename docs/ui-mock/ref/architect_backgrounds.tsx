import React, { useState, useEffect, useRef } from 'react';

// === 頂点シェーダー（全画面クワッド） ===
const VERTEX_SHADER = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// === フラグメントシェーダー（Modern Blueprint + ライト/ダーク対応） ===
const FRAGMENT_SHADER = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_time;
  uniform float u_isDark; // 1.0 = Dark, 0.0 = Light

  // 高周波フィルムグレイン・ハッシュ関数
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // --- 2D距離関数 (SDF) による精密な大工・設計道具の描画 ---
  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  float sdSegment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  // 6種類の大工・設計道具の形状を返すSDF
  float sdCarpenterTool(vec2 p, int type) {
    if (type == 0) {
      // 1. 差し金 (L字定規)
      float d1 = sdBox(p - vec2(-0.12, 0.0), vec2(0.035, 0.24));
      float d2 = sdBox(p - vec2(0.03, -0.205), vec2(0.18, 0.035));
      return min(d1, d2);
    } else if (type == 1) {
      // 2. 製図用コンパス
      float head = length(p - vec2(0.0, 0.22)) - 0.035;
      float leg1 = sdSegment(p, vec2(0.0, 0.20), vec2(-0.14, -0.22)) - 0.016;
      float leg2 = sdSegment(p, vec2(0.0, 0.20), vec2(0.14, -0.22)) - 0.016;
      float arc  = abs(length(p - vec2(0.0, 0.20)) - 0.16) - 0.008;
      arc = max(arc, p.y - 0.12);
      arc = max(arc, -p.y - 0.05);
      return min(min(head, min(leg1, leg2)), arc);
    } else if (type == 2) {
      // 3. 金槌 (ハンマー)
      float handle = sdBox(p - vec2(0.0, -0.05), vec2(0.022, 0.22));
      float head   = sdBox(p - vec2(0.0, 0.15), vec2(0.14, 0.038));
      return min(handle, head);
    } else if (type == 3) {
      // 4. ノコギリ (手鋸)
      float handle = sdBox(p - vec2(-0.18, -0.02), vec2(0.055, 0.032));
      float blade  = sdBox(p - vec2(0.06, 0.0), vec2(0.20, 0.045));
      // 刃のギザギザ
      float teeth  = abs(fract((p.x + 0.14) * 28.0) - 0.5) * 0.025;
      blade += step(p.y, -0.03) * teeth;
      return min(handle, blade);
    } else if (type == 4) {
      // 5. ノミ (鑿)
      float grip   = sdBox(p - vec2(0.0, -0.14), vec2(0.032, 0.11));
      float neck   = sdBox(p - vec2(0.0, 0.0), vec2(0.015, 0.04));
      float blade  = sdBox(p - vec2(0.0, 0.13), vec2(0.026, 0.10));
      return min(min(grip, neck), blade);
    } else {
      // 6. 製図用鉛筆 / 墨坪の針
      float body = sdBox(p - vec2(0.0, -0.02), vec2(0.024, 0.20));
      float tip  = sdSegment(p, vec2(0.0, 0.18), vec2(0.0, 0.26)) - mix(0.024, 0.002, clamp((p.y - 0.18) / 0.08, 0.0, 1.0));
      return min(body, tip);
    }
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;
    vec2 p = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
    float t = u_time;

    // 1. 大きく引いたアイソメトリック（等角投影）3D空間 (zoomOut = 6.8)
    float zoomOut = 6.8;
    float tilt = mix(0.88, 1.0, uv.y);
    float angle = 0.42;
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    
    vec2 worldXZ = rot * vec2(p.x * tilt * zoomOut, p.y * tilt * 1.15 * zoomOut);
    worldXZ += vec2(t * 0.03, t * 0.045);

    // 2. 途中で途切れない、均等で美しい2段階の建築方眼グリッド
    vec2 subGrid = abs(fract(worldXZ * 2.5) - 0.5);
    float lineSub = 1.0 - smoothstep(0.0, 0.045, min(0.5 - subGrid.x, 0.5 - subGrid.y));

    vec2 mainGrid = abs(fract(worldXZ * 0.5) - 0.5);
    float lineMain = 1.0 - smoothstep(0.0, 0.016, min(0.5 - mainGrid.x, 0.5 - mainGrid.y));

    // 交点の極小十字マーカー（主グリッドの交点に控えめに配置）
    vec2 cellLocal = fract(worldXZ * 0.5);
    float distToCrossX = min(cellLocal.x, 1.0 - cellLocal.x);
    float distToCrossY = min(cellLocal.y, 1.0 - cellLocal.y);
    float crossArm = 1.0 - smoothstep(0.006, 0.011, min(distToCrossX, distToCrossY));
    float crossLen = 1.0 - smoothstep(0.035, 0.042, max(distToCrossX, distToCrossY));
    float crosshair = crossArm * crossLen;

    // 3. 3D空間に浮遊する大工道具＆光の塵パーティクル（多層パララックス）
    vec3 toolColorAccum = vec3(0.0);
    float toolAlphaAccum = 0.0;
    float dustParticles = 0.0;

    // 3-A. 大工・設計道具のシルエットパーティクル（2レイヤー：手前と奥）
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float layerScale = 2.6 + fi * 1.6;
      vec2 tCoord = p * layerScale + vec2(t * (0.045 - fi * 0.015), -t * (0.055 - fi * 0.02)) + fi * 31.7;
      vec2 tId = floor(tCoord);
      vec2 tLocal = fract(tCoord) - 0.5;

      float rnd = hash(tId);
      // セルの約32%に道具を配置
      if (rnd > 0.68) {
        vec2 floatOffset = vec2(
          sin(t * 0.6 + rnd * 10.0) * 0.14 + (hash(tId + 1.3) - 0.5) * 0.25,
          cos(t * 0.5 + rnd * 14.0) * 0.14 + (hash(tId + 2.7) - 0.5) * 0.25
        );
        vec2 localPos = tLocal - floatOffset;

        float rotAngle = t * (0.25 + (rnd - 0.5) * 0.4) + rnd * 6.28;
        mat2 tRot = mat2(cos(rotAngle), -sin(rotAngle), sin(rotAngle), cos(rotAngle));
        localPos = tRot * localPos;

        float itemScale = (0.42 - fi * 0.11);
        int toolType = int(mod(floor(rnd * 60.0), 6.0));
        float dTool = sdCarpenterTool(localPos / itemScale, toolType) * itemScale;

        // 道具ごとのカラフルなアクセントカラー割り当て
        vec3 itemCol = vec3(0.3, 0.7, 1.0);
        if (toolType == 0) {
          // 差し金: 真鍮・アンバーゴールド
          itemCol = u_isDark > 0.5 ? vec3(0.98, 0.75, 0.25) : vec3(0.76, 0.46, 0.02);
        } else if (toolType == 1) {
          // コンパス: ブループリント・シアン
          itemCol = u_isDark > 0.5 ? vec3(0.25, 0.85, 0.98) : vec3(0.04, 0.42, 0.76);
        } else if (toolType == 2) {
          // 金槌: テラコッタ・オレンジ
          itemCol = u_isDark > 0.5 ? vec3(0.98, 0.52, 0.30) : vec3(0.82, 0.28, 0.06);
        } else if (toolType == 3) {
          // ノコギリ: エメラルド・グリーン
          itemCol = u_isDark > 0.5 ? vec3(0.25, 0.90, 0.62) : vec3(0.06, 0.52, 0.32);
        } else if (toolType == 4) {
          // ノミ: ロイヤル・バイオレット
          itemCol = u_isDark > 0.5 ? vec3(0.72, 0.55, 0.98) : vec3(0.38, 0.20, 0.72);
        } else {
          // 鉛筆（朱入れ）: コーラル・レッド
          itemCol = u_isDark > 0.5 ? vec3(0.98, 0.42, 0.52) : vec3(0.78, 0.14, 0.24);
        }

        float outline = 1.0 - smoothstep(0.0, 0.006, abs(dTool));
        float fill = 1.0 - smoothstep(-0.005, 0.004, dTool);
        float fade = 0.65 + 0.35 * sin(t * 0.8 + rnd * 9.0);
        float alpha = (outline * 0.9 + fill * 0.26) * fade * (0.9 - fi * 0.3);

        toolColorAccum += itemCol * alpha;
        toolAlphaAccum = clamp(toolAlphaAccum + alpha, 0.0, 1.0);
      }
    }

    // 3-B. 空間を漂う微細な光の塵（ダスト）
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      float layerScale = 7.0 + fi * 4.0;
      vec2 pCoord = p * layerScale + vec2(t * (0.03 + fi * 0.02), -t * (0.05 + fi * 0.02)) + fi * 17.3;
      vec2 pId = floor(pCoord);
      vec2 pLocal = fract(pCoord) - 0.5;
      
      float rnd = hash(pId);
      if (rnd > 0.82) {
        vec2 offset = vec2(hash(pId + 1.1) - 0.5, hash(pId + 2.2) - 0.5) * 0.65;
        float d = length(pLocal - offset);
        float twinkle = 0.5 + 0.5 * sin(t * (1.5 + rnd * 2.0) + rnd * 12.0);
        float dotRadius = 0.028 - fi * 0.005;
        dustParticles += smoothstep(dotRadius, dotRadius * 0.1, d) * twinkle * (0.7 - fi * 0.2);
      }
    }

    // 4. 画面全体へ自然に溶け込む環境光とビネット
    float edgeMask = 1.0 - smoothstep(0.60, 1.85, length(p * vec2(0.68, 0.88)));
    vec2 lightCenter = vec2(sin(t * 0.22) * 0.35, 0.15 + cos(t * 0.18) * 0.15);
    float ambientGlow = exp(-length(p - lightCenter) * 1.05);
    float paperGrain = (hash(gl_FragCoord.xy) - 0.5) * 0.012;

    vec3 finalColor = vec3(0.0);

    if (u_isDark > 0.5) {
      // ダーク: 深いブループリント空間 × 均一で上品な方眼 × 浮遊する大工道具
      vec3 bgBase = vec3(0.022, 0.035, 0.062);
      vec3 bgGlow = vec3(0.048, 0.095, 0.175);
      finalColor = mix(bgBase, bgGlow, ambientGlow * 0.85) + paperGrain;
      
      finalColor += vec3(0.22, 0.48, 0.78) * lineSub * 0.16 * edgeMask;
      finalColor += vec3(0.32, 0.62, 0.90) * lineMain * 0.28 * edgeMask;
      finalColor += vec3(0.85, 0.72, 0.45) * crosshair * 0.42 * edgeMask;
      
      finalColor += toolColorAccum * 0.72 * edgeMask;
      finalColor += vec3(0.65, 0.85, 1.0) * dustParticles * 0.45;
    } else {
      // ライト: 製図用紙の質感 × 均一で繊細なグレー方眼 × カラフルな大工道具パーティクル
      vec3 bgBase = vec3(0.945, 0.948, 0.952);
      vec3 bgGlow = vec3(0.99, 0.992, 0.995);
      finalColor = mix(bgBase, bgGlow, ambientGlow * 0.9) + paperGrain;

      vec3 subLineCol  = vec3(0.81, 0.825, 0.84);
      vec3 mainLineCol = vec3(0.66, 0.68, 0.71);
      vec3 markerCol   = vec3(0.42, 0.45, 0.49);
      vec3 particleCol = vec3(0.35, 0.42, 0.52);

      finalColor = mix(finalColor, subLineCol, lineSub * 0.45 * edgeMask);
      finalColor = mix(finalColor, mainLineCol, lineMain * 0.55 * edgeMask);
      finalColor = mix(finalColor, markerCol, crosshair * 0.65 * edgeMask);
      
      vec3 avgToolCol = toolAlphaAccum > 0.001 ? (toolColorAccum / toolAlphaAccum) : vec3(0.3);
      finalColor = mix(finalColor, avgToolCol, clamp(toolAlphaAccum * 0.88, 0.0, 0.92) * edgeMask);
      finalColor = mix(finalColor, particleCol, dustParticles * 0.42);
    }

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// === WebGL レンダラーコンポーネント ===
const ModernBlueprintBackground = ({ theme }) => {
  const canvasRef = useRef(null);
  const themeRef = useRef(theme);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      console.error('WebGL is not supported');
      return;
    }

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return;
    }

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const isDarkLocation = gl.getUniformLocation(program, 'u_isDark');

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    let animationFrameId;
    const startTime = performance.now();

    const render = () => {
      const currentTime = (performance.now() - startTime) * 0.001;

      gl.useProgram(program);
      gl.enableVertexAttribArray(positionLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, currentTime);
      gl.uniform1f(isDarkLocation, themeRef.current === 'dark' ? 1.0 : 0.0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(positionBuffer);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 w-full h-full pointer-events-none" />;
};

// === メインアプリケーション ===
export default function App() {
  const [theme, setTheme] = useState('dark');
  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  const isDark = theme === 'dark';

  return (
    <div className="relative min-h-screen w-full overflow-hidden font-sans select-none">
      {/* WebGL Modern Blueprint 背景 */}
      <ModernBlueprintBackground theme={theme} />

      {/* ライト/ダーク切り替えボタン */}
      <div
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center p-1.5 rounded-full backdrop-blur-xl border shadow-2xl transition-all duration-500"
        style={{
          backgroundColor: isDark ? 'rgba(15, 23, 42, 0.75)' : 'rgba(255, 255, 255, 0.85)',
          borderColor: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)',
        }}
      >
        <button
          onClick={toggleTheme}
          className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${
            isDark
              ? 'bg-white/10 hover:bg-white/20 text-white'
              : 'bg-black/5 hover:bg-black/10 text-slate-900'
          }`}
        >
          {isDark ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>
      </div>
    </div>
  );
}