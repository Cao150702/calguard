// Offline-only module replacement. No socket or real parser is constructed.
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/dist/sources/messages/email.js')) {
    const mocks = {
      imap: `export default class Imap { constructor(options) { return globalThis.__calguardFakeImap(options); } }`,
      mailparser: `export function simpleParser(stream, callback) { return globalThis.__calguardFakeParser(stream, callback); }`,
    };
    if (Object.hasOwn(mocks, specifier)) return { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
