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
        'Three shots from the swipe direction: a tap or sideways swipe = DRIVE (flat/topspin), swipe UP = LOB, swipe DOWN = SLICE drop shot.',
        'The swipe also aims and powers the ball: its left/right angle places the shot, and a faster swipe hits harder. So a diagonal down-right swipe is a slice placed to the right.',
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
        'The strike swipe places and paces it: angle aims into the box, speed adds power. Overhitting can fault — first fault gives a second serve, two faults is a double fault.',
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
  ['Tap or →', 'drive (forehand/backhand)'],
  ['Swipe ↑', 'lob over the net player'],
  ['Swipe ↓', 'slice drop shot'],
  ['Swipe angle', 'aims the ball left/right'],
  ['Swipe speed', 'shot power'],
  ['Serve', 'tap to toss, then swipe to strike'],
  ['Auto', 'smash a high ball, volley at net'],
];
