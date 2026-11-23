# workerd fixture

A Worker run in workerd through Miniflare, with two tests that each reach one
function. Cupel's node:test collector measures the Worker's lines per test inside
workerd (spike S30, D18). The test needs `CUPEL_TEST_MINIFLARE` to name a
package.json whose `node_modules` has Miniflare 5; it is skipped otherwise.
