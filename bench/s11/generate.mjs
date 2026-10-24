// Reproducible, offline service-shaped workload. No generated files leave .scratch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
export function generate(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'go.mod'), 'module example.com/s11\n\ngo 1.20\n');
  for (let p = 0; p < 30; p++) {
    const name = `p${String(p).padStart(2, '0')}`;
    const dir = join(root, name); mkdirSync(dir, { recursive: true });
    const dep = p ? `p${String(p - 1).padStart(2, '0')}` : null;
    const init = p % 7 === 0 ? 'func init() { for i := 0; i < 200000; i++ { Boot = (Boot + i) % 997 } }\n' : '';
    const functions = Array.from({ length: 40 }, (_, n) => `func Work${n}(v int) int {\n if v < 0 { return -v }\n if v == 0 { return Boot }\n return v + ${n}\n}\n`).join('');
    writeFileSync(join(dir, 'service.go'), `package ${name}\n${dep ? `import "example.com/s11/${dep}"\n` : ''}var Boot = 7\n${init}${functions}${dep ? `func Chain(v int) int { return ${dep}.Work0(v) }\n` : ''}`);
    for (const external of [false, true]) {
      const count = external ? 4 : (p < 10 ? 30 : 29);
      const prefix = external ? `${name}.` : '';
      const tests = Array.from({ length: count }, (_, n) => `func Test${external ? 'External' : 'Work'}${n}(t *testing.T) { ${!external && n === 0 && p % 10 === 0 ? 't.Parallel(); ' : ''}if got := ${prefix}Work${n}(${n + 1}); got != ${2 * n + 1} { t.Fatal(got) }; ${n === 1 ? `t.Run("child", func(t *testing.T) { _ = ${prefix}Work3(-1) }); ` : ''}${dep && n === 2 ? `_ = ${prefix}Chain(1); ` : ''}}\n`).join('');
      writeFileSync(join(dir, external ? 'external_test.go' : 'service_test.go'), `package ${name}${external ? '_test' : ''}\nimport ("testing"${external ? `; "example.com/s11/${name}"` : ''}${p === 5 && !external ? '; "os"' : ''})\n${p === 5 && !external ? 'func TestMain(m *testing.M) { _ = Work39(0); code := m.Run(); _ = Work38(0); os.Exit(code) }\n' : ''}${tests}`);
    }
  }
  return root;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(generate(resolve(process.argv[2] ?? '.scratch/s11/module')));
