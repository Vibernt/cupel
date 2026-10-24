// Tests public runtime coverage APIs inside an actual overlaid Go test binary.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execute, goEnvironment } from '../../packages/cupel/src/collect/go/process.mjs';
const root = resolve('.scratch/s11/runtime-probe'); mkdirSync(root, { recursive: true });
const out = join(root, 'out'); mkdirSync(out, { recursive: true });
writeFileSync(join(root, 'go.mod'), 'module example.com/probe\n\ngo 1.20\n');
writeFileSync(join(root, 'code.go'), 'package probe\nfunc Work() int { return 1 }\n');
const source = 'package probe\nimport "testing"\nfunc TestProbe(t *testing.T) { if Work()!=1 { t.Fatal("work") } }\n';
writeFileSync(join(root, 'code_test.go'), source);
writeFileSync(join(root, 'rewritten.txt'), source.replace('{ if Work()', '{ cupelProbe(t); if Work()'));
writeFileSync(join(root, 'helper.txt'), `package probe
import ("testing"; "runtime/coverage"; "os"; "bytes")
func cupelProbe(t *testing.T) {
 var b bytes.Buffer
 d:=os.Getenv("PROBE_DIR")
 t.Logf("WriteMetaDir: %v", coverage.WriteMetaDir(d))
 t.Logf("WriteMeta: %v", coverage.WriteMeta(&b))
 t.Logf("WriteCountersDir: %v", coverage.WriteCountersDir(d))
 t.Logf("WriteCounters: %v", coverage.WriteCounters(&b))
 t.Logf("ClearCounters: %v", coverage.ClearCounters())
}
`);
const overlay = join(root, 'overlay.json');
writeFileSync(overlay, JSON.stringify({ Replace: { [join(root, 'code_test.go')]: join(root, 'rewritten.txt'), [join(root, 'cupel_helper_test.go')]: join(root, 'helper.txt') } }));
const env = { ...goEnvironment(root), GOCACHE: resolve('.scratch/s11/cache'), GOTOOLCHAIN: 'local', PROBE_DIR: out, GOCOVERDIR: out };
const version = await execute('go', ['version'], { root, env });
const binary = join(root, 'probe.test');
await execute('go', ['test', '-c', '-overlay', overlay, '-covermode=atomic', '-o', binary], { root, env });
const result = await execute(binary, ['-test.v', '-test.gocoverdir', out], { root, env });
if (readFileSync(join(root, 'code_test.go'), 'utf8') !== source) throw new Error('source changed');
writeFileSync(join(root, 'result.txt'), version.stdout + result.stdout + result.stderr);
console.log(version.stdout + result.stdout + result.stderr);
