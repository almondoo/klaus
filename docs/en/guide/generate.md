# Generating Flows from OpenAPI

`klaus generate` generates a skeleton single-step flow definition YAML for each operation (`paths` × HTTP method) in an OpenAPI 3.x definition file. When adopting klaus in an existing project, this saves you from hand-writing the initial set of files under `api/` from scratch.

Only OpenAPI 3.x input is supported (the 3.x shapes such as `requestBody` and `parameter.schema`). Passing a Swagger 2.0 definition (e.g. `in: body` parameters or the flat top-level `type` / `default` shape) fails with exit code 2 instead of generating anything — convert it to OpenAPI 3.x first.

## Usage

```
klaus generate <spec> [options]
```

| Argument / Option | Description | Default |
|---|---|---|
| `<spec>` | OpenAPI definition file (`.yaml` / `.yml` / `.json`) | required |
| `--out-dir <dir>` | Output directory | `api` |
| `--json` | Force JSON output (prints JSON even when running on a TTY) | — |

The spec is parsed with [`@apidevtools/swagger-parser`](https://apitools.dev/swagger-parser/), which resolves (dereferences) all `$ref`s before operations are walked. Specs with external URL references are supported, but a local file is the typical input.

## Generated files

One operation = one file. File name, flow name, and step name are derived as follows.

- **File name**: the kebab-cased `operationId` if present, otherwise `<method>-<slugified path>` (e.g. `GET /users/{id}` without an `operationId` becomes `get-users-id.yaml`)
- **Flow name (`name`)**: the `operationId` as-is if present, otherwise `METHOD /path` (e.g. `GET /users/{id}`)
- **Step name**: the same id used for the file name (since it's a single-step check, one file = one step)

The content is a minimal skeleton following `request` / `assert` in the [Flow Definition Reference](flow-definition.md):

- `request.method` / `request.url`: built from the spec's HTTP method and path. `url` is `{{baseUrl}}` + the spec's path (path parameters like `{id}` are left as-is, assuming a workflow where `baseUrl` comes from `environments/*.yaml`)
- `request.query`: only `in: query` parameters that have an example (checked in the order `example` / `examples` / `schema.example` / `schema.default`) are included; parameters without an example are omitted
- `request.body` / `request.headers`: if `requestBody` is present, the example from the target content type (`application/json` is preferred, otherwise the first content type) is used as `body`, and `headers.Content-Type` is set to match the spec's content type. If there's no example, a minimal placeholder is built from the schema (an object with only its `required` properties filled in, etc.). If even a placeholder can't be built, `body` is omitted
- `assert.status`: the smallest 2xx code among the defined `responses`, or `200` if none are defined

Before writing, each generated YAML is validated with klaus's own schema validation (`validateFlowYaml`); anything that fails is not written and is reported as an error instead.

Each file starts with the same `# yaml-language-server: $schema=...` comment as other generated files (see [JSON Schema](flow-definition.md#json-schema)).

**Existing files are never overwritten.** If a file with the same name already exists at the destination, it is skipped and reported as such.

## Example

Given a spec like this:

```yaml
openapi: 3.0.3
info:
  title: Sample API
  version: "1.0.0"
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, email]
              properties:
                name: { type: string }
                email: { type: string }
            example:
              name: Alice
              email: alice@example.com
      responses:
        "201":
          description: Created
```

Running `klaus generate openapi.yaml` generates `api/create-user.yaml`:

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
name: createUser
steps:
  - name: create-user
    request:
      method: POST
      url: "{{baseUrl}}/users"
      headers:
        Content-Type: application/json
      body:
        name: Alice
        email: alice@example.com
    assert:
      status: 201
```

## Generated files are a skeleton

What `klaus generate` produces is a minimal single-step check, and it's often not sufficient as-is for a real test suite. After generating, consider filling in:

- Authentication headers (e.g. `Authorization`) and any variables needed in `environments/*.yaml`
- Response content checks via `assert.body` / `assert.headers`
- Turning it into a multi-step scenario chained with `capture` (in that case, move the file to `flows/`; see the [directory convention](../dev/architecture.md))
- `request.query` / `request.body` fields that were omitted because no example was available

## Output mode and exit codes

Output mode is determined the same way as the other commands in the [CLI Reference](cli.md) (text on a TTY, JSON when non-TTY or `--json` is given).

### JSON output

```jsonc
{
  "version": 1,
  "generated": ["api/create-user.yaml"],
  "skipped": [],
  "errors": []
}
```

`errors[]` holds entries for generated content that failed klaus's own schema validation (each with `path` and `message`). This shouldn't happen for a well-formed spec, but if it does, that one file is simply not written.

### Exit codes

| code | meaning |
|---|---|
| 0 | all operations generated successfully (including when everything was skipped) |
| 1 | general error (invalid CLI arguments, unexpected exception) |
| 2 | the spec is invalid (parsing or `$ref` resolution failed), or a generated file failed schema validation |

When the spec is invalid, text mode writes only to stderr (nothing is printed to stdout). With `--json`, or when stdout is non-TTY (pipes, agent execution, CI), a JSON error report containing `errors` is written to stdout instead.
