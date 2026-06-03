export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Parse argv (already sliced past node + script).
 *  Convention: the CLI is command-first — `nslogger-cli <command> [positionals] [--flags]`.
 *  First non-flag token = command; remaining non-flag tokens = positionals.
 *  --key value | --key=value → string; --flag (next token is another --flag or absent) → true.
 *  A value-taking flag consumes the next token only if it does not start with `--`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (command === undefined) {
      command = tok;
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

export function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagNum(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}
