// The Houshyar24 edition: one account, Houshyar24's, and nothing to switch.
//
// This branch builds a separate app ("Houshyar24 Code") that asks for a Houshyar24 API
// key on its first screen and runs every turn through Houshyar24's Anthropic-compatible
// endpoint. The generic provider machinery (lib/auth.mjs) does the work; this file only
// names the one provider it is allowed to be, and the other tools it can set up.

const BASE = 'https://houshyar24.ir';

export const EDITION = {
  id: 'houshyar24',
  name: 'Houshyar24 Code',
  brand: 'هوشیار۲۴',
  base: BASE,
  anthropic: BASE + '/api/anthropic',
  openai: BASE + '/api/openai/v1',
  mcp: BASE + '/mcp',
  keysUrl: BASE + '/developer/keys',
  keyPrefix: 'sk-hy24-',
  // The names Houshyar24's own installers use (install-src/_common.sh), so a tool set up
  // here and one set up with `curl …/install/codex.sh | bash` are the same setup.
  providerId: 'houshyar24',
  keyEnv: 'HOUSHYAR24_API_KEY',
};

// The provider record lib/auth.mjs keeps: Houshyar24 answers Bearer only.
export const providerFor = (key) => ({ name: EDITION.brand, baseUrl: EDITION.anthropic, key, keyKind: 'bearer', model: '' });
export const isOurs = (p) => !!p && String(p.baseUrl || '').replace(/\/+$/, '') === EDITION.anthropic;
