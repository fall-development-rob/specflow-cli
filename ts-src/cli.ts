/**
 * Specflow CLI entry point.
 * Routes commands to their handlers.
 */

const pkg = require('../package.json');

const args = process.argv.slice(2);
const command = args[0];
const restArgs = args.slice(1);

// Parse flags
function hasFlag(flag: string): boolean {
  return restArgs.includes(flag);
}

function getFlagValue(flag: string): string | undefined {
  const idx = restArgs.indexOf(flag);
  if (idx !== -1 && idx + 1 < restArgs.length) {
    return restArgs[idx + 1];
  }
  return undefined;
}

function getPositional(): string | undefined {
  return restArgs.find(a => !a.startsWith('-'));
}

// Version
if (command === '--version' || command === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

// Help
if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(`
Specflow v${pkg.version} -- Specs that enforce themselves.

Usage: specflow <command> [options]

Commands:
  init [dir] [-y|--yes] [--json]      Initialize Specflow in a project
                                       [--contracts-dir] [--tests-dir]
                                       [--skip-contracts]
  generate [dir] [--json]             Re-detect stack and generate contracts
                 [--contracts-dir]
  doctor [dir] [--json] [--fix]       Run health checks
  enforce [dir] [--json] [--contract] Enforce contracts against files
                [--staged] [--diff <branch>]
                [--suggest]
  update [dir] [--ci]                 Update hooks and settings
  status [dir] [--json] [--history]    Show compliance dashboard
                                       [--since <date>]
  impact <contract-id> [--json]       Analyze contract change impact
  compile <csv-file>                  Compile journey contracts
  audit <issue-number>                Audit an issue for compliance
  graph [contracts-dir]               Validate contract graph
  contract list                        List available contract templates
  contract create [--template <name>] Create contract from template
                  [--ai "desc"]       Create contract via Claude CLI
                  [--yes]             Skip interactive prompts
  agent list [--category] [--json]    List agents
  agent show <name>                   Show agent details
  agent search <query> [--json]       Search agents
  hook post-build                     Post-build hook handler
  hook compliance                     Compliance hook handler
  hook journey                        Journey test hook handler
  mcp start                           Start MCP stdio server
  mcp register                        Register with Claude Code
  mcp unregister                      Unregister from Claude Code

Examples:
  specflow init .
  specflow doctor
  specflow enforce --json
  specflow contract list
  specflow contract create --template no-console-log
  specflow audit 500
  specflow agent list
`);
  process.exit(0);
}

// Route commands
async function main() {
  switch (command) {
    case 'init': {
      const { run } = require('./commands/init');
      await run({
        dir: getPositional(),
        yes: hasFlag('--yes') || hasFlag('-y'),
        json: hasFlag('--json'),
        contractsDir: getFlagValue('--contracts-dir'),
        testsDir: getFlagValue('--tests-dir'),
        skipContracts: hasFlag('--skip-contracts'),
      });
      break;
    }

    case 'generate': {
      const { run: generateRun } = require('./commands/generate');
      await generateRun({
        dir: getPositional(),
        json: hasFlag('--json'),
        contractsDir: getFlagValue('--contracts-dir'),
      });
      break;
    }

    case 'contract': {
      const contract = require('./commands/contract');
      const subcommand = restArgs[0];

      if (!subcommand || subcommand === 'list') {
        contract.list();
      } else if (subcommand === 'create') {
        const subArgs = restArgs.slice(1);
        const descParts = subArgs.filter((a: string) => !a.startsWith('-'));
        await contract.create({
          template: getFlagValue('--template'),
          ai: hasFlag('--ai'),
          description: descParts.join(' ') || getFlagValue('--ai'),
          yes: hasFlag('--yes') || hasFlag('-y'),
          dir: getFlagValue('--dir'),
        });
      } else {
        console.error(`Unknown contract subcommand: ${subcommand}`);
        process.exit(1);
      }
      break;
    }

    case 'doctor': {
      const { run } = require('./commands/doctor');
      await run({
        dir: getPositional(),
        json: hasFlag('--json'),
        fix: hasFlag('--fix'),
      });
      break;
    }

    case 'enforce': {
      const { run } = require('./commands/enforce');
      await run({
        dir: getPositional(),
        json: hasFlag('--json'),
        contract: getFlagValue('--contract'),
        staged: hasFlag('--staged'),
        diff: getFlagValue('--diff'),
        suggest: hasFlag('--suggest'),
      });
      break;
    }

    case 'update': {
      const { run } = require('./commands/update');
      await run({
        dir: getPositional(),
        ci: hasFlag('--ci'),
      });
      break;
    }

    case 'status': {
      const { run } = require('./commands/status');
      await run({
        dir: getPositional(),
        json: hasFlag('--json'),
        history: hasFlag('--history'),
        since: getFlagValue('--since'),
      });
      break;
    }

    case 'impact': {
      const { run } = require('./commands/impact');
      await run({
        contractId: getPositional() || '',
        dir: getFlagValue('--dir'),
        json: hasFlag('--json'),
      });
      break;
    }

    case 'compile': {
      const { run } = require('./commands/compile');
      await run({ args: restArgs });
      break;
    }

    case 'audit': {
      const { run } = require('./commands/audit');
      await run({ issue: restArgs[0] || '' });
      break;
    }

    case 'graph': {
      const { run } = require('./commands/graph');
      await run({ dir: getPositional() });
      break;
    }

    case 'agent': {
      const agent = require('./commands/agent');
      const subcommand = restArgs[0];
      const subArgs = restArgs.slice(1);

      // Determine agents directory
      const agentsDir = 'agents';

      if (!subcommand || subcommand === 'list') {
        agent.list(agentsDir, {
          category: getFlagValue('--category') || subArgs.find((a: string) => !a.startsWith('-')),
          json: hasFlag('--json'),
        });
      } else if (subcommand === 'show') {
        agent.show(agentsDir, { name: subArgs[0] || '' });
      } else if (subcommand === 'search') {
        agent.search(agentsDir, {
          query: subArgs.filter((a: string) => !a.startsWith('-')).join(' '),
          json: hasFlag('--json'),
        });
      } else {
        console.error(`Unknown agent subcommand: ${subcommand}`);
        process.exit(1);
      }
      break;
    }

    case 'hook': {
      const subcommand = restArgs[0];
      if (subcommand === 'post-build') {
        require('./hooks/post-build-check');
      } else if (subcommand === 'compliance') {
        require('./hooks/check-compliance');
      } else if (subcommand === 'journey') {
        require('./hooks/run-journey-tests');
      } else {
        console.error(`Unknown hook: ${subcommand}`);
        process.exit(1);
      }
      break;
    }

    case 'mcp': {
      const subcommand = restArgs[0];
      const { run: mcpRun, register, unregister } = require('./mcp/server');

      if (subcommand === 'start') {
        mcpRun();
      } else if (subcommand === 'register') {
        register();
      } else if (subcommand === 'unregister') {
        unregister();
      } else {
        console.error(`Unknown mcp subcommand: ${subcommand}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run specflow help for available commands.');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
