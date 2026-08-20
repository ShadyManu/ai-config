'use strict';

const { rmSync } = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const output = path.join(__dirname, 'dist');
const workspaceSource = (name) => path.join(__dirname, '..', name, 'src', 'index.ts');

// The published CLI has one runtime module. Bundling here deliberately pulls
// in the private workspace packages and yaml so npm consumers never need the
// monorepo's internal package graph.
rmSync(output, { recursive: true, force: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'src', 'index.ts')],
    outfile: path.join(output, 'index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20.10',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    alias: {
      '@aiconfig/core': workspaceSource('core'),
      '@aiconfig/providers': workspaceSource('providers'),
      '@aiconfig/adapter-claude': workspaceSource('adapter-claude'),
      '@aiconfig/adapter-codex': workspaceSource('adapter-codex'),
      '@aiconfig/adapter-copilot': workspaceSource('adapter-copilot'),
      '@aiconfig/adapter-opencode': workspaceSource('adapter-opencode'),
      '@aiconfig/agents-md': workspaceSource('agents-md'),
    },
  })
  .catch(() => {
    process.exitCode = 1;
  });
