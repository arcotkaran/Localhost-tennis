// Split-screen camera configuration for the TV renderer.
//
// 1v1:   side-by-side vertical split (each player sees their own end), with
//        a horizontal (top/bottom) variant for ultrawide displays.
// 2v2:   team-wise top-and-bottom split. Each half uses an expansive,
//        landscape third-person camera (wide FOV, pulled back and raised)
//        so both partners and their positioning stay visible.

export function splitScreenLayout(mode, screenW, screenH) {
  const aspect = screenW / screenH;
  switch (mode) {
    case 'single': // one player vs AI — full screen broadcast camera
      return {
        viewports: [
          { x: 0, y: 0, w: screenW, h: screenH, team: 0,
            camera: thirdPersonCamera(screenW / screenH, 'broadcast') },
        ],
      };
    case '1v1': {
      // Top-and-bottom split: each player gets a full-width cinematic band.
      // (Side-by-side halves squeeze the court into a corridor — rejected.)
      const viewports = [
        { x: 0, y: 0, w: screenW, h: screenH / 2, team: 0 },
        { x: 0, y: screenH / 2, w: screenW, h: screenH / 2, team: 1 },
      ];
      for (const v of viewports) v.camera = thirdPersonCamera(v.w / v.h, 'singles');
      return { viewports, split: 'horizontal' };
    }
    case '2v2': {
      // Team-wise top-and-bottom: each TEAM shares one expansive half.
      const viewports = [
        { x: 0, y: 0, w: screenW, h: screenH / 2, team: 0 },
        { x: 0, y: screenH / 2, w: screenW, h: screenH / 2, team: 1 },
      ];
      for (const v of viewports) v.camera = thirdPersonCamera(v.w / v.h, 'doubles');
      return { viewports, split: 'horizontal' };
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

// Third-person camera presets. Doubles pulls back and widens so a team
// always sees partner positioning and movement.
export function thirdPersonCamera(aspect, preset) {
  const presets = {
    broadcast: { fov: 52, height: 7.5, behind: 14.0 },
    // Stacked full-width bands are very wide; a tighter vertical FOV keeps
    // the court filling the band instead of floating in empty sky.
    singles:   { fov: 46, height: 5.5, behind: 10.5 },
    doubles:   { fov: 60, height: 6.5, behind: 12.5 }, // expansive landscape view
  };
  const p = presets[preset];
  return {
    type: 'third-person', preset, aspect,
    fov: p.fov, position: { x: 0, y: p.height, z: p.behind },
    lookAt: { x: 0, y: 0.5, z: -4 },
  };
}
