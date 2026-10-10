# Parallel Search Genome

Adds opt-in web search and page retrieval through the free, keyless
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
endpoint. It uses RSIH's stdio MCP integration with
[`mcp-remote`](https://github.com/geelen/mcp-remote) as the HTTP bridge.

From a clone of RSI-Harness, with RSIH installed and Node 22.19+ and `npx`
on your PATH:

```bash
rsih genome validate examples/genomes/parallel-search
rsih genome install examples/genomes/parallel-search
rsih :parallel-search -p "Search the web for the Node.js release schedule, fetch the official page, and summarize it with source URLs."
```

The selected Genome exposes `parallel_web_search` and `parallel_web_fetch`.
No Parallel API key or login is required. Your existing model still needs its
usual configuration and credentials. The first launch downloads the pinned
`mcp-remote@0.14.3` package with `npx -y`; subsequent launches use the npm cache.
Network access is required for both npm and `https://search.parallel.ai/mcp`.
The bridge uses HTTP transport and identifies requests as `rsih/0.1.0`.

Only the integrations component is declared, with `base: "default"`. Model
selection, Pi's prompt, built-in tools, settings, and resource discovery inherit
existing behavior. Launching `rsih` without this Genome does not enable these
servers. RSIH can restore the Genome when resuming a session that used it;
select `--genome default` explicitly to use the default Genome on that session.

Search queries and requested page URLs are sent to Parallel. Do not include
private content in queries. Treat retrieved pages as untrusted source material.
To stop using this integration, launch a new session without the Genome or
select `--genome default`. This bundle neither modifies nor extends another
Genome's MCP server list; to combine integrations, create your own Genome with
all the servers you intend to enable.
