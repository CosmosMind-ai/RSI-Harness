# deed.page Genome

Adds opt-in publishing of static pages (an HTML report, a demo, an experiment
summary) to a public `https://<slug>.deed.page/` URL through the keyless
[deed.page](https://deed.page) MCP endpoint. It uses RSIH's stdio MCP
integration with [`mcp-remote`](https://github.com/geelen/mcp-remote) as the
HTTP bridge, the same way as the `parallel-search` Genome.

From a clone of RSI-Harness, with RSIH installed and Node 22.19+ and `npx`
on your PATH:

```bash
rsih genome validate examples/genomes/deed-page
rsih genome install examples/genomes/deed-page
rsih :deed-page -p "Write a one-page HTML summary of this repository's README and publish it with deedpage_publish_site using ttl_seconds 3600. Reply with the URL."
```

The selected Genome exposes `deedpage_publish_site`, `deedpage_get_site` and
`deedpage_delete_site`. No deed.page account or API key is required. Your
existing model still needs its usual configuration and credentials. The first
launch downloads the pinned `mcp-remote@0.14.3` package with `npx -y`;
subsequent launches use the npm cache. Network access is required for both npm
and `https://deed.page/mcp`. The bridge uses HTTP transport and identifies
requests as `rsih/0.1.0`.

The first publish returns the page URL and an owner token (`deed_tok_...`).
The token is the only way to update or delete that page, and it appears in the
session transcript; keep it if you want to remove the page later with
`deedpage_delete_site`. Pass `ttl_seconds` to make a page expire on its own.

Only the integrations component is declared, with `base: "default"`. Model
selection, Pi's prompt, built-in tools, settings, and resource discovery inherit
existing behavior. Launching `rsih` without this Genome does not enable the
server. RSIH can restore the Genome when resuming a session that used it;
select `--genome default` explicitly to use the default Genome on that session.

Published pages are public: anyone with the URL can open them, so never
publish secrets, credentials or private data. Page contents are sent to
deed.page. To stop using this integration, launch a new session without the
Genome or select `--genome default`. This bundle neither modifies nor extends
another Genome's MCP server list; to combine integrations, create your own
Genome with all the servers you intend to enable.

Docs: https://deed.page/docs
