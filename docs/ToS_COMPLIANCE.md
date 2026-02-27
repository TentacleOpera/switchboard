# Why Switchboard Does Not Trigger Google's Proxy Ban

> **Context:** In February 2026, Google mass-banned developers who used tools like OpenCode and OpenClaw to route their Antigravity subscription tokens into third-party CLI environments. Switchboard is also designed to let you work across multiple AI subscriptions to stretch your budget — but it achieves this in a fundamentally different way. This document explains why that difference matters.

---

## The Goal Is the Same. The Method Is Not.

Switchboard and the banned proxy tools share a similar *goal*: get more AI work done for less money by routing tasks to cheaper models where appropriate. The critical difference is *how* they do it.

| | OpenCode + Proxy Tools | Switchboard |
|:---|:---:|:---:|
| **Method** | Steal Antigravity OAuth tokens; inject into a third-party CLI | Route work to CLI agents running under *their own* subscriptions |
| **Billing** | Forces Google to serve unmetered enterprise-scale compute under a $250/month consumer plan | Each agent bills against its own service (Copilot, Qwen, etc.) |
| **Token extraction** | Yes — intercepted private session tokens | No — never touches any credentials |
| **Headless API loops** | Yes — machine-speed autonomous loops bypass rate limits | No — work is dispatched by the human; each CLI agent runs normally |
| **Multi-account rotation** | Yes — cycled accounts to evade quota limits | No — no concept of account management or quota manipulation |
| **ToS compliance** | Violated multiple Google ToS clauses | Each tool used under its own ToS with its own keys |

---

## The Five Specific Behaviors That Got People Banned

The research behind the February 2026 ban wave identifies five concrete technical behaviors that triggered enforcement. Here is how Switchboard compares on each.

---

### 1. OAuth Token Extraction

**What the proxies did:** Intercepted the Antigravity IDE's private OAuth session tokens and injected them into OpenCode/OpenClaw. This is what Google called "reverse engineering the authentication flow" and a direct violation of the Generative AI Additional Terms.

**Switchboard:** Has no credential extraction logic whatsoever. It runs inside the VS Code extension host — the same IDE Google intends you to use. It never reads, stores, forwards, or intercepts any Antigravity authentication tokens.

---

### 2. Routing Tokens to Non-Google Products

**What the proxies did:** Google's Antigravity ToS explicitly prohibits using the service "in connection with products not provided by us." The proxies routed stolen Antigravity tokens directly into OpenCode and OpenClaw.

**Switchboard:** Does not route Antigravity tokens anywhere. The CLI agents you set up (Copilot, Qwen, Codex, etc.) authenticate against their own services using their own keys. Switchboard simply sends them text instructions via the VS Code terminal API — the same as typing in a terminal yourself. Each subscription is used exactly as intended.

---

### 3. Headless Machine-Speed API Loops

**What the proxies did:** Removed the human-paced IDE interface entirely. Automated agents ran continuous loops at machine speed — one developer's laptop could generate millions of tokens of compute per hour under a flat subscription. This is what made the traffic economically unsustainable and behaviorally indistinguishable from a DDoS attack in Google's telemetry.

**Switchboard:** Does not make AI API calls. The plugin itself sends text to VS Code terminals (`terminal.sendText`) and writes JSON coordination files to `.switchboard/inbox/`. When the Lead Coder terminal receives a plan and processes it, that's Copilot processing a prompt against Copilot's own API under Copilot's own rate limits — exactly as if you had pasted it in yourself.

---

### 4. Multi-Account Rotation and Quota Exploitation

**What the proxies did:** Supported concurrent multi-account configuration, automatically cycling to the next account on rate-limit hits, and routing between the Antigravity quota pool and the Gemini CLI quota pool to double the available compute ceiling.

**Switchboard:** The concept does not exist in the codebase. Switchboard manages agent *roles* (Planner, Lead Coder, Reviewer, etc.) and enforces **cooldown locks** between dispatches to *reduce* message frequency. There is no account management, no quota tracking, no rate-limit evasion. Dispatch guards exist to protect human workflow pacing, not to maximize throughput.

---

### 5. Stripping IDE Telemetry

**What the proxies did:** Third-party CLI tools strip the UI context and telemetry hooks that the Antigravity IDE attaches to sessions, depriving Google of training data it explicitly states it collects under its terms. This was a secondary enforcement motive alongside compute protection.

**Switchboard:** Does not intercept or modify the data stream between the Antigravity IDE and Google's backend. All AI interactions happen inside the standard, unmodified IDE session. Switchboard's own observability is strictly local: audit events are written to `.switchboard/sessions/activity.jsonl` on your machine. Nothing is transmitted externally.

---

## The Legitimate Arbitrage Model

Here is the economic model Switchboard actually uses, as described in the release post:

> *"This is how I'm using this plugin, which is giving me hours of Opus coding for just $20 Google Pro + $10 Copilot."*

The savings come from **routing work to the right model for the job**:

- Draft and refine plans in Antigravity using Flash (fast, cheap quota usage)
- Send implementation work to Copilot CLI — per-prompt pricing with no token ceiling per prompt
- Use cheaper open models (Qwen, Gemini Flash CLI, GLM) for boilerplate and review

This is not arbitrage against Google's quota system. It is standard multi-provider workflow optimization, where each provider is paid for what it does. The money saved comes from using the *right tool for the job*, not from forcing one provider to absorb another provider's costs.

---

## Summary

The proxy tools that caused the ban wave were credential theft operations that transformed a consumer subscription into an unmetered enterprise API endpoint. Switchboard is a coordination layer that helps you direct work to whichever AI tool in your toolkit is most appropriate for each task — all under each tool's own subscription, ToS, and billing.

Using Switchboard is not ToS-adjacent. It is structurally equivalent to a developer who opens Antigravity for planning, switches to a Copilot terminal for implementation, and pastes their plan in — except Switchboard automates the pasting.
