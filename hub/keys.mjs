import { execFileSync } from 'node:child_process';

export function defaultReadRegistry(exec = execFileSync) {
  try {
    return exec('reg', ['query', 'HKCU\\Environment', '/v', 'ELEVENLABS_API_KEY'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

export function resolveApiKey({ configKey, env, platform, readRegistry = defaultReadRegistry }) {
  if (configKey) return configKey;
  if (env?.ELEVENLABS_API_KEY) return env.ELEVENLABS_API_KEY;
  if (platform !== 'win32') return '';
  let out = '';
  try { out = readRegistry() || ''; } catch { return ''; }
  const m = /ELEVENLABS_API_KEY\s+REG_\w+\s+(\S+)/.exec(out);
  return m ? m[1] : '';
}
