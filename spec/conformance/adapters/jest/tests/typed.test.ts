import { boost } from '../src/typed.ts';
import { readFileSync } from 'node:fs';
test('transformed source map', () => { expect(boost(2)).toBe(5); });
test('source text pin', () => { expect(readFileSync(__dirname + '/../src/typed.ts', 'utf8')).toContain('x + 3'); });
