import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consoleHarness } from './support/console.mjs';
import { compilePipeline } from '../src/domain/compiler.mjs';
import { migrate, detectFormat as serverDetect, migratorIds } from '../src/migrate/index.mjs';
import {
    formatOptions, formatLabel, detectFormat, extractMappables, groupDiagnostics, triggerSummary, intervalLabel,
    expandMatrix, expandedJobCount, definitionDag, pathKeys, getAt, setAt, cleanDefinition, renameJob, removeJob,
    blankJob, problemsFromError, sourceLines, isSha, humanPath, jsonMessage
} from '../public/app/pages/pipelines/model.mjs';
import { EXAMPLES } from '../public/app/pages/pipelines/examples.mjs';
import { planRows, newStep, createBody, NEW_STEPS } from '../public/app/pages/pipelines/record-model.mjs';
import { sortedFindings, severityOptions, findingKey } from '../public/app/pages/pipelines/audit-model.mjs';
import {
    percentile, runStats, lastRunState, healthSummary, filterPipelines, withTrigger, withSize, commonSize, withTimeout, timeoutMinutes,
    withConcurrency, withNumber, advancedChanged, secretRows, withEntry, withoutEntry, withName, ENV_NAME
} from '../public/app/pages/pipelines/settings-model.mjs';
import { TEMPLATES, templateDefinition, createSummary } from '../public/app/pages/pipelines/templates.mjs';

/*
 * The Pipelines context of the console: its models (import formats, problems, the plan, settings, templates, audit
 * findings, run statistics) and its pages under the DOM double (the list, the pipeline record and its tabs, New
 * pipeline, the workflow audit, backtests, and the pull request and commit views).
 *
 * Pages are read the way a person or a screen reader finds things: by role, accessible name, ARIA state, link target
 * and the pages' data hooks, never by a styling class. Assertions check what the page derives from its inputs (counts,
 * rates, names, states, requests), not fixed copy or layout; the design rules (one primary button, titles outside
 * their card, no en dashes in copy) belong to the style checks, not here. (Merged in spike S4 from ui-pipelines,
 * ui-pipelines-v2 and ui-pipelines-volt.)
 */
const HOUR = 3600000, NOW = Date.now();
const manifest = JSON.parse(readFileSync(new URL('../public/generated/operations.json', import.meta.url), 'utf8'));
const run = (id, status, { pipelineId = 'pl1', ago = 1, took = 60000, branch = 'main' } = {}) => ({
    id: `${id}${'0'.repeat(Math.max(0, 12 - id.length))}`, pipelineId, projectId: 'p1', status, branch, commit: 'a'.repeat(40), reason: 'github:push',
    createdAt: NOW - ago * HOUR, startedAt: NOW - ago * HOUR, finishedAt: ['succeeded', 'failed'].includes(status) ? NOW - ago * HOUR + took : undefined
});
/** Two jobs; `test` maps a secret and a variable. */
const definition = (over = {}) => ({
    name: 'CI', projectId: 'p1', triggers: { push: ['main'], pullRequest: true },
    jobs: [{ id: 'install', commands: [{ name: 'Install', run: 'npm ci' }] }, { id: 'test', needs: ['install'], env: { NODE_ENV: 'test' }, secrets: { NPM_TOKEN: 'sec1' }, commands: [{ name: 'Test', run: 'npm test' }] }],
    ...over
});
/** Two jobs; `test` has a two-leg matrix and two steps, the first of two lines. */
const matrixDefinition = (over = {}) => definition({
    jobs: [
        { id: 'install', commands: [{ name: 'Install', run: 'npm ci' }] },
        { id: 'test', needs: ['install'], matrix: { node: ['20', '22'] }, commands: [{ name: 'Unit', run: 'npm test\nnpm run e2e' }, { name: 'Lint', run: 'npm run lint' }] }
    ],
    ...over
});
const pipeline = (over = {}) => ({ id: 'pl1', projectId: 'p1', status: 'active', version: 3, definition: definition(), plan: { jobs: [], maxParallel: 4, timeoutSeconds: 7200 }, planDigest: 'd'.repeat(64), createdAt: NOW - 100 * HOUR, updatedAt: NOW - 2 * HOUR, ...over });
/** The record of a pipeline with the matrix definition and its real compiled plan. */
const matrixPipeline = (over = {}) => {
    const def = over.definition || matrixDefinition();
    return pipeline({ definition: def, plan: compilePipeline(def), ...over });
};
const project = { id: 'p1', name: 'storefront', repository: 'lumen/storefront', defaultBranch: 'main' };
const quota = (over = {}) => ({
    period: { key: '2026-10', start: Date.UTC(2026, 9, 1), resetsAt: Date.UTC(2026, 10, 1) }, warnAt: 0.8, softMargin: 0.1, override: null, waitingForWorkspaceLimit: 0,
    items: [
        { dimension: 'buildMinutes', label: 'Build minutes', description: 'Container time.', unit: 'minutes', kind: 'metered', limit: 3000, used: 420, state: 'ok' },
        { dimension: 'concurrentJobs', label: 'Concurrent jobs', description: 'Jobs at once.', unit: 'jobs', kind: 'concurrency', limit: 3, used: 1, state: 'ok' },
        { dimension: 'storageGb', label: 'Evidence and log storage', unit: 'GB', kind: 'level', limit: 50, used: 2.5, state: 'ok' }
    ],
    ...over
});
/** Every concurrent-job slot in use, with 2 jobs waiting. */
const fullQuota = () => {
    const full = quota({ waitingForWorkspaceLimit: 2 });
    full.items[1] = { ...full.items[1], used: 3, state: 'exceeded' };
    return full;
};
const page = items => () => ({ items, nextCursor: null });
const count = (load, operation) => load.requests.filter(r => r.operation === operation).length;
const ops = load => load.operations.filter(Boolean);
const text = el => el?.textContent.replace(/\s+/g, ' ').trim() ?? null;
/** The JSON body of a "Show as API request" curl command (sent as a heredoc). */
const requestBody = curl => JSON.parse(curl.split("<<'JSON'\n")[1].split('\nJSON')[0]);
const wait = async (until, turns = 60) => {
    for (let i = 0; i < turns && !until(); i++)
        await new Promise(resolve => setTimeout(resolve, 5));
};
/** Where the current tab of a pipeline record links to, after /pipelines/pl1 ('' is Overview). */
const currentTab = load => load.root.querySelector('nav a[aria-current="page"]').getAttribute('href').replace(/^.*\/pipelines\/pl1/, '');
/** Key facts as { name: value }. */
const facts = root => Object.fromEntries([...root.querySelectorAll('dl[aria-label] > div')].map(d => [text(d.querySelector('dt')), text(d.querySelector('dd'))]));
/** Buttons and links by their accessible text. */
const controls = (root, name) => [...root.querySelectorAll('a, button')].filter(c => text(c) === name || c.getAttribute('aria-label') === name);
const switchNamed = (root, name) => root.querySelector(`[role="switch"][aria-label="${name}"]`);
/**
 * The workspace event stream (events.stream), held open until the test sends a server-sent event with `send(event)`.
 * Call after consoleHarness(): it wraps the harness's fake fetch, which still records the request.
 */
function eventStream() {
    const harnessFetch = globalThis.fetch;
    let controller = null;
    globalThis.fetch = async (input, init = {}) => {
        if (!new URL(String(input), 'https://ci.example').pathname.endsWith('/events/stream') || controller)
            return harnessFetch(input, init);
        await harnessFetch(input, init);
        const body = new ReadableStream({ start: c => { controller = c; } });
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    return {
        connected: () => Boolean(controller),
        send: event => controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)),
        close: () => { try { controller?.close(); } catch { /* closed */ } }
    };
}
/** Runs `fn` with page timers of `ms` milliseconds firing at once (a compressed clock for debounces). */
async function withoutPause(ms, fn) {
    const harnessTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...rest) => harnessTimeout(callback, delay === ms ? 0 : delay, ...rest);
    try {
        return await fn();
    }
    finally {
        globalThis.setTimeout = harnessTimeout;
    }
}

/** Runs `fn(harness)` with a console harness that is closed afterwards, pass or fail. */
async function inConsole(options, fn) {
    const harness = await consoleHarness(options);
    try {
        return await fn(harness);
    }
    finally {
        await harness.close();
    }
}

/* ---------- models ---------- */

test('pipelines models: every import format has a label, and the client detects formats as the server does', () => {
    const formats = formatOptions(manifest['pipeline.import'].body.properties.format.enum);
    assert.deepEqual(formats.map(f => f.id).sort(), migratorIds().sort());
    for (const f of formats)
        assert.ok(f.label && !f.label.includes('-'), f.id);
    assert.equal(formatLabel('auto'), 'Detect automatically');
    assert.equal(formatLabel('some-new-ci'), 'Some New Ci');
    const paths = ['.github/workflows/ci.yml', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.travis.yml', '.drone.yml', '.woodpecker/build.yml'];
    for (const path of paths)
        assert.equal(detectFormat({ path }), serverDetect({ path }), path);
    for (const [id, example] of Object.entries(EXAMPLES)) {
        assert.equal(detectFormat({ text: example.text }), id, `${id} by content`);
        assert.equal(serverDetect({ text: example.text }), id, `${id} by content (server)`);
    }
    for (const file of ['gitlab/simple.yml', 'circleci/simple.yml', 'azure-pipelines/simple.yml', 'bitbucket/simple.yml', 'travis/simple.yml', 'drone/drone-simple.yml']) {
        const sample = readFileSync(new URL(`fixtures/migrate/${file}`, import.meta.url), 'utf8');
        assert.equal(detectFormat({ text: sample }), serverDetect({ text: sample }), file);
    }
    assert.equal(detectFormat({ text: '' }), null);
});

test('pipelines models: samples convert, and mapping names come from converter diagnostics', async () => {
    const gha = await migrate({ format: 'auto', text: EXAMPLES['github-actions'].text, options: { projectId: 'p1' } });
    const found = extractMappables(gha.diagnostics);
    assert.deepEqual(found.secrets.map(s => s.name), ['CODECOV_TOKEN']);
    // GitHub Actions services convert to service containers: nothing to map (other formats still need serviceMappings).
    assert.deepEqual(found.services.map(s => s.name), []);
    assert.ok(!gha.diagnostics.some(d => d.code === 'SERVICE_CONTAINER'));
    assert.ok(found.secrets[0].lines[0] > 0);
    const mapped = await migrate({ format: 'auto', text: EXAMPLES['github-actions'].text, options: { projectId: 'p1', secretMappings: { CODECOV_TOKEN: 'sec1' }, serviceMappings: { postgres: { command: 'pg_ctl start', readyUrl: 'http://127.0.0.1:5432/' } } } });
    assert.equal(mapped.summary.errors, 0);
    const gitlab = await migrate({ format: 'auto', text: EXAMPLES['gitlab-ci'].text, options: { projectId: 'p1' } });
    assert.deepEqual(extractMappables(gitlab.diagnostics).secrets.map(s => s.name), ['REGISTRY_TOKEN', 'REGISTRY_URL']);
    const circle = await migrate({ format: 'auto', text: EXAMPLES.circleci.text, options: { projectId: 'p1' } });
    assert.deepEqual(extractMappables(circle.diagnostics).services.map(s => s.name), ['redis']);
    const jenkins = await migrate({ format: 'auto', text: EXAMPLES.jenkins.text, options: { projectId: 'p1' } });
    assert.equal(jenkins.summary.ready, true);
    // Placeholders in suggestions are never offered as names.
    assert.deepEqual(extractMappables([{ severity: 'error', code: 'X', line: 1, message: 'm', suggestion: 'pass secretMappings: { "<name>": "<secretId>" }' }]).secrets, []);
});

test('pipelines models: problems are located (diagnostics by severity and line, validation errors, JSON syntax errors)', () => {
    const groups = groupDiagnostics([{ severity: 'info', line: 9 }, { severity: 'error', line: 4 }, { severity: 'error', line: null }, { severity: 'error', line: 2 }, { severity: 'warning', line: 1 }]);
    assert.deepEqual(groups.error.map(d => d.line), [2, 4, null]);
    assert.equal(groups.warning.length, 1);
    assert.equal(groups.info.length, 1);
    const def = { jobs: [{ id: 'a', commands: [] }, { id: 'b', needs: ['zzz'], commands: [] }, { id: 'a', commands: [] }] };
    const schema = problemsFromError({ code: 'VALIDATION', message: 'Request validation failed.', details: [{ path: '$.jobs[1].commands', message: 'Too few items.' }] }, def);
    assert.deepEqual(schema, [{ path: 'jobs[1].commands', message: 'Too few items.', jobIndex: 1 }]);
    const unknown = problemsFromError({ code: 'UNKNOWN_DEPENDENCY', message: 'Unknown job: zzz' }, def);
    assert.equal(unknown[0].path, 'jobs[1].needs');
    assert.equal(unknown[0].jobIndex, 1);
    const duplicate = problemsFromError({ code: 'DUPLICATE_JOB', message: 'Job IDs must be unique.' }, def);
    assert.equal(duplicate[0].path, 'jobs[2].id');
    const other = problemsFromError({ code: 'MATRIX_LIMIT', message: 'Expanded pipelines may contain at most 64 jobs.' }, def);
    assert.equal(other[0].jobIndex, null);
    const json = '{\n  "a": 1,,\n}';
    let error;
    try {
        JSON.parse(json);
    }
    catch (e) {
        error = e;
    }
    assert.match(jsonMessage(error, json), /at line 2, column \d+\.$/);
    assert.equal(jsonMessage({ message: 'Unexpected token } in JSON at position 3' }, 'ab\ncd'), 'Unexpected token } at line 2, column 1.');
    assert.equal(jsonMessage({ message: 'Unexpected end of JSON input' }, ''), 'Unexpected end of JSON input');
});

test('pipelines models: trigger summaries, schedule labels, source lines and SHA checks', () => {
    assert.deepEqual(triggerSummary({}), []);
    const t = triggerSummary({ push: ['main', 'release', 'next'], pullRequest: true, intervalSeconds: 86400 });
    assert.deepEqual(t.map(x => x.kind), ['push', 'pr', 'schedule']);
    assert.equal(t[0].label, 'Push to main, release +1');
    for (const [seconds, label] of [[86400, 'Every day'], [7200, 'Every 2 hours'], [301, 'Every 301 seconds']])
        assert.equal(intervalLabel(seconds), label, String(seconds));
    assert.equal(t[2].label, intervalLabel(86400));
    assert.deepEqual(sourceLines('a\r\nb\n'), [{ number: 1, text: 'a' }, { number: 2, text: 'b' }]);
    for (const [value, sha] of [['a'.repeat(40), true], ['main', false], ['A'.repeat(40), false]])
        assert.equal(isSha(value), sha, value);
});

test('pipelines models: the matrix preview and the plan rows follow the compiler expansion', () => {
    const job = { id: 'unit', commands: [{ name: 'Test', run: 'npm test' }], matrix: { node: ['20', '22'], os: ['linux', 'arm'] } };
    const legs = expandMatrix(job);
    const plan = compilePipeline({ name: 'x', projectId: 'p1', jobs: [job] });
    assert.equal(legs.length, plan.jobs.length);
    legs.forEach((leg, i) => assert.deepEqual(leg.values, plan.jobs[i].matrix));
    assert.equal(expandMatrix({ id: 'a' }).length, 1);
    assert.equal(expandedJobCount({ jobs: [job, { id: 'b' }] }), 5);
    const dag = definitionDag({ jobs: [job, { id: 'b', needs: ['unit'], commands: [] }] }, { problems: new Map([[1, 2]]) });
    assert.equal(dag[0].sub, '4 legs, 1 step');
    assert.equal(dag[1].status, 'failed');
    assert.equal(dag[1].sub, '2 problems');
    // Mid-edit states stay drawable: duplicate ids get unique node ids; cycles and unknown needs are
    // kept for <vi-dag>, which draws them as invalid edges (see tests/graph.test.mjs).
    const messy = definitionDag({ jobs: [{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }, { id: 'a', needs: ['zzz'] }] });
    assert.deepEqual(messy.map(n => n.id), ['a', 'b', 'a (2)']);
    assert.deepEqual(messy.map(n => n.needs), [['b'], ['a'], ['zzz']]);
    // The record's Plan tab: one row per job after matrix expansion.
    const rows = planRows(compilePipeline(matrixDefinition()));
    assert.deepEqual(rows.map(r => r.key), ['install__0', 'test__0', 'test__1']);
    assert.deepEqual(rows[1].matrix, ['node=20']);
    assert.deepEqual(rows[1].needs, ['install__0']);
    assert.equal(rows[1].steps, 2);
    assert.equal(rows[0].timeoutSeconds, 1800);
    assert.deepEqual(planRows({}), []);
});

test('pipelines models: editing a definition (paths, clean-up, renaming and removing jobs) keeps it consistent', () => {
    assert.deepEqual(pathKeys('$.jobs[0].commands[12].run'), ['jobs', 0, 'commands', 12, 'run']);
    const def = { jobs: [{ id: 'a', commands: [{ name: 'x' }] }] };
    assert.equal(getAt(def, 'jobs[0].commands[0].name'), 'x');
    setAt(def, 'jobs[0].env.NODE_ENV', 'test');
    assert.deepEqual(def.jobs[0].env, { NODE_ENV: 'test' });
    setAt(def, 'triggers.push', ['main']);
    assert.deepEqual(def.triggers, { push: ['main'] });
    setAt(def, 'triggers.push', undefined);
    assert.deepEqual(def.triggers, {});
    assert.equal(humanPath('$.jobs[0].commands[0].name', def), 'job a › step 1 › name');
    assert.equal(humanPath('triggers.intervalSeconds', def), 'triggers › schedule');
    assert.equal(humanPath('', def), 'pipeline');
    setAt(def, 'jobs[0].commands[0]', undefined);
    assert.deepEqual(def.jobs[0].commands, []);
    const clean = cleanDefinition({
        name: 'CI', projectId: '', triggers: { push: [' main ', ''], pullRequest: false },
        jobs: [{ id: 'a', needs: [], env: { '': '' }, matrix: { '': [] }, commands: [{ name: 'Run', run: 'x', workingDirectory: '' }], reports: [{ path: '', format: '' }], cache: { key: '', paths: [] } }]
    });
    assert.deepEqual(clean, { name: 'CI', projectId: '', triggers: { push: ['main'] }, jobs: [{ id: 'a', commands: [{ name: 'Run', run: 'x' }] }] });
    assert.deepEqual(cleanDefinition({ name: 'CI', projectId: 'p', jobs: [], triggers: {} }), { name: 'CI', projectId: 'p', jobs: [] });
    const jobs = { jobs: [{ id: 'build', commands: [] }, { id: 'test', needs: ['build'], commands: [] }, { id: 'ship', needs: ['build', 'test'], commands: [] }] };
    renameJob(jobs, 0, 'compile');
    assert.deepEqual(jobs.jobs[2].needs, ['compile', 'test']);
    renameJob(jobs, 2, 'compile');
    renameJob(jobs, 2, 'ship');
    assert.deepEqual(jobs.jobs[2].needs, ['compile', 'test'], 'resolving a duplicate id leaves needs alone');
    removeJob(jobs, 1);
    assert.deepEqual(jobs.jobs.map(j => j.id), ['compile', 'ship']);
    assert.deepEqual(jobs.jobs[1].needs, ['compile']);
    const next = blankJob(jobs.jobs);
    assert.equal(next.id, 'job-3');
    assert.deepEqual(next.needs, ['ship']);
});

test('pipelines models: every template compiles as it is; New pipeline steps come from the query and the create body copies the template', () => {
    assert.ok(TEMPLATES.length >= 5);
    assert.equal(new Set(TEMPLATES.map(t => t.id)).size, TEMPLATES.length);
    for (const t of TEMPLATES) {
        const def = templateDefinition(t.id, 'p1');
        assert.ok(compilePipeline(def).jobs.length >= 1, t.id);
        assert.deepEqual(def.triggers, { push: ['main'], pullRequest: true }, `${t.id}: pushes to main and pull requests`);
    }
    const copy = templateDefinition('node', 'p1');
    copy.jobs.pop();
    assert.equal(templateDefinition('node').jobs.length, 3, 'editing a copy never changes the template');
    assert.equal(templateDefinition('nope'), null);
    // What creating it does, from the definition: the job count and the triggers that start it.
    assert.match(createSummary(templateDefinition('node')), /\b3 jobs\b.*\bpush to main or a pull request\b/);
    assert.match(createSummary({ jobs: [{}] }), /\bno triggers\b.*\bone job\b/);
    const ids = ['node', 'blank'];
    assert.equal(newStep({}, ids), 'start');
    assert.equal(newStep({ template: 'node' }, ids), 'start', 'a template alone is the editor, not the flow');
    assert.equal(newStep({ start: 'template' }, ids), 'template');
    assert.equal(newStep({ start: 'template', template: 'node', step: 'review' }, ids), 'review');
    assert.equal(newStep({ start: 'template', template: 'nope', step: 'review' }, ids), 'template', 'an unknown template goes back to the gallery');
    assert.deepEqual(NEW_STEPS.map(s => s.id), ['start', 'template', 'review']);
    const def = templateDefinition('node');
    const body = createBody(def, { projectId: 'p9', name: '  Web CI  ' });
    assert.equal(body.projectId, 'p9');
    assert.equal(body.name, 'Web CI');
    assert.equal(createBody(def, { projectId: 'p9', name: ' ' }).name, def.name, 'an empty name keeps the template name');
    assert.notEqual(body.jobs, def.jobs, 'the template is copied, never changed');
    assert.ok(compilePipeline(body).jobs.length >= 1, 'it compiles as it is');
});

test('pipelines models: run statistics, health and list filters come only from the runs given', () => {
    assert.equal(percentile([], 0.9), null);
    assert.equal(percentile([5, 1, 3, 2, 4, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([30], 0.5), 30);
    const stats = runStats([run('a', 'succeeded', { took: 1000 }), run('b', 'failed', { took: 3000 }), run('c', 'running'), run('d', 'cancelled'), run('e', 'succeeded', { took: 2000 })]);
    assert.deepEqual([stats.runs, stats.finished, stats.succeeded, stats.failed], [5, 3, 2, 1], 'cancelled and running runs are not finished');
    assert.equal(stats.successRate, 2 / 3);
    assert.equal(stats.p50Ms, 2000);
    assert.equal(stats.p90Ms, 3000);
    assert.deepEqual(runStats([]).successRate, null);
    assert.equal(lastRunState(undefined), 'never');
    assert.equal(lastRunState(run('q', 'queued')), 'running');
    const health = healthSummary([{ id: 'x' }, { id: 'y' }, { id: 'z' }], new Map([['x', [run('a', 'failed', { pipelineId: 'x' })]], ['y', [run('b', 'running', { pipelineId: 'y' }), run('c', 'succeeded', { pipelineId: 'y' })]]]));
    assert.deepEqual([health.failing, health.running, health.never, health.finished], [1, 1, 1, 2]);
    const projects = new Map([['p1', { name: 'storefront' }], ['p2', { name: 'payments' }]]);
    const list = [pipeline({ id: 'a' }), pipeline({ id: 'b', projectId: 'p2', definition: definition({ name: 'Nightly' }) })];
    const runs = new Map([['a', [run('r1', 'failed', { pipelineId: 'a' })]]]);
    for (const [filters, context, ids, why] of [
        [{ q: 'payments' }, { projects }, ['b'], 'the project name'],
        [{ q: 'install' }, { projects }, ['a', 'b'], 'job ids match'],
        [{ projectId: 'p2' }, { projects }, ['b'], 'the project id'],
        [{ last: 'failed' }, { projects, runs }, ['a'], 'the newest run failed'],
        [{ last: 'never' }, { projects, runs }, ['b'], 'never run'],
        [{ last: 'failed' }, { projects, runs: null }, ['a', 'b'], 'while runs load nothing is hidden by them']
    ])
        assert.deepEqual(filterPipelines(list, filters, context).map(p => p.id), ids, why);
});

test('pipelines models: each setting changes only its own part of the definition, and never the input', () => {
    const def = definition({ timeoutSeconds: 1800 });
    const before = structuredClone(def);
    assert.deepEqual(withTrigger(def, 'pullRequest', false).triggers, { push: ['main'] });
    assert.deepEqual(withTrigger(def, 'mergeGroup', true).triggers, { push: ['main'], pullRequest: true, mergeGroup: true });
    assert.deepEqual(withTrigger(def, 'push', [' main', 'release/*', 'main', '']).triggers.push, ['main', 'release/*']);
    assert.equal(withTrigger(withTrigger(def, 'push', []), 'pullRequest', false).triggers, undefined, 'no triggers left removes the object');
    assert.equal(withName(def, '  Build  ').name, 'Build');
    assert.equal(timeoutMinutes(def), 30);
    assert.equal(timeoutMinutes({}), 120);
    assert.equal(withTimeout(def, 45).timeoutSeconds, 2700);
    assert.equal(withNumber(def, 'maxParallel', 6).maxParallel, 6);
    assert.equal('maxParallel' in withNumber({ ...def, maxParallel: 6 }, 'maxParallel', ''), false);
    assert.deepEqual(withConcurrency(def, { group: 'ci-main', cancelInProgress: true }).concurrency, { group: 'ci-main', cancelInProgress: true });
    assert.equal(withConcurrency({ ...def, concurrency: { group: 'x' } }, { group: ' ' }).concurrency, undefined);
    assert.equal(advancedChanged(def), false);
    assert.equal(advancedChanged({ ...def, maxParallel: 2 }), true);
    assert.equal(advancedChanged({ ...def, concurrency: { group: 'g' } }), true);
    for (const next of [withTrigger(def, 'pullRequest', false), withTimeout(def, 45), withConcurrency(def, { group: 'g' })])
        assert.deepEqual(next.jobs, def.jobs, 'jobs are kept as they are');
    assert.deepEqual(def, before, 'the input is never changed');
    // Runner size: default-image jobs only; mixed sizes are reported.
    const sized = definition();
    sized.jobs.push({ id: 'e2e', image: 'browser', commands: [{ name: 'e2e', run: 'x' }] }, { id: 'mac', runsOn: { labels: ['macos'] }, commands: [{ name: 'm', run: 'x' }] });
    assert.equal(commonSize(sized), 'default');
    const large = withSize(sized, 'large');
    assert.deepEqual(large.jobs.map(j => j.size), ['large', 'large', undefined, undefined]);
    assert.equal(commonSize(large), 'large');
    large.jobs[0].size = 'small';
    assert.equal(commonSize(large), 'mixed');
    assert.deepEqual(withSize(large, 'default').jobs.map(j => j.size), [undefined, undefined, undefined, undefined]);
    assert.equal(commonSize({ jobs: [{ id: 'b', image: 'docker' }] }), null);
    // Secrets and variables become rows and change only the chosen jobs.
    const mapped = definition();
    mapped.jobs[0].secrets = { NPM_TOKEN: 'sec1' };
    const rows = secretRows(mapped);
    assert.deepEqual(rows.map(r => [r.kind, r.name, r.jobs]), [['secret', 'NPM_TOKEN', ['install', 'test']], ['variable', 'NODE_ENV', ['test']]]);
    const added = withEntry(mapped, { kind: 'variable', name: 'CI_REGION', value: 'eu', jobs: ['install'] });
    assert.deepEqual(added.jobs[0].env, { CI_REGION: 'eu' });
    assert.equal(added.jobs[1].env.CI_REGION, undefined);
    assert.deepEqual(withEntry(mapped, { kind: 'secret', name: 'SENTRY', secretId: 'sec9', jobs: ['test'] }).jobs[1].secrets, { NPM_TOKEN: 'sec1', SENTRY: 'sec9' });
    const removed = withoutEntry(mapped, rows[0]);
    assert.equal(removed.jobs[0].secrets, undefined, 'an empty map is dropped');
    assert.equal(removed.jobs[1].secrets, undefined);
    assert.deepEqual(removed.jobs[1].env, { NODE_ENV: 'test' });
    for (const [name, valid] of [['NPM_TOKEN', true], ['1TOKEN', false], ['A-B', false]])
        assert.equal(ENV_NAME.test(name), valid, name);
});

/* ---------- the list ---------- */

const listAnswers = (over = {}) => ({
    'pipeline.list': page([pipeline(), pipeline({ id: 'pl2', definition: definition({ name: 'Nightly', triggers: { intervalSeconds: 86400 } }) })]),
    'project.list': page([project]),
    'run.recent': () => ({ items: [{ pipelineId: 'pl1', runs: [run('r1', 'failed'), run('r2', 'succeeded', { ago: 3, took: 120000 })] }, { pipelineId: 'pl2', runs: [] }] }),
    'quota.status': () => quota(),
    'tests.selection.offer': () => ({ projectId: 'p1', state: 'on', estimate: null, preset: {} }),
    ...over
});
const addRunners = root => [...root.querySelectorAll('a')].filter(a => /Add runners/.test(a.textContent) || a.getAttribute('href')?.endsWith('/settings/runners'));

test('/pipelines: the list, its usage column and health in a fixed number of requests', async () => {
    await inConsole({ tenantId: 'wv1' }, async harness => {
        const load = await harness.open('/pipelines', listAnswers());
        const all = load.text();
        assert.equal(count(load, 'pipeline.list'), 1);
        assert.equal(count(load, 'run.recent'), 1, 'the newest runs of every pipeline in one request');
        assert.equal(count(load, 'quota.status'), 1);
        assert.equal(count(load, 'run.list'), 0, 'never a run list per pipeline');
        assert.equal(count(load, 'tests.selection.offer'), 1, 'one project: the test selection offer is checked once');
        assert.deepEqual(load.operations.filter(op => !op?.startsWith('events.')).sort(), ['pipeline.list', 'project.list', 'quota.status', 'run.recent', 'tests.selection.offer'], load.operations.join(', '));
        assert.equal(load.requests.find(r => r.operation === 'run.recent').query.limit, '20');
        assert.deepEqual(load.root.querySelector('vi-data-table').rows.map(p => p.id), ['pl1', 'pl2']);
        assert.match(all, /storefront\s*·\s*main/, 'the name line names the project and branch');
        assert.match(all, /CI #r1/, 'the newest run by its one name');
        assert.deepEqual([...load.root.querySelectorAll('vi-meter')].map(m => m.getAttribute('label')), quota().items.map(i => i.label), 'one meter per quota item');
        // Health from the newest runs: pl1 failed, pl2 never ran; 1 of the 2 finished runs succeeded.
        // One pipeline is said in the singular (restored after the S4 mutation check).
        assert.match(all, /Failing\s*1\s*pipeline\b(?!s)/);
        assert.match(all, /Never run\s*1\s*pipeline\b(?!s)/);
        assert.match(all, /Success rate\s*50%/);
        assert.match(all, /\bof 2\b/);
        assert.equal(addRunners(load.root).length, 0, 'no limit callout below the limit');
        const create = load.root.querySelector('[data-new]');
        assert.match(create.getAttribute('href'), /\/pipelines\/new$/, 'Create pipeline opens New pipeline');
    });
});

test('/pipelines: filters in the query string really filter, show as chips and clear; empty lists say why', async () => {
    await inConsole({ tenantId: 'wv2' }, async harness => {
        const load = await harness.open('/pipelines?last=failed', listAnswers());
        const table = load.root.querySelector('vi-data-table');
        assert.deepEqual(table.rows.map(p => p.id), ['pl1'], 'only the pipeline whose newest run failed');
        const chips = [...load.root.querySelectorAll('li[data-key]')];
        assert.deepEqual(chips.map(c => c.dataset.key), ['last']);
        assert.match(text(chips[0]), /Failed/);
        assert.equal(load.root.querySelector('[data-count]').textContent, '1');
        chips[0].querySelector('button[aria-label^="Remove filter"]').click();
        assert.deepEqual(table.rows.map(p => p.id), ['pl1', 'pl2']);
        assert.equal(load.root.querySelectorAll('li[data-key]').length, 0);
        assert.doesNotMatch(globalThis.location.search, /last=/);
        const none = await harness.open('/pipelines?q=zzz', listAnswers());
        const noMatch = none.root.querySelector('vi-data-table');
        assert.equal(noMatch.rows.length, 0);
        const empty = await harness.open('/pipelines', listAnswers({ 'pipeline.list': page([]) }));
        const nothing = empty.root.querySelector('vi-data-table').empty;
        assert.notEqual(nothing.title, noMatch.empty.title, 'no pipelines and no match say different things');
        assert.equal(nothing.docs, 'PIPELINE_YAML', 'an empty workspace links the pipeline guide');
        // With a project, the empty list offers a pipeline (an import), not a project (restored after the S4 mutation check).
        assert.ok(empty.root.querySelector('vi-data-table a[href*="/pipelines/import"]'), 'Import from CI');
        assert.equal(empty.root.querySelector('vi-data-table a[href*="/projects?new"]'), null, 'no Create project while one exists');
    });
});

test('/pipelines by role: at the limit only who may add runners gets the link, everyone else is told who can; a viewer cannot create', async () => {
    for (const role of ['owner', 'developer', 'viewer']) {
        await inConsole({ tenantId: `wv3-${role}`, role }, async harness => {
            const load = await harness.open('/pipelines', listAnswers({ 'quota.status': () => fullQuota() }));
            assert.match(load.text(), /All 3 job slots are in use\. 2 jobs are waiting\./, role);
            const links = addRunners(load.root);
            if (role === 'owner') {
                assert.equal(links.length, 1, 'Add runners');
                assert.match(links[0].getAttribute('href'), /\/settings\/runners$/);
                const failing = await harness.open('/pipelines', listAnswers({ 'quota.status': () => { throw Object.assign(new Error('Quota unavailable'), { status: 503 }); } }));
                assert.match(failing.text(), /Quota unavailable/, 'a usage failure is an error with a retry, not empty meters');
                assert.equal(failing.root.querySelector('vi-data-table').rows.length, 2, 'and the list still shows');
            }
            else {
                assert.equal(links.length, 0, `${role}: no Add runners`);
                assert.match(load.text(), /owner or admin/, `${role}: told who can add runners`);
            }
            if (role === 'viewer') {
                const empty = await harness.open('/pipelines', listAnswers({ 'pipeline.list': page([]) }));
                assert.match(empty.root.querySelector('vi-data-table').empty.hint, /developer or admin/, 'a viewer is told who can add the first pipeline');
                assert.equal(empty.root.querySelectorAll('[data-new]').length + controls(empty.root, 'Create pipeline').length, 0, 'no create action for a viewer');
            }
            else
                assert.ok(load.root.querySelector('[data-new]'), `${role} may create a pipeline`);
        });
    }
});

/* ---------- the pipeline record ---------- */

const detailAnswers = (over = {}) => ({
    'pipeline.get': () => pipeline(),
    'project.get': () => project,
    'run.list': page([run('r1', 'failed', { took: 300000 }), run('r2', 'succeeded', { ago: 3, took: 60000 }), run('r3', 'succeeded', { ago: 5, took: 120000 })]),
    'secret.list': page([{ id: 'sec1', name: 'npm-read-token', purpose: 'build', status: 'active', createdAt: NOW - 50 * HOUR }]),
    ...over
});

test('/pipelines/:id: Overview has the latest run, key facts and run numbers from one read of the newest 50 runs, refreshed by run events', async () => {
    const harness = await consoleHarness({ tenantId: 'wv6' });
    const stream = eventStream();
    try {
        let runs = [run('r1', 'failed', { took: 300000 }), run('r2', 'succeeded', { ago: 3, took: 60000 }), run('r3', 'succeeded', { ago: 5, took: 120000 })];
        const load = await harness.open('/pipelines/pl1', detailAnswers({ 'run.list': () => ({ items: runs, nextCursor: null }) }));
        assert.equal(currentTab(load), '', 'Overview is the default tab');
        // docs/design/NAVIGATION.md: Optimize for an active pipeline whose runs the viewer reads; Shadow CI only for shadow pipelines.
        assert.deepEqual([...load.root.querySelectorAll('nav a[aria-current]')].map(a => a.getAttribute('href').replace(/^.*\/pipelines\/pl1/, '')),
            ['', '?tab=runs', '?tab=definition', '?tab=plan', '?tab=settings', '/optimize']);
        assert.equal(controls(load.root, 'Run pipeline').length, 1, 'an owner can run it');
        const banner = load.root.querySelector('[data-event] [data-tone]');
        assert.match(text(banner), /CI #r1/);
        assert.equal(banner.dataset.tone, 'failed', 'the newest run, failed');
        const f = facts(load.root);
        assert.equal(f.Jobs, '2');
        assert.match(f.Limits, /4 at once, 2h 00m/, 'from the plan');
        assert.match(f['Recent runs'], /2\/3$/, 'two of the three newest runs succeeded');
        assert.deepEqual(Object.keys(f), ['Triggers', 'Jobs', 'Limits', 'Recent runs'], 'no schedule or concurrency fact without one');
        assert.equal(count(load, 'run.list'), 1, 'one read of the newest runs feeds the banner, the bars, the rows and the numbers');
        assert.equal(load.requests.find(r => r.operation === 'run.list').query.limit, '50');
        assert.equal(count(load, 'secret.list'), 0, 'the overview reads no secrets');
        const all = load.text();
        assert.match(all, /Success rate\s*67%\s*2 of 3/);
        assert.match(all, /Duration p50\s*2m/);
        assert.match(all, /Duration p90\s*5m/);
        assert.match(all, /\b3 runs\b/);
        assert.match(all, /Failed runs\s*1/);
        assert.ok(load.root.querySelector('a[href$="/runs/r10000000000"]'), 'each recent run links to its run');
        assert.ok(load.root.querySelector('a[href="https://github.com/lumen/storefront"]'), 'the repository is linked');
        assert.ok(load.root.querySelector('[aria-labelledby="pl-next-h"] a[href$="/pipelines/pl1/optimize"]'), 'with runs, the next step is Optimize');
        // Live: a run event of the pipeline's project re-reads the newest runs once, after a pause that absorbs bursts.
        await wait(() => stream.connected());
        assert.equal(harness.requestsSince().find(r => r.operation === 'events.stream')?.query.projectId, 'p1', 'events of this project only');
        const reads = () => harness.requestsSince().filter(r => r.operation === 'run.list').length;
        const before = reads();
        runs = [run('r4', 'succeeded', { ago: 0.1 }), ...runs];
        await withoutPause(1500, async () => {
            stream.send({ type: 'run.updated', runId: 'r4' });
            stream.send({ type: 'run.updated', runId: 'r4' });
            await wait(() => reads() > before);
            await harness.settle();
        });
        assert.equal(reads(), before + 1, 'two events, one read');
        const live = load.root.querySelector('[data-event] [data-tone]');
        assert.equal(live.dataset.tone, 'succeeded', 'the banner shows the new newest run');
        assert.match(text(live), /CI #r4/);
    }
    finally {
        stream.close();
        await harness.close();
    }
});

test('/pipelines/:id: old tab ids and ?view= links open the tab that replaced them', async () => {
    await inConsole({ tenantId: 'wv7' }, async harness => {
        for (const [path, tab, why] of [
            ['/pipelines/pl1?tab=graph', '', 'the old Graph tab is on Overview'],
            ['/pipelines/pl1?tab=metrics', '', 'the old Metrics tab opens Overview, where its numbers are'],
            ['/pipelines/pl1?view=plan', '?tab=plan', 'the old ?view=plan opens the Plan tab'],
            ['/pipelines/pl1?view=json', '?tab=definition', 'the old Overview ?view=json opens Definition']
        ]) {
            const load = await harness.open(path, detailAnswers());
            assert.equal(currentTab(load), tab, why);
        }
        // ?tab=optimize is redirected to the Optimize route (routes/pipelines.mjs), which keeps the tab row.
        const optimize = await harness.open('/pipelines/pl1?tab=optimize', detailAnswers());
        assert.equal(currentTab(optimize), '/optimize');
        assert.equal(optimize.location, '/app/w/wv7/pipelines/pl1/optimize');
    });
});

test('/pipelines/:id?tab=definition and ?tab=plan: the job tree, the source and the compiled plan, with no extra request', async () => {
    await inConsole({ tenantId: 'pv1' }, async harness => {
        const answers = (over = {}) => detailAnswers({ 'pipeline.get': () => matrixPipeline(), 'run.list': page([]), ...over });
        const load = await harness.open('/pipelines/pl1?tab=definition', answers());
        assert.deepEqual(ops(load).sort(), ['pipeline.get', 'project.get'], 'the definition is in the pipeline already');
        assert.equal(currentTab(load), '?tab=definition');
        const jobs = [...load.root.querySelectorAll('details[data-job]')];
        assert.deepEqual(jobs.map(j => j.dataset.job), ['install', 'test']);
        assert.ok(jobs.every(j => j.open), 'a short definition opens every job');
        assert.match(text(jobs[1].querySelector('summary')), /2 steps, 2 legs, after install/);
        const commands = [...jobs[1].querySelectorAll('[title]')].filter(c => /npm/.test(c.title));
        assert.deepEqual(commands.map(c => c.title), ['npm test\nnpm run e2e', 'npm run lint'], 'the whole command on hover');
        assert.deepEqual(commands.map(c => text(c)), ['npm test …', 'npm run lint'], 'the first line of each command');
        const yaml = load.root.querySelector('vi-code');
        assert.equal(typeof yaml.value, 'string', 'the source as YAML text by default');
        assert.match(yaml.value, /npm run lint/);
        const json = await harness.open('/pipelines/pl1?tab=definition&view=json', answers());
        assert.deepEqual(json.root.querySelector('vi-code').value, matrixDefinition(), 'the JSON view is the definition itself');
        const plan = await harness.open('/pipelines/pl1?tab=plan', answers());
        assert.deepEqual(ops(plan).sort(), ['pipeline.get', 'project.get']);
        assert.match(text(plan.root.querySelector('#pl-plan-jobs')), /\b3\b.*\b2\b/, '3 jobs from 2 in the definition');
        assert.match(plan.root.querySelector('#pl-plan-digest').textContent, /dddddddddddd/);
        assert.ok(plan.root.querySelector('#pl-plan-digest [data-copy-action]'), 'the digest can be copied');
        const keys = [...plan.root.querySelectorAll('table[aria-label] tbody tr')].map(tr => text(tr.querySelector('td')));
        assert.deepEqual(keys, ['install__0', 'test__0', 'test__1'], 'one row per expanded job');
        const missing = await harness.open('/pipelines/pl1?tab=plan', answers({ 'pipeline.get': () => matrixPipeline({ plan: null }) }));
        assert.equal(missing.root.querySelectorAll('table[aria-label] tbody tr').length, 0);
        assert.match(missing.text(), /No compiled plan/);
    });
});

test('/pipelines/:id?tab=settings: a text value reads first, Edit opens its field, Escape cancels and Save is one versioned update', async () => {
    await inConsole({ tenantId: 'pv3' }, async harness => {
        let saved = null;
        const load = await harness.open('/pipelines/pl1?tab=settings', detailAnswers({
            'pipeline.get': () => matrixPipeline(),
            'pipeline.update': (input, record) => {
                saved = { input, record };
                return matrixPipeline({ version: 4, definition: { ...matrixDefinition(), timeoutSeconds: input.timeoutSeconds } });
            }
        }));
        const row = () => load.root.querySelector('#pl-row-timeout');
        assert.match(row().textContent, /2h 00m/);
        assert.equal(row().querySelector('form'), null, 'read first');
        row().querySelector('[data-read-edit]').click();
        const form = row().querySelector('form');
        assert.ok(form, 'Edit turns the value into its field');
        assert.equal(harness.document.activeElement, form.querySelector('input'), 'focus moves to the field');
        form.dispatchEvent(Object.assign(new globalThis.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
        assert.equal(row().querySelector('form'), null, 'Escape cancels');
        assert.equal(harness.document.activeElement, row().querySelector('[data-read-edit]'), 'focus returns to Edit');
        assert.equal(saved, null, 'nothing was saved');
        row().querySelector('[data-read-edit]').click();
        row().querySelector('input').value = '500';
        row().querySelector('form').requestSubmit();
        await wait(() => row().querySelector('vi-field')?.error);
        assert.match(row().querySelector('vi-field').error, /\b1\b.*\b180\b/, 'a refused value says the range under the field');
        assert.equal(saved, null);
        row().querySelector('input').value = '45';
        row().querySelector('form').requestSubmit();
        await wait(() => saved);
        assert.equal(saved.input.timeoutSeconds, 2700);
        assert.equal(saved.record.ifMatch, '3', 'the save names the version it changes');
        await wait(() => !row().querySelector('form'));
        assert.match(row().textContent, /45m/, 'the row reads the saved value');
    });
});

test('/pipelines/:id?tab=settings: a switch is one versioned update; when someone else saved first it goes back and offers a reload', async () => {
    await inConsole({ tenantId: 'wv8' }, async harness => {
        let saved = null;
        const load = await harness.open('/pipelines/pl1?tab=settings', detailAnswers({
            'pipeline.update': (input, record) => {
                if (saved)
                    throw Object.assign(new Error('Version conflict'), { status: 409, code: 'VERSION_CONFLICT' });
                saved = { input, record };
                return pipeline({ version: 4, definition: { ...definition(), triggers: input.triggers } });
            }
        }));
        assert.ok(load.root.querySelector('vi-toc'), 'on this page contents');
        assert.deepEqual(['Run on pushes', 'Run on pull requests', 'Run on merge queue groups', 'Public status badge'].map(n => switchNamed(load.root, n)?.getAttribute('aria-checked')),
            ['true', 'true', 'false', 'false'], 'each switch reads the definition');
        assert.match(load.root.querySelector('#pl-row-parallel').textContent, /4 at once\s*\(default\)/, 'a value at its default says so');
        const secrets = load.root.querySelector('[aria-label="Secrets and variables"]');
        assert.match(secrets.textContent, /NPM_TOKEN/);
        assert.match(secrets.textContent, /npm-read-token/, 'an owner sees the secret name');
        assert.ok(secrets.querySelector('vi-secret-value'), 'the value is never shown');
        assert.equal(controls(load.root, 'Add secret').length, 1);
        switchNamed(load.root, 'Run on pull requests').click();
        await wait(() => saved, 50);
        assert.ok(saved, 'the switch saved at once');
        assert.equal(saved.record.ifMatch, '3', 'the save names the version it changes');
        assert.deepEqual(saved.input.triggers, { push: ['main'] });
        assert.deepEqual(saved.input.jobs, definition().jobs, 'everything else is sent unchanged');
        switchNamed(load.root, 'Run on merge queue groups').click();
        await wait(() => load.root.querySelector('[role="alert"]'), 20);
        const alert = load.root.querySelector('[role="alert"]');
        assert.match(alert.textContent, /saved this pipeline first/);
        assert.equal(switchNamed(load.root, 'Run on merge queue groups').getAttribute('aria-checked'), 'false', 'the switch goes back');
        const reads = harness.requestsSince().filter(r => r.operation === 'pipeline.get').length;
        controls(alert, 'Reload')[0].click();
        await wait(() => harness.requestsSince().filter(r => r.operation === 'pipeline.get').length > reads);
        assert.equal(harness.requestsSince().filter(r => r.operation === 'pipeline.get').length, reads + 1, 'Reload reads the newest version');
    });
});

test('/pipelines/:id?tab=settings: a viewer reads the settings and can change nothing; while archived, Edit is disabled with the reason', async () => {
    await inConsole({ tenantId: 'wv10', role: 'viewer' }, async viewer => {
        const load = await viewer.open('/pipelines/pl1?tab=settings', detailAnswers());
        assert.match(load.root.querySelector('#pl-row-name').textContent, /CI/, 'the values still read');
        // Restored after the S4 mutation check: "developer or admin" alone also matches the secrets hint.
        assert.match(load.text(), /developer or admin can change them/, 'a viewer is told who can change the settings');
        assert.equal(load.root.querySelectorAll('[data-read-edit]').length, 0, 'no Edit a viewer cannot use');
        const switches = [...load.root.querySelectorAll('[role="switch"]')];
        assert.ok(switches.length > 0 && switches.every(s => s.disabled), 'the switches are there and disabled');
        assert.equal(count(load, 'secret.list'), 0, 'secret names are read only with secret.manage');
        for (const name of ['Add secret', 'Add variable', 'Delete pipeline', 'Archive pipeline', 'Run pipeline'])
            assert.equal(controls(load.root, name).length, 0, `no ${name} for a viewer`);
        assert.equal(load.root.querySelectorAll('[data-settings] button[type="submit"]').length, 0, 'no Save buttons a viewer cannot use');
        assert.ok(![...load.root.querySelectorAll('[data-settings] a')].some(a => a.getAttribute('href')?.endsWith('/edit')), 'no editor link for a viewer');
    });
    await inConsole({ tenantId: 'pv5' }, async owner => {
        const load = await owner.open('/pipelines/pl1?tab=settings', detailAnswers({ 'pipeline.get': () => matrixPipeline({ status: 'archived' }) }));
        const edits = [...load.root.querySelectorAll('[data-read-edit]')];
        assert.ok(edits.length > 0, 'Edit stays in view while archived (a state, not a permission)');
        const reason = edits[0].dataset.tooltip;
        assert.match(reason, /Unarchive/);
        for (const button of edits) {
            assert.equal(button.getAttribute('aria-disabled'), 'true');
            assert.equal(button.dataset.tooltip, reason, 'one reason everywhere');
            assert.equal(load.root.querySelector(`#${button.getAttribute('aria-describedby')}`).textContent, reason, 'and read out with the button');
        }
        edits[0].click();
        assert.equal(load.root.querySelector('[data-settings] form'), null, 'a disabled Edit opens no field');
        assert.ok(load.root.querySelector('[aria-labelledby="pl-general"]').textContent.includes(reason), 'and the page says why');
        assert.ok([...load.root.querySelectorAll('[role="switch"]')].every(sw => sw.disabled), 'switches are disabled, with the same reason');
        assert.match(load.root.querySelector('[aria-labelledby="pl-danger"]').textContent, /Unarchive pipeline/, 'it can be unarchived');
    });
});

/* ---------- New pipeline ---------- */

test('/pipelines/new: the ways to start, the template gallery, the editor and "Write YAML", with no request before Save', async () => {
    await inConsole({ tenantId: 'wv11' }, async harness => {
        const start = await harness.open('/pipelines/new', { 'project.list': page([project]) });
        const kinds = [...start.root.querySelectorAll('a[data-kind]')].map(a => [a.dataset.kind, a.getAttribute('href').replace(/^\/app\/w\/[^/]+/, '')]);
        assert.deepEqual(kinds, [
            ['template', '/pipelines/new?projectId=p1&start=template'],
            ['import', '/pipelines/import?projectId=p1'],
            ['yaml', '/pipelines/new?projectId=p1&template=blank&mode=yaml'],
            ['drop-in', '/get-started/drop-in']
        ]);
        assert.deepEqual(start.operations.filter(Boolean), ['project.list'], 'the type picker makes no other request');
        const gallery = await harness.open('/pipelines/new?start=template', { 'project.list': page([project]) });
        const uses = [...gallery.root.querySelectorAll('a[data-use]')];
        assert.equal(uses.length, TEMPLATES.length, 'one card per template');
        assert.match(uses[0].getAttribute('href'), /\/pipelines\/new\?projectId=p1&start=template&template=node&step=review$/);
        assert.deepEqual(gallery.operations.filter(op => op && op !== 'project.list'), [], 'the gallery makes no other request (the project lookup is cached)');
        const editor = await harness.open('/pipelines/new?template=node&projectId=p1', { 'project.list': page([project]), 'pipeline.validate': () => ({ jobs: [{}, {}, {}], maxParallel: 4, timeoutSeconds: 7200 }) });
        assert.ok(editor.text().includes(createSummary(templateDefinition('node'))), 'the editor says what creating it will do');
        assert.equal(count(editor, 'pipeline.create'), 0, 'nothing is created before Save');
        const yaml = await harness.open('/pipelines/new?template=blank&mode=yaml&projectId=p1', { 'project.list': page([project]), 'pipeline.validate': () => ({ jobs: [{}], maxParallel: 4, timeoutSeconds: 7200 }) });
        assert.equal(yaml.root.querySelector('[data-mode]').value, 'yaml', '"Write YAML" opens the YAML tab');
        const dock = yaml.root.querySelector('[data-docked-footer]');
        assert.ok(dock.querySelector('[data-save]') && dock.querySelector('[data-cancel]') && dock.querySelector('[data-pill]'), 'status, Cancel and Create in the docked footer');
    });
});

test('/pipelines/new review: what will be created, the same call as an API request, one pipeline.create; a refused create says why in place', async () => {
    await inConsole({ tenantId: 'pv6' }, async harness => {
        let created = null;
        const load = await harness.open('/pipelines/new?start=template&template=node&step=review&projectId=p1', {
            'project.list': page([project]),
            'pipeline.create': input => {
                created = input;
                return { id: 'pl9', projectId: 'p1', version: 1, definition: input };
            },
            'pipeline.get': () => pipeline({ id: 'pl9' })
        });
        assert.deepEqual(ops(load), ['project.list'], 'the review makes no request of its own');
        assert.equal(load.root.querySelector('[aria-current="step"]').dataset.stage, 'review');
        assert.ok(load.text().includes(createSummary(templateDefinition('node'))), 'what creating it will do');
        const request = load.root.querySelector('[data-api-request="pipeline.create"]');
        assert.ok(request, 'Show as API request');
        // The shared "Show as API request" (components/settings.mjs apiRequest, lib/api-request.mjs).
        const command = request.querySelector('[data-api-command="curl"]').value;
        assert.match(command, /curl -X POST ".*\/v1\/tenants\/pv6\/pipelines"/);
        assert.match(command, /idempotency-key/, 'pipeline.create is deduplicated, so the request carries a key');
        assert.equal(requestBody(command).projectId, 'p1');
        assert.match(request.querySelector('[data-api-command="cli"]').value, /^cri request pipeline\.create --tenant pv6 --key/);
        const dock = load.root.querySelector('[data-docked-footer]');
        assert.match(dock.querySelector('[data-editor]').getAttribute('href'), /\/pipelines\/new\?projectId=p1&template=node$/, 'Edit before creating opens the editor on the template');
        const name = load.root.querySelector('[data-name]');
        name.value = 'Web CI';
        name.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
        assert.equal(requestBody(load.root.querySelector('[data-api-command="curl"]').value).name, 'Web CI', 'the request follows the form');
        dock.querySelector('[data-create]').click();
        await wait(() => created);
        assert.equal(created.name, 'Web CI');
        assert.equal(created.projectId, 'p1');
        assert.deepEqual(created.jobs.map(j => j.id), ['install', 'test', 'build']);
        assert.equal(harness.requestsSince().filter(r => r.operation === 'pipeline.create').length, 1);
        const refused = await harness.open('/pipelines/new?start=template&template=go&step=review&projectId=p1', {
            'project.list': page([project]),
            'pipeline.create': () => { throw Object.assign(new Error('Pipeline limit reached for this project.'), { status: 409, code: 'LIMIT' }); }
        });
        refused.root.querySelector('[data-create]').click();
        await wait(() => refused.root.querySelector('[data-error] [role="alert"]'));
        const alert = refused.root.querySelector('[data-error] [role="alert"]');
        assert.match(alert.textContent, /Pipeline limit reached/, 'the server\'s reason');
        assert.ok([...alert.querySelectorAll('a')].some(a => /\/pipelines\/new\?/.test(a.getAttribute('href') || '') && /template=go/.test(a.getAttribute('href'))), 'and a way into the editor');
        assert.equal(refused.root.querySelector('[data-create]').disabled, false, 'it can be tried again');
    });
});

/* ---------- audit, backtests, source control ---------- */

const auditResult = {
    contract: 'cri.workflow-audit/1', path: '.github/workflows/ci.yml', workflow: { name: null, triggers: ['pull_request_target'], jobs: 1 },
    security: { counts: { critical: 0, high: 1, medium: 1, low: 0, info: 0 }, worst: 'high', rules: ['script-injection', 'token-permissions'] },
    practices: { score: 40, grade: 'D', checks: [{ id: 'concurrency', title: 'Superseded runs are cancelled', weight: 15, status: 'fail', passed: 0, applicable: 1, fix: { summary: 'Group runs.' }, failing: [] }] },
    findings: [
        { rule: 'token-permissions', category: 'security', severity: 'medium', title: 'GITHUB_TOKEN permissions are default', message: 'No permissions are declared.', line: 1, job: null, fix: { summary: 'Declare permissions.', example: 'permissions:\n  contents: read' } },
        { rule: 'script-injection', category: 'security', severity: 'high', title: 'Script injection from event data', message: 'Event data is pasted into the script.', line: 7, job: 'b', step: 1, expression: 'github.event.pull_request.title', fix: { summary: 'Use an environment variable.', example: 'env:\n  TITLE: x' } }
    ],
    truncated: 0, next: { action: 'import', label: 'Import this and run it in shadow mode', format: 'github-actions', path: '.github/workflows/ci.yml' }
};

test('/pipelines/audit: findings most severe first (then by line), each opening in place, filtered by severity with stable keys', async () => {
    const findings = [
        { rule: 'a', category: 'security', severity: 'medium', line: 3 },
        { rule: 'b', category: 'security', severity: 'high', line: 9 },
        { rule: 'c', category: 'security', severity: 'high', line: 2 },
        { rule: 'p', category: 'practice', severity: 'low', line: 1 }
    ];
    assert.deepEqual(sortedFindings(findings).map(f => f.rule), ['c', 'b', 'a'], 'practice items are not security findings');
    assert.deepEqual(sortedFindings(findings, 'medium').map(f => f.rule), ['a']);
    assert.deepEqual(severityOptions({ high: 2, medium: 1 }).map(o => [o.value, o.count]), [['', 3], ['high', 2], ['medium', 1]]);
    assert.equal(findingKey(findings[0], 4), 'a-3--4');
    assert.equal(findingKey({ rule: 'x.y', line: null, job: 'B 1' }, 0), 'x-y-0-b-1-0', 'safe as an element id');
    await inConsole({ tenantId: 'pv9' }, async harness => {
        const load = await harness.open('/pipelines/audit', { 'project.list': page([project]), 'workflow.audit': () => auditResult });
        const source = load.root.querySelector('textarea');
        source.value = 'on: push';
        source.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
        load.root.querySelector('[data-run]').click();
        await wait(() => load.root.querySelector('[data-sev]'));
        assert.equal(harness.requestsSince().filter(r => r.operation === 'workflow.audit').length, 1, 'Audit workflow runs the audit once');
        assert.deepEqual([...load.root.querySelectorAll('[data-sev]')].map(s => s.dataset.sev), ['high', 'medium'], 'most severe first');
        const toggle = load.root.querySelector('[aria-expanded][aria-controls]');
        const detail = () => load.root.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`);
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(detail().hidden, true);
        toggle.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(detail().hidden, false);
        assert.match(detail().textContent, /Event data is pasted into the script/);
        assert.match(detail().textContent, /github\.event\.pull_request\.title/);
        assert.ok(detail().querySelector('vi-code'), 'the fix example');
        const filter = load.root.querySelector('vi-segmented[label="Severity"]');
        assert.deepEqual(filter.options.map(o => [o.value, o.label, o.count]), [['', 'All', 2], ['high', 'High', 1], ['medium', 'Medium', 1]], 'a severity is labelled by its name');
        assert.match(load.text(), /\b40 of 100 \(D\)/, 'the best-practice score and grade');
    });
});

const backtest = (over = {}) => ({
    id: 'bt1234567890', projectId: 'p1', kind: 'report-gate', label: 'test: reports/junit.xml', status: 'succeeded', windowDays: 90, createdAt: NOW - HOUR, createdBy: 'u2',
    ruleDigest: 'f'.repeat(64), rule: { pipelineId: 'pl1', jobId: 'test', format: 'junit', specPath: 'reports/junit.xml', minTests: 10 },
    result: { kind: 'report-gate', counts: { evaluated: 4, wouldBlock: 1, changed: 1, transitions: {} }, rates: {}, incidents: [], examples: [], coverage: {} },
    ...over
});

test('/backtests/:id: key facts under the header, and the same backtest as an API request only for who may start one', async () => {
    await inConsole({ tenantId: 'pv10' }, async owner => {
        const load = await owner.open('/backtests/bt1234567890', { 'backtest.get': () => backtest(), 'project.get': () => project });
        const values = Object.values(facts(load.root));
        assert.ok(values.includes('storefront'), 'the project by name');
        assert.ok(values.some(v => /\b90\b/.test(v)), 'the window in days');
        assert.ok(values.some(v => /^f{7}/.test(v)), 'the rule digest');
        const request = load.root.querySelector('[data-api-request="backtest.start"]');
        assert.ok(request);
        const curl = request.querySelector('[data-api-command="curl"]').value;
        assert.deepEqual(requestBody(curl), { projectId: 'p1', kind: 'report-gate', rule: backtest().rule, label: 'test: reports/junit.xml' });
        assert.deepEqual(ops(load).sort(), ['backtest.get', 'project.get']);
    });
    await inConsole({ tenantId: 'pv11', role: 'viewer' }, async viewer => {
        const load = await viewer.open('/backtests/bt1234567890', { 'backtest.get': () => backtest(), 'project.get': () => project });
        assert.equal(load.root.querySelector('[data-api-request]'), null, 'a viewer cannot start one, so it is not offered');
    });
});

test('scm pages: the pull request and commit views load with key facts and their checks', async () => {
    await inConsole({ tenantId: 'wv12' }, async harness => {
        const sha = 'b'.repeat(40);
        const runs = [{ ...run('r1', 'succeeded'), commit: sha, pullRequest: 481, jobTotal: 2, jobCounts: { succeeded: 2 } }];
        const commit = await harness.open(`/projects/p1/commits/${sha}`, { 'scm.commit': () => ({ project, runs, pipelines: { pl1: 'CI' }, rollup: { state: 'success', pipelines: 1 } }) });
        assert.match(commit.text(), /All checks passed/);
        assert.match(commit.text(), /CI #r1/);
        const pull = await harness.open('/projects/p1/pulls/481', {
            'scm.pull': () => ({ project, title: 'Add saved searches', headRef: 'feat/search', baseRef: 'main', commits: [{ commit: sha, runs, rollup: { state: 'success', pipelines: 1 }, firstSeenAt: NOW }], pipelines: { pl1: 'CI' }, reviews: { items: [] } })
        });
        assert.match(pull.text(), /Add saved searches/);
        assert.match(pull.text(), /feat\/search/);
        assert.match(pull.text(), /All checks passed/);
    });
});
