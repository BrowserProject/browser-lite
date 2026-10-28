import { BrowserLiteError } from '../errors.js';
import type { ContentScript, ContentStyle } from './types.js';

/** A script as the engine takes it (bl_set_user_content, engine/abi.json). */
export interface EngineScript {
  source: string;
  matches: string[];
  excludes: string[];
  runAt: 'document-start' | 'document-end';
  allFrames: boolean;
  world: 'isolated' | 'main';
}

/** A style sheet as the engine takes it. */
export interface EngineStyle {
  source: string;
  matches: string[];
  excludes: string[];
  allFrames: boolean;
}

/** The page content of one extension. */
export interface ExtensionContent {
  extension: string;
  scripts: EngineScript[];
  styles: EngineStyle[];
}

// WebCore's UserContentURLPattern: scheme://host/path, host '*', '*.example.com' or exact
// without port or user, '*' anywhere in the path; '*' as scheme is http and https
const PATTERN = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|(?:\*\.)?[^/*:@]+)?(\/.*)$/;

const invalid = (message: string): never => {
  throw new BrowserLiteError('invalid-options', message);
};

/** Checks a match pattern; `<all_urls>` becomes every http(s) address. */
export function matchPattern(pattern: unknown): string {
  if (pattern === '<all_urls>') return '*://*/*';
  const match = typeof pattern === 'string' ? PATTERN.exec(pattern) : null;
  if (!match || (!match[2] && match[1] !== 'file'))
    return invalid(`Invalid match pattern: ${String(pattern)}`);
  return pattern as string;
}

function patterns(value: unknown, name: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && !value.length))
    return invalid(`${name} must be a${required ? ' non-empty' : ''} list of match patterns`);
  return value.map(matchPattern);
}

function code(value: unknown): string {
  return typeof value === 'string' ? value : invalid('code must be a string');
}

/** A checked script for the engine. */
export function engineScript(script: ContentScript): EngineScript {
  const { runAt = 'document-end', world = 'isolated' } = script;
  if (runAt !== 'document-start' && runAt !== 'document-end')
    invalid("runAt must be 'document-start' or 'document-end'");
  if (world !== 'isolated' && world !== 'main') invalid("world must be 'isolated' or 'main'");
  return {
    source: code(script.code),
    matches: patterns(script.matches, 'matches', true),
    excludes: patterns(script.excludeMatches, 'excludeMatches', false),
    runAt,
    allFrames: script.allFrames === true,
    world,
  };
}

/** A checked style sheet for the engine. */
export function engineStyle(style: ContentStyle): EngineStyle {
  return {
    source: code(style.code),
    matches: patterns(style.matches, 'matches', true),
    excludes: patterns(style.excludeMatches, 'excludeMatches', false),
    allFrames: style.allFrames === true,
  };
}
