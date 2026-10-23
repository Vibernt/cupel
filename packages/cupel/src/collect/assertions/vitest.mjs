// Wrap Vitest's matcher object (Chai Assertion prototype), preserving native implementations.
export function installVitestAssertions(vitest, record) {
  const { chai } = vitest;
  const wrapped = new Set();
  const install = () => {
    for (const name of Object.getOwnPropertyNames(chai.Assertion.prototype)) {
      if (!/^to[A-Z]/.test(name) || wrapped.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(chai.Assertion.prototype, name);
      if (typeof descriptor.value !== 'function') continue;
      chai.util.overwriteMethod(chai.Assertion.prototype, name, (original) => function (...args) {
        record(name, chai.util.flag(this, 'object'), args.length <= 1 ? args[0] : args,
          { framework: 'vitest', negated: !!chai.util.flag(this, 'negate'), promise: chai.util.flag(this, 'promise') ?? '' });
        return original.apply(this, args);
      });
      wrapped.add(name);
    }
  };
  install();
  const extend = vitest.expect.extend;
  vitest.expect.extend = function (matchers) {
    const result = extend.call(this, matchers);
    for (const name of Object.keys(matchers)) wrapped.delete(name);
    install();
    return result;
  };
}
