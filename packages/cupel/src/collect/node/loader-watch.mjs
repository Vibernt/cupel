// Seeing a CommonJS loader the moment it is set up, not only while it is still in place: a handler a test installs,
// uses and restores before Cupel looks (pirates' revert(), rewire) still changed the text V8 ran. Used by both the
// coverage hook and the mutant hook.
//
//   watchLoaders(Module, onChange)
//
// calls onChange('extensions') whenever an entry of Module._extensions is set, defined or deleted (the object is
// replaced by a Proxy of itself, which Node's CommonJS loader reads like the original). Module.wrap and
// Module.wrapper are Node's own non-configurable accessors and cannot be watched; a script whose length differs from
// its file's gives such a wrapper away instead (collect/node/hook.mjs).

export function watchLoaders(Module, onChange) {
  const changed = (kind) => { try { onChange(kind); } catch { /* never break the test */ } };
  const extensions = Module._extensions;
  if (extensions && typeof extensions === 'object') {
    Module._extensions = new Proxy(extensions, {
      set(target, key, value, receiver) { changed('extensions'); return Reflect.set(target, key, value, receiver); },
      defineProperty(target, key, descriptor) { changed('extensions'); return Reflect.defineProperty(target, key, descriptor); },
      deleteProperty(target, key) { changed('extensions'); return Reflect.deleteProperty(target, key); },
    });
  }
}
