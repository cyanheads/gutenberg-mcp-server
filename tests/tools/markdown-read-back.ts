/**
 * @fileoverview CommonMark read-back of tool `content[]`, shared by the tool tests. A
 * real parse is the only proof that a value survives rendering: the `format-parity`
 * lint's sentinels are alphanumeric, so they never reach an escape, and a raw-text
 * assertion passes whether the value is encoded or not.
 * @module tests/tools/markdown-read-back
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import MarkdownIt, { type Token } from 'markdown-it';

const parser = new MarkdownIt('commonmark');
/** A destination reads back as written: percent-encoding it is rendering, not parsing. */
parser.normalizeLink = (url) => url;

/** One leaf block of a parsed document, in reading order. */
export interface ReadBackBlock {
  container: 'list' | 'quote' | undefined;
  kind: 'code' | 'heading' | 'paragraph' | 'rule';
  /** Decoded text, line breaks as LF. A code block drops its closing LF. */
  text: string;
}

/** What a CommonMark reader gets from a document. */
export interface ReadBack {
  blocks: ReadBackBlock[];
  /** The content of every inline code span. */
  codeSpans: string[];
  /** The text inside every `em`. */
  emphasis: string[];
  links: { href: string; label: string }[];
  /** The text inside every `strong`. */
  strong: string[];
  /**
   * Every block's text: a blank line between blocks, one line break between list
   * items. Raw HTML and images are dropped, as a page displays neither as text, so a
   * value that parsed as either no longer matches its source.
   */
  text: string;
}

/** Appends one inline token run to `doc`, returning the text a reader sees. */
function readInline(children: Token[], doc: ReadBack): string {
  let text = '';
  const open: number[] = [];
  const hrefs: string[] = [];
  for (const token of children) {
    switch (token.type) {
      case 'text':
        text += token.content;
        break;
      case 'code_inline':
        text += token.content;
        doc.codeSpans.push(token.content);
        break;
      case 'softbreak':
      case 'hardbreak':
        text += '\n';
        break;
      case 'em_open':
      case 'strong_open':
        open.push(text.length);
        break;
      case 'em_close':
        doc.emphasis.push(text.slice(open.pop()));
        break;
      case 'strong_close':
        doc.strong.push(text.slice(open.pop()));
        break;
      case 'link_open':
        open.push(text.length);
        hrefs.push(String(token.attrGet('href')));
        break;
      case 'link_close':
        doc.links.push({ href: String(hrefs.pop()), label: text.slice(open.pop()) });
        break;
      default:
        break;
    }
  }
  return text;
}

/** Parses `markdown` as CommonMark and reads back what it says. */
export function readBack(markdown: string): ReadBack {
  const doc: ReadBack = {
    blocks: [],
    codeSpans: [],
    emphasis: [],
    links: [],
    strong: [],
    text: '',
  };
  let lists = 0;
  let quotes = 0;
  let kind: ReadBackBlock['kind'] = 'paragraph';
  const push = (blockKind: ReadBackBlock['kind'], text: string) => {
    const container = lists > 0 ? 'list' : quotes > 0 ? 'quote' : undefined;
    const previous = doc.blocks.at(-1);
    if (previous) doc.text += previous.container === 'list' && lists > 0 ? '\n' : '\n\n';
    doc.text += text;
    doc.blocks.push({ container, kind: blockKind, text });
  };
  for (const token of parser.parse(markdown, {})) {
    switch (token.type) {
      case 'bullet_list_open':
      case 'ordered_list_open':
        lists++;
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists--;
        break;
      case 'blockquote_open':
        quotes++;
        break;
      case 'blockquote_close':
        quotes--;
        break;
      case 'heading_open':
        kind = 'heading';
        break;
      case 'paragraph_open':
        kind = 'paragraph';
        break;
      case 'inline':
        push(kind, readInline(token.children ?? [], doc));
        break;
      case 'fence':
      case 'code_block':
        push('code', token.content.replace(/\n$/, ''));
        break;
      case 'hr':
        push('rule', '---');
        break;
      default:
        break;
    }
  }
  return doc;
}

/**
 * The text a client assembles from `content[]`. The trailer is its own block and leads
 * with a blank line, so plain concatenation is the join that needs no help.
 */
export function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/** Line endings as a CommonMark parse reads them. */
export const lf = (text: string): string => text.replace(/\r\n?/g, '\n');

/** Syntax in one value: emphasis, a code span, a link, raw HTML, and an entity. */
export const ACTIVE_MARKDOWN = '*a* _b_ `c` [d](https://x.test) <i>e</i> &amp; \\f';

const INLINE_TOKENS = [
  ...['*', '**', '_', '__', '`', '``', '~', '~~', '[', ']', '(', ')', '[a](b)', '![a](b)'],
  ...['<', '>', '<b>', '</b>', '<x@y.test>', '<http://x.test>', '&', '&amp', '&amp;', '&#35'],
  ...['&#35;', '&#x23', '#', '##', '-', '--', '---', '+', '=', '===', '.', '1.', '2)', '!', '|'],
  ...['\\', '"', "'", ':', ':-', ';', ',', ' ', '  ', '\t', 'a', 'Z', '7', 'é', '日本', '😀'],
  ...[' ', 'https://x.test/a_b_(c)'],
];
const LINE_BREAKS = ['\n', '\n\n', '\r\n', '\r'];

/** One line of text built from Markdown syntax, at least one token long. */
export const hostileLine = fc
  .array(fc.constantFrom(...INLINE_TOKENS), { minLength: 1, maxLength: 7 })
  .map((tokens) => tokens.join(''));

/** Text built from Markdown syntax and line breaks of every kind, blank lines included. */
export const hostileText = fc
  .array(fc.constantFrom(...INLINE_TOKENS, ...LINE_BREAKS), { minLength: 1, maxLength: 9 })
  .map((tokens) => tokens.join(''));

/** Runs a property over a fixed seed, so a failure reproduces and a run never flakes. */
export const PROPERTY_RUNS = { numRuns: 400, seed: 3731 };
