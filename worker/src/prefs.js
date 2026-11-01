// A member's private site settings. Anything missing or invalid keeps what's saved.
import { safeLink } from './security.js';

const CHOICES = {
  theme: ['wrk', 'money', 'ocean', 'ember', 'violet', 'rose', 'mono'],
  background: ['network', 'calm', 'off'],
  motion: ['full', 'reduced'],
  clock: ['12h', '24h'],
  landing: ['home', 'directory', 'tools', 'startpage', 'profile'],
};
const SWITCHES = ['clockSeconds', 'suggestions'];

function cleanCommands(list) {
  return list.flatMap(command => {
    const key = `?${String(command?.key ?? '').trim().toLowerCase().replace(/^\?/, '')}`;
    const url = safeLink(command?.url, ['http:', 'https:']);
    return /^\?[a-z0-9]{1,10}$/.test(key) && url ? [{ key, url: url.slice(0, 300) }] : [];
  }).slice(0, 12);
}

export function cleanPrefs(body, saved) {
  const prefs = { ...saved };
  for (const [key, allowed] of Object.entries(CHOICES))
    if (allowed.includes(body[key])) prefs[key] = body[key];
  for (const key of SWITCHES)
    if (typeof body[key] === 'boolean') prefs[key] = body[key];
  if (body.accent === null || (typeof body.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.accent))) prefs.accent = body.accent;
  if (Array.isArray(body.commands)) prefs.commands = cleanCommands(body.commands);
  return prefs;
}
