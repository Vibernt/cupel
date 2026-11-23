// Exact Node runtimes for the experimental selective-PR profile tests. They default to the
// maintainer machine's Homebrew paths; set CUPEL_TEST_NODE26 / CUPEL_TEST_NODE22 to the same
// versions installed elsewhere (for example under nvm). The profile still checks each version.
export const NODE26 = process.env.CUPEL_TEST_NODE26 ?? '/opt/homebrew/Cellar/node/26.7.0/bin/node';
export const NODE22 = process.env.CUPEL_TEST_NODE22 ?? '/opt/homebrew/opt/node@22/bin/node';
