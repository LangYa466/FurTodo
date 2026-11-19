module.exports = [
  {ignores: ['.wrangler/', 'node_modules/', 'worker-configuration.d.ts']},
  ...require('gts'),
  {
    // Google TS style: only single-line `if` statements may omit braces.
    rules: {curly: ['error', 'multi-line']},
  },
];
