import { execFileSync } from 'node:child_process';

// A saved Windows user environment variable, for when `setx` ran after this process started.
export function defaultReadRegistry(exec = execFileSync, name = 'ELEVENLABS_API_KEY') {
  try {
    return exec('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

// An API key: the plugin setting, then the provider's own environment variable, then (Windows)
// the saved user environment.
export function resolveKey({ configKey, envName, env, platform, readRegistry = name => defaultReadRegistry(execFileSync, name) }) {
  if (configKey) return configKey;
  if (env?.[envName]) return env[envName];
  if (platform !== 'win32') return '';
  let out = '';
  try { out = readRegistry(envName) || ''; } catch { return ''; }
  const m = new RegExp(`${envName}\\s+REG_\\w+\\s+(\\S+)`).exec(out);
  return m ? m[1] : '';
}

// ElevenLabs, as before (kept for callers and tests that predate the other providers).
export function resolveApiKey({ configKey, env, platform, readRegistry = () => defaultReadRegistry() }) {
  return resolveKey({ configKey, envName: 'ELEVENLABS_API_KEY', env, platform, readRegistry: () => readRegistry() });
}
