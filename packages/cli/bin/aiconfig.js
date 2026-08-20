#!/usr/bin/env node
'use strict';

const { runCli } = require('../dist/index.js');

runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    process.stderr.write(`aiconfig: unexpected failure\n${String(error)}\n`);
    process.exitCode = 70;
  },
);
