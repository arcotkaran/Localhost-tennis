// Split-screen camera configuration for the TV renderer.
//
// 1v1 / 2v2: a two-way split that defaults to top-and-bottom bands but can be
// toggled to side-by-side. Side-by-side gives each player a TALLER viewport
// that fits the long court (less cut off behind the baseline); top/bottom gives
// a wider cinematic band. Cameras are pulled back and raised so the whole court
// — including the area behind each player — stays in frame.

export function splitScreenLayout(mode, screenW, screenH, orientation = 'horizontal') {
  switch (mode) {
    case 'single': // one player vs AI — full screen broadcast camera
      return {
        viewports: [
          { x: 0, y: 0, w: screenW, h: screenH, team: 0,
            camera: thirdPersonCamera(screenW / screenH, 'broadcast') },
        ],
        split: 'none',
      };
    case '1v1':
    case '2v2': {
      const preset = mode === '2v2' ? 'doubles' : 'singles';
      let viewports;
      if (orientation === 'vertical') {
        // Side-by-side: each player gets a tall half (fits the long court).
        const halfW = Math.floor(screenW / 2);
        viewports = [
          { x: 0, y: 0, w: halfW, h: screenH, team: 0 },
          { x: halfW, y: 0, w: screenW - halfW, h: screenH, team: 1 },
        ];
      } else {
        // Top-and-bottom: each player gets a full-width cinematic band.
        const halfH = Math.floor(screenH / 2);
        viewports = [
          { x: 0, y: 0, w: screenW, h: halfH, team: 0 },
          { x: 0, y: halfH, w: screenW, h: screenH - halfH, team: 1 },
        ];
      }
      for (const v of viewports) v.camera = thirdPersonCamera(v.w / v.h, preset);
      return { viewports, split: orientation };
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

// Third-person camera presets. Pulled back and raised (vs. earlier, tighter
// framing) so the full court length — and the room BEHIND each player — stays
// visible in the short split bands. Doubles is the most expansive (partner
// positioning); singles a touch tighter; broadcast (single player) widest.
export function thirdPersonCamera(aspect, preset) {
  const presets = {
    broadcast: { fov: 54, height: 8.5, behind: 16.0 },
    singles:   { fov: 50, height: 6.5, behind: 13.0 },
    doubles:   { fov: 60, height: 7.5, behind: 15.0 }, // expansive landscape view
  };
  const p = presets[preset];
  return {
    type: 'third-person', preset, aspect,
    fov: p.fov, position: { x: 0, y: p.height, z: p.behind },
    lookAt: { x: 0, y: 0.5, z: -4 },
  };
}
