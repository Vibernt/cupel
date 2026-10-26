const STRICT='strict-v1';
const EXPRESS='express-root-npmrc-opaque-v1';
function normalizeInputPolicy(value=STRICT) {
  if (value!==STRICT && value!==EXPRESS) throw new Error(`unsupported Node input policy: ${value}`);
  return value;
}
module.exports={STRICT,EXPRESS,normalizeInputPolicy};
