# model component

## Scope

Owns the Genome's default model selection, its model cycle list, and model
request options. The CLI's `--profile` and `--model` are temporary overrides for
one launch and never modify the component file.

## Config

- `model.profile`, `model.id`: the default provider and model.
- `model.cycle`: projected onto Pi's `enabledModels` (the Ctrl+P cycle list).
  Globs such as `anthropic/*` are supported.
- `model_options.max_tokens`, `temperature`: applied to native Pi providers
  through `before_provider_request` -- **they only overwrite fields already
  present in the request body**, so a provider that does not support the
  parameter never receives an invalid field.
- `model_options.extra_body`: use this when a field has to be added rather than
  overwritten; it is merged into the request body as-is.
- `model_options.chat_template_kwargs`: applies only to RSIH's custom providers
  (`--config`).

## Allowed operations

`set_model`, `set_model_options`

## Contract

The model must exist in the current `~/.rsih/models.json` or in an explicit
provider config. Output budget, temperature and provider-specific parameters
must stay within what the provider supports. Never write an API key into a
Genome. Before changing `extra_body`, confirm the target provider accepts the
field.
