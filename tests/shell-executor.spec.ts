import { describe, expect, it } from 'vitest';

import { ShellExecutionError, ShellExecutor } from '../src/tools/shell-executor.js';

describe('ShellExecutor', () => {
  it('passes argv items as plain arguments without shell expansion', async () => {
    const executor = new ShellExecutor();
    const result = await executor.run(process.execPath, [
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1)))',
      'alpha; rm -rf /',
    ]);

    expect(JSON.parse(result.stdout.trim())).toContain('alpha; rm -rf /');
  });

  it('can execute a shell command line when explicitly requested', async () => {
    const executor = new ShellExecutor();
    const result = await executor.runCommandLine('printf "alpha\\nbeta\\n" | head -n 1');

    expect(result.stdout.trim()).toBe('alpha');
  });

  it('surfaces stdout and stderr on execution failure', async () => {
    const executor = new ShellExecutor();

    await expect(
      executor.run(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(2);']),
    ).rejects.toEqual(expect.objectContaining({
      name: ShellExecutionError.name,
      stderr: 'bad',
    }));
  });
});