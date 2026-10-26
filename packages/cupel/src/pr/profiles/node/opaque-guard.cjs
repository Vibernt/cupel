const {emit}=require('./opaque-guard-trace.cjs');
require('./opaque-guard-fs.cjs');
require('./opaque-guard-modules.cjs');
emit({kind:'opaque-ready'});
process.on('exit',()=>emit({kind:'opaque-exit'}));
