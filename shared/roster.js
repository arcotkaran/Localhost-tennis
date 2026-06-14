// Stylized roster of iconic competitors. Each maps unique mechanical traits
// into the AI/physics systems (multipliers around 1.0 baseline).
// Pure tennis simulation: no gear stats, no power-ups.

export const ROSTER = [
  {
    id: 'federer', name: 'Roger Federer', style: 'All-court precision',
    traits: { topspin: 1.05, serveSpeed: 1.15, power: 1.05, speed: 1.10, consistency: 1.15, slice: 1.25 },
  },
  {
    id: 'djokovic', name: 'Novak Djokovic', style: 'Elastic baseline wall',
    traits: { topspin: 1.10, serveSpeed: 1.05, power: 1.05, speed: 1.15, consistency: 1.25, slice: 1.00 },
  },
  {
    id: 'nadal', name: 'Rafael Nadal', style: 'Heavy topspin grinder',
    traits: { topspin: 1.40, serveSpeed: 0.95, power: 1.10, speed: 1.15, consistency: 1.15, slice: 0.95 },
  },
  {
    id: 'kyrgios', name: 'Nick Kyrgios', style: 'Massive first-strike serve',
    traits: { topspin: 1.00, serveSpeed: 1.45, power: 1.20, speed: 1.00, consistency: 0.85, slice: 1.05 },
  },
  {
    id: 'murray', name: 'Andy Murray', style: 'Counterpunching defense',
    traits: { topspin: 1.00, serveSpeed: 1.05, power: 1.00, speed: 1.20, consistency: 1.20, slice: 1.15 },
  },
];

export function getPlayer(id) {
  const p = ROSTER.find(p => p.id === id);
  if (!p) throw new Error(`unknown roster player "${id}"`);
  return p;
}

// Game modes. Strictly local; strictly pure tennis.
export const MODES = {
  quick_single: { label: 'Quick Match — vs AI', players: 1, layout: 'single' },
  quick_1v1: { label: 'Quick Match — 1v1 Local', players: 2, layout: '1v1' },
  quick_2v2: { label: 'Quick Match — 2v2 Local Doubles', players: 4, layout: '2v2' },
  tournament: { label: 'Classic Tournament', players: '2-8', layout: 'bracket' },
};
