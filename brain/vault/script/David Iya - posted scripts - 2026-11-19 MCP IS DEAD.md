---
type: script
---
Type: PERSONAL. Creator: [[David Iya]].
ONSCREEN HOOK:
Cloudflare and Anthropic quietly changed how agents use MCP
    Hook 1:
Cloudflare basically killed the way most of us have been using MCP, because they fit 2,500 endpoints into about 1,000 tokens.
    Hook 2:
Forget MCP as you know it, because companies like Cloudflare and Anthropic are moving to a setup where the model writes code to call tools instead of calling them one by one.
    Body:
So the problem is really two-fold, because every MCP call has to go out and return to the model before the next one starts, and once you've connected hundreds of tools the list by itself eats most of your context. Cloudflare's fix is called Code Mode, where tools get rewritten as a TypeScript API so the model can write one small script that chains the calls in a sandbox, and only the final answer comes back. It makes sense because these models have seen way more real code than tool calls. Anthropic's version is called programmatic tool calling, which is why I think the one-call-at-a-time way of using MCP is probably on its way out.
    CTA:
So comment "CODEMODE" and I'll get you Cloudflare's write-up and how I'd think about it in Claude Code.

## Links
- [[David Iya]]
- [[David Iya - posted scripts]]
