// Mock the sole process boundary; Apple Calendar tests cannot invoke osascript.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/sources/calendar/apple.js') && specifier === 'node:child_process') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export function execFileSync(...args) { return globalThis.__calguardFakeAppleCommand(...args); }'), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
