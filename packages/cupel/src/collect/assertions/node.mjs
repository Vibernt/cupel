import assert from 'node:assert';
import strict from 'node:assert/strict';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

// Intercept both ESM and CommonJS imports, including callable default assert/strict.
// Keep the original implementation's return values, thrown errors and Promise identity.
export function installNodeAssertions(record) {
  const wrap = (fn, name) => new Proxy(fn, { apply(target, receiver, args) {
    record(name, args[0], ['ok', 'ifError', 'fail'].includes(name) ? undefined : args[1]);
    return Reflect.apply(target, receiver, args);
  } });
  const patch = (api, strictMode = false) => {
    for (const name of Object.keys(api)) {
      if (['strict', 'AssertionError', 'Assert'].includes(name) || typeof api[name] !== 'function') continue;
      api[name] = wrap(api[name], strictMode ? ({ equal: 'strictEqual', notEqual: 'notStrictEqual', deepEqual: 'deepStrictEqual', notDeepEqual: 'notDeepStrictEqual' }[name] ?? name) : name);
    }
    return wrap(api, 'ok');
  };
  const plain = patch(assert), strong = patch(strict, true);
  if (assert.Assert) {
    const Original = assert.Assert;
    const Wrapped = new Proxy(Original, { construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      const mode = JSON.stringify({ strict: args[0]?.strict ?? true, skipPrototype: args[0]?.skipPrototype ?? false });
      for (const name of Object.getOwnPropertyNames(target.prototype)) {
        if (name !== 'constructor' && typeof instance[name] === 'function') instance[name] = wrap(instance[name], `Assert${mode}.${name}`);
      }
      return instance;
    } });
    plain.Assert = Wrapped; strong.Assert = Wrapped;
  }
  plain.strict = strong; strong.strict = strong;
  syncBuiltinESMExports();
  globalThis[Symbol.for('cupel.assertions.node')] = { plain, strong };
  registerHooks({
    resolve(specifier, context, next) {
      if (['assert', 'node:assert', 'assert/strict', 'node:assert/strict'].includes(specifier)) {
        return { url: `cupel-assert:${specifier.endsWith('/strict') ? 'strong' : 'plain'}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith('cupel-assert:')) return next(url, context);
      const kind = url.slice('cupel-assert:'.length);
      const api = kind === 'strong' ? strong : plain;
      return { format: 'commonjs', shortCircuit: true, source:
        `const api = globalThis[Symbol.for('cupel.assertions.node')].${kind};\n` +
        Object.keys(api).map((name) => `exports.${name} = api.${name};`).join('\n') + '\nmodule.exports = api;' };
    },
  });
}
