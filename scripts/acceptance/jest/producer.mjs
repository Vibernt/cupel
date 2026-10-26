import assert from 'node:assert/strict';
import { command } from './command.mjs';

/** Pin an explicitly supplied installed artifact before executing an acceptance lane. */
export function pinnedProducer({ directory, node, bin, subject, expectedProducerHash, env }) {
  for (const [name,value] of Object.entries({ directory,node,bin,subject,expectedProducerHash }))
    assert.ok(typeof value === 'string' && value.length > 0, `${name} is required`);
  assert.match(expectedProducerHash, /^sha256:[a-f0-9]{64}$/);
  const result = command(directory, 'producer', node, [bin,'pr-producer','--json'], { cwd:subject,env });
  assert.equal(result.exit, 0, result.stderrText);
  const producer = JSON.parse(result.stdoutText);
  assert.equal(producer.producerHash, expectedProducerHash, 'Installed artifact producer pin mismatch');
  return { producer, command:result };
}
