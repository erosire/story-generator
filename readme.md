# @library/cloud Knowledge

Cloud services library — AI agent class for LLM interactions and web service abstractions.

> **Last verified:** 2026-06-19
> **Package name:** `@library/cloud`
> **Workspace dependencies:** `@presource/core`

---

## How to Update This File

1. Read `index.ts` for current exports
2. Check `agents/lightning-agent.ts` for agent API
3. Check `services/` for service classes
4. Update the "Last verified" date

---

## Index

### Agents
- [LightningAgent](#lightningagent) — Streaming LLM chat agent
- [lightningAgent](#lightningagent-1) — Factory function

### Services
- [RestService](#restservice) — Abstract REST API base class
- [WebService](#webservice) — Abstract web service (extends RestService)
- [FileService](#fileservice) — Abstract file service (extends WebService)
- [Filebin](#filebin) — Concrete Filebin implementation

---

## Agents

### LightningAgent

Streaming LLM chat agent for Anthropic Claude models via OpenAI-compatible API.

```ts
import { lightningAgent } from '@library/cloud';

const agent = lightningAgent({ key: 'api-key', model: 'claude-sonnet-4-5' });

// Build conversation
agent.system('You are a helpful assistant.');
agent.user('What is TypeScript?');

// Stream response
await agent.resolve((chunk) => process.stdout.write(chunk));

// Or use convenience method
await agent.message('Explain generics', (chunk) => console.log(chunk));

// Switch models
agent.sonnet();    // Claude Sonnet 4.5
agent.sonnet(6);   // Claude Sonnet 4.6
agent.opus();      // Claude Opus 4.6
```

**Methods:**
- `append(role, content)` — add message to memory
- `system(content)` — shorthand for `append('system', content)`
- `user(content)` — shorthand for `append('user', content)`
- `assistant(content)` — shorthand for `append('assistant', content)`
- `resolve(progressCallback?)` — stream response from API, returns `{ content, usage }`
- `message(text, callback)` — append user message + resolve
- `isProcessing(value?)` — get/set processing state (supports external abort)
- `sonnet(version?)` / `opus(version?)` — switch model

---

## Services

### RestService (abstract)

Base class for REST API services with automatic header building and JSON serialization.

```ts
class MyApi extends RestService {
    // Inherits: get, post, delete, patch, put methods
}
```

### WebService (abstract)

Extends `RestService` with an abstract `host: string` property.

### FileService (abstract)

Extends `WebService` with abstract `upload(filename, data)` and `download(input)` methods.

### Filebin

Concrete implementation for [Filebin](https://filebin.net) file hosting.

```ts
import { Filebin } from '@library/cloud';

const filebin = new Filebin({ bin: 'my-bin' });

await filebin.upload('test.txt', 'Hello World');
await filebin.download('test.txt');
const files = await filebin.list();
```

Uses a local proxy at `localhost:3000` to bypass CORS.
