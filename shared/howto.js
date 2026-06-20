// How-to-play content, shared by the TV menu page and the phone controller
// so the instructions can never drift apart. Pure data.

export const HOW_TO_PLAY = {
  title: 'How to Play',
  sections: [
    {
      heading: 'Join with your phone',
      icon: '📱',
      lines: [
        'Open the address shown in the server console on your phone (same Wi-Fi).',
        'Enter the 4-digit JOIN CODE from the top-left of the TV and tap JOIN.',
        'Hold your phone in landscape — it becomes your gamepad.',
        'If your phone disconnects, the game pauses; reopen the page and it resumes exactly where it was.',
      ],
    },
    {
      heading: 'Move',
      icon: '🕹️',
      lines: [
        'Hold the phone sideways (landscape). Touch the LEFT half anywhere and drag — a joystick appears under your thumb and you run that way.',
        'On clay you slide — let go and momentum carries you.',
      ],
    },
    {
      heading: 'Hit — swipe, don’t look',
      icon: '🎾',
      lines: [
        'SWIPE on the RIGHT half of the phone to hit — no buttons, so you never look down.',
        'The swipe shape picks the shot: a TAP = a LOB over the net player; swipe UP = a DRIVE (a slower swipe is heavy TOPSPIN, a faster one a FLAT bullet); swipe DOWN = a SLICE / drop shot.',
        'The swipe also aims and powers the ball: its left/right angle places the shot, and a faster swipe hits harder. So a diagonal up-right swipe is a drive placed to the right, a diagonal down-left a slice placed to the left.',
        'Smash and volley happen automatically — smash a high ball, volley at the net.',
        'Swipe just as the ball arrives (the timing window is about half a second).',
      ],
    },
    {
      heading: 'Serve',
      icon: '🚀',
      lines: [
        'When it is your serve, the TV and your phone show a prompt and it buzzes.',
        'TAP to toss the ball up, then SWIPE to strike it — like a real serve.',
        'The strike swipe is pure skill: its ANGLE aims into the box and its SPEED sets the pace. Aim within the lines and don’t over-hit, or it sails wide/long for a fault — there’s no luck to it. First fault gives a second serve; two faults is a double fault.',
      ],
    },
    {
      heading: 'Modes',
      icon: '🏆',
      lines: [
        'Quick Match: vs AI, 1v1, or 2v2 doubles (slots 0 & 2 are BLUE, 1 & 3 are RED).',
        'Tournament: 4 entrants, semifinals to final — the champion lifts the trophy.',
        'Formats: short set (first to 4 games), one set, or best of 3. Real tennis scoring with deuce, advantage, and tiebreaks.',
        'Empty seats are always filled by AI, so any number of phones works.',
      ],
    },
  ],
};

// Compact phone-side card: just the controls.
export const PHONE_CHEAT_SHEET = [
  ['Left half', 'touch & drag to move'],
  ['Right half', 'swipe to hit'],
  ['Tap', 'lob over the net player'],
  ['Swipe ↑', 'drive — topspin or flat'],
  ['Swipe ↓', 'slice / drop shot'],
  ['Swipe angle', 'aims the ball left/right'],
  ['Swipe speed', 'shot power (slow ↑ = topspin, fast ↑ = flat)'],
  ['Serve', 'tap to toss, then swipe to strike'],
  ['Auto', 'smash a high ball, volley at net'],
];
