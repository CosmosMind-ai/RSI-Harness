# Sem and Weave Genome

An opt-in local coding toolkit: `sem_find` locates source entities, `weave_edit`
edits them, and `weave_preview` previews a merge of two branches without writing it.
Uses RSIH's existing stdio MCP runtime; no model or built-in tools are replaced.

Install [Sem](https://github.com/Ataraxy-Labs/sem) and
[Weave](https://github.com/Ataraxy-Labs/weave) first. The executables `sem` and
`weave-mcp` must be on the PATH of the process launching RSIH. From this clone:

```bash
rsih genome validate examples/genomes/sem-weave
rsih genome install examples/genomes/sem-weave
cd /path/to/your/git-checkout
rsih :sem-weave -p "Use sem_find to locate a function by name and report its source location. Do not edit anything."
```

Both subprocesses use the session working directory as their repository. Launch
from the intended checkout root. The bundle installs no binaries and downloads
nothing itself. Source returned by tools reaches the configured model provider.
Sem may create local indexes/cache data; its local/no-network controls are not
an OS sandbox. Run only against repositories the configured provider may process.

Selecting this Genome exposes editing capability: `weave_edit` writes files and
its optional `then` argument can run a shell command. Tool allowlisting does not
remove those arguments or sandbox the subprocess. Use an isolated checkout and
review changes/tests before committing. For discovery only, remove the `weave`
server from your own copy before installing it. No tool is called at installation.

Try an edit on a disposable branch by asking for a small change to a known
function, then inspect `git diff` and run the repository's tests. Structural edits
are not proof that behavior is correct. `weave_preview` is a merge preview, not
an edit preview; `weave_edit` accepts `dry_run: true` for the latter.

Only the integrations component is declared. To combine with another Genome,
create a bundle containing all intended servers. To stop using it, start with
`rsih --genome default`; resumed sessions may restore their previous Genome.
