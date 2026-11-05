// Fail closed at both I/O boundaries: these tests must never read real mail or
// run SQLite (including when a fixture has not installed its fake handlers).
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/sources/messages/mac_mail.js')) {
    if (specifier === 'node:child_process') {
      return { url: 'data:text/javascript,' + encodeURIComponent(`
        export function execFileSync(...args) {
          if (typeof globalThis.__calguardFakeMacMailCommand !== 'function') throw new Error('Mac Mail command fake not installed');
          return globalThis.__calguardFakeMacMailCommand(...args);
        }
      `), shortCircuit: true };
    }
    if (specifier === 'node:fs') {
      return { url: 'data:text/javascript,' + encodeURIComponent(`
        export function existsSync(...args) {
          if (typeof globalThis.__calguardFakeMacMailExists !== 'function') throw new Error('Mac Mail filesystem fake not installed');
          return globalThis.__calguardFakeMacMailExists(...args);
        }
      `), shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
