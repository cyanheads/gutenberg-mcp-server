/**
 * @fileoverview Tests for the bundle agent-doc selector `AGENT_DOC_ENTRY`, shared by
 * `scripts/clean-mcpb.ts` (the strip step) and `scripts/lint-packaging.ts` (the
 * post-bundle check): agent docs at a dependency's package root are stripped, while
 * a deeper `skills/` — the MCP SDK's runtime `dist/ext/skills/` modules — ships, or
 * the bundle fails at boot with a module-resolution error (mcp-ts-core #794).
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';

const SCRIPTS = ['clean-mcpb.ts', 'lint-packaging.ts'] as const;

/**
 * Loaded by URL at run time: `lint-packaging.ts` carries a framework-repo-only
 * `import('../src/mcp-server/skills.js')`, which a static import would hand to
 * `tsc` (mcp-ts-core #797).
 */
async function loadSelector(script: (typeof SCRIPTS)[number]): Promise<RegExp> {
  const mod: { AGENT_DOC_ENTRY: RegExp } = await import(
    new URL(`../../scripts/${script}`, import.meta.url).href
  );
  return mod.AGENT_DOC_ENTRY;
}

const STRIPPED = [
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/dotenv/skills/dotenvx/references/usage.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/guide/SKILL.md',
  'node_modules/some-pkg/docs/guide/SKILL.md',
];

const KEPT = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
  'skills/catalog-guide/SKILL.md',
  'dist/index.js',
];

describe.each(SCRIPTS)('AGENT_DOC_ENTRY in scripts/%s', (script) => {
  it.each(STRIPPED)('strips %s', async (entry) => {
    expect((await loadSelector(script)).test(entry)).toBe(true);
  });

  it.each(KEPT)('keeps %s', async (entry) => {
    expect((await loadSelector(script)).test(entry)).toBe(false);
  });
});

describe('AGENT_DOC_ENTRY pair', () => {
  it('is the same literal in the strip step and the post-bundle check', async () => {
    const [clean, lint] = await Promise.all(SCRIPTS.map(loadSelector));
    expect(lint?.source).toBe(clean?.source);
    expect(lint?.flags).toBe(clean?.flags);
  });
});
