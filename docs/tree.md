# gutenberg-mcp-server - Directory Structure

Generated on: 2026-09-20 13:59:45

```text
gutenberg-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── catalog-mirror-init.ts
│   ├── catalog-mirror-refresh.ts
│   ├── catalog-mirror-verify.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── gutenberg-browse-popular.tool.ts
│   │           ├── gutenberg-get-book.tool.ts
│   │           ├── gutenberg-get-text.tool.ts
│   │           └── gutenberg-search-books.tool.ts
│   ├── services/
│   │   ├── catalog-mirror/
│   │   │   ├── catalog-mirror-service.ts
│   │   │   ├── catalog-mirror-store.ts
│   │   │   ├── rdf-archive-stream.ts
│   │   │   └── rdf-book-parser.ts
│   │   ├── gutenberg-text/
│   │   │   ├── gutenberg-text-service.ts
│   │   │   └── types.ts
│   │   ├── gutendex/
│   │   │   ├── gutendex-service.ts
│   │   │   └── types.ts
│   │   └── upstream-deadline.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── catalog-mirror/
│   │       ├── gutendex/
│   │       │   ├── 10001.json
│   │       │   ├── 10056.json
│   │       │   ├── 45304.json
│   │       │   └── 84.json
│   │       ├── rdf/
│   │       │   ├── pg1000.rdf
│   │       │   ├── pg10001.rdf
│   │       │   ├── pg10056.rdf
│   │       │   ├── pg10137.rdf
│   │       │   ├── pg1073.rdf
│   │       │   ├── pg1399.rdf
│   │       │   ├── pg45304.rdf
│   │       │   └── pg84.rdf
│   │       ├── catalog-sample-updated.tar.bz2
│   │       └── catalog-sample.tar.bz2
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── catalog-mirror/
│   │   │   ├── archive-server.ts
│   │   │   ├── catalog-mirror-service.test.ts
│   │   │   ├── catalog-mirror-store.test.ts
│   │   │   ├── rdf-archive-stream.test.ts
│   │   │   └── rdf-book-parser.test.ts
│   │   ├── gutenberg-text/
│   │   │   └── gutenberg-text-service.test.ts
│   │   ├── gutendex/
│   │   │   ├── gutendex-mirror-read-path.test.ts
│   │   │   └── gutendex-service.test.ts
│   │   └── upstream-deadline.test.ts
│   └── tools/
│       ├── gutenberg-browse-popular.tool.test.ts
│       ├── gutenberg-get-book.tool.test.ts
│       ├── gutenberg-get-text.tool.test.ts
│       └── gutenberg-search-books.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
├── tsconfig.scripts-check.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
