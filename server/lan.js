// LAN address discovery. On Windows, Hyper-V/WSL virtual adapters expose
// non-internal IPv4s (typically 172.16–31.x) that phones can never reach,
// and they can enumerate before the real NIC. Rank candidates so the
// printed URL is the one that actually works on the household Wi-Fi.

export function rankLanAddresses(interfaces) {
  const candidates = [];
  for (const [name, ifaces] of Object.entries(interfaces)) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      candidates.push({ name, address: iface.address, score: scoreAddress(name, iface.address) });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

function scoreAddress(name, address) {
  let score = 0;
  // Subnet preference: home routers hand out 192.168.x / 10.x;
  // 172.16–31.x on Windows is usually Hyper-V/WSL NAT.
  if (/^192\.168\./.test(address)) score += 100;
  else if (/^10\./.test(address)) score += 80;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 10;
  // Adapter-name hints when present.
  if (/wi-?fi|wlan|wireless/i.test(name)) score += 15;
  if (/vEthernet|WSL|Hyper-V|VMware|VirtualBox|Docker|Tailscale|ZeroTier/i.test(name)) score -= 100;
  // APIPA self-assigned means the adapter has no real network.
  if (/^169\.254\./.test(address)) score -= 200;
  return score;
}

export function lanAddress(interfaces) {
  return rankLanAddresses(interfaces)[0]?.address ?? 'localhost';
}
