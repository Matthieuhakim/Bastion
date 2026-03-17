import type { InterceptionRule, ParamsMapping } from './types.js';

export interface CompiledRule extends InterceptionRule {
  urlRegex: RegExp;
}

/**
 * Converts a glob URL pattern to a RegExp.
 * - `**` matches anything (including path separators)
 * - `*` matches any character except `/`
 * - All other characters are escaped
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      regexStr += '.*';
      i++; // skip second *
      // skip optional trailing slash after **
      if (pattern[i + 1] === '/') {
        regexStr += '/?';
        i++;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/** Compile all rules, converting urlPattern globs to RegExp at startup. */
export function compileRules(rules: InterceptionRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    ...rule,
    urlRegex: globToRegex(rule.urlPattern),
  }));
}

function getUrl(toolArgs: Record<string, unknown>): string | null {
  return typeof toolArgs['url'] === 'string' ? toolArgs['url'] : null;
}

/**
 * Find the first matching rule for this tool call.
 * Only rules with an explicit `tool` are considered, since this matcher is
 * used for bypass-blocking hooks on built-in tools like `web_fetch`.
 */
export function matchRule(
  toolName: string,
  toolArgs: Record<string, unknown>,
  rules: CompiledRule[],
): CompiledRule | null {
  const url = getUrl(toolArgs);
  if (!url) return null;

  for (const rule of rules) {
    if (rule.tool === toolName && rule.urlRegex.test(url)) {
      return rule;
    }
  }

  return null;
}

/**
 * Find the first matching rule by URL only.
 * Used by the plugin's registered `bastion_fetch` tool.
 */
export function matchRuleByUrl(
  toolArgs: Record<string, unknown>,
  rules: CompiledRule[],
): CompiledRule | null {
  const url = getUrl(toolArgs);
  if (!url) return null;

  for (const rule of rules) {
    if (rule.urlRegex.test(url)) {
      return rule;
    }
  }

  return null;
}

/** Resolve a dot-path like "body.amount" against an args object. */
function resolvePath(args: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = args;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Extract Bastion policy params from tool args using a ParamsMapping. */
export function extractParams(
  args: Record<string, unknown>,
  mapping: ParamsMapping,
): { amount?: number; ip?: string } {
  const result: { amount?: number; ip?: string } = {};

  if (mapping.amount !== undefined) {
    const raw = resolvePath(args, mapping.amount);
    if (typeof raw === 'number') {
      result.amount = raw;
    } else if (typeof raw === 'string') {
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) result.amount = parsed;
    }
  }

  if (mapping.ip !== undefined) {
    const raw = resolvePath(args, mapping.ip);
    if (typeof raw === 'string') {
      result.ip = raw;
    }
  }

  return result;
}
