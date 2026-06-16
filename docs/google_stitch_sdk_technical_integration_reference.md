# Google Stitch SDK Technical Integration Reference

This technical reference document covers the public API surface, architecture, configuration options, and integration patterns for the Google Stitch SDK (`@google/stitch-sdk`). It is intended for software engineers integrating the SDK into VS Code extensions, custom Model Context Protocol (MCP) servers, or Node.js backend services.

---

## Executive Summary

The Google Stitch SDK is a TypeScript/JavaScript developer library designed to programmatically generate, edit, and manage high-fidelity UI screens and design systems. Operating on top of the Model Context Protocol (MCP), the SDK exposes both a high-level domain-driven API (structured around projects, screens, and design systems) and a low-level client for raw tool execution and agentic orchestration. 

The SDK's primary output consists of functional HTML/CSS templates and accompanying high-resolution screenshots. It is designed to act as a design-to-code bridge, feeding visual references and structural layouts directly into AI coding agents like Claude Code, Cursor, or Gemini CLI.

---

## Complete API Reference

The SDK's public API surface is tiered, exposing high-level domain classes, direct tool clients, and specialized integration utilities for modern agentic frameworks.

```
           +---------------------------------------------+
           |       stitch (Global Singleton / Class)     |
           +----------------------+----------------------+
                                  |
         +------------------------+------------------------+
         |                                                 |
         v                                                 v
+------------------+                              +-----------------------+
| Project Instance |                              |   StitchToolClient    |
+--------+---------+                              +-----------+-----------+
         |                                                    |
         +--------------------+                               v
         |                    |                       [Direct MCP Tool]
         v                    v                       (callTool/listTools)
+-----------------+  +-----------------+                      |
| Screen Instance |  |  DesignSystem   |                      v
+-----------------+  +-----------------+             +------------------+
                                                     |   StitchProxy    |
                                                     +------------------+
```

---

### 1. Top-Level `stitch` Object

The primary entry point is the `stitch` singleton, a pre-configured instance of the `Stitch` class. It lazily initializes on its first method call and reads authentication credentials directly from the environment.

#### Imports
```typescript
import { stitch, Stitch } from "@google/stitch-sdk";
```

#### API Methods
*   **`createProject(title?: string): Promise<Project>`**  
    Creates a new design project container within the Stitch platform.
    *   *Parameters:* `title` (Optional string to name the project)
    *   *Returns:* A `Promise` resolving to a `Project` instance.
*   **`projects(): Promise<Project[]>`**  
    Lists all projects accessible under the active credentials.
    *   *Returns:* A `Promise` resolving to an array of `Project` instances.
*   **`project(id: string): Project`**  
    Instantly returns a local reference to a `Project` with the given ID.
    *   *Parameters:* `id` (The bare project ID string, excluding any `projects/` prefix)
    *   *Returns:* A synchronous `Project` instance. *Note: This method makes no immediate network call; it lazily executes requests when subsequent methods are triggered.*

---

### 2. Project Instance

The `Project` instance acts as the parent container for screens and visual styles.

#### Properties
*   **`id: string`**: An alias for the underlying `projectId`.
*   **`projectId: string`**: The bare identifier of the project (e.g., `"4044680601076201931"`).

#### Methods
*   **`generate(prompt: string, deviceType?: DeviceType): Promise<Screen>`**  
    Generates a new UI screen based on a natural language text prompt.
    *   *Parameters:*
        *   `prompt` (Required string describing the visual UI layout, actions, and theme)
        *   `deviceType` (Optional enum representing target layout boundaries: `"MOBILE" | "DESKTOP" | "TABLET" | "AGNOSTIC"`).
    *   *Returns:* `Promise<Screen>`.
*   **`screens(): Promise<Screen[]>`**  
    Retrieves all visual screen instances contained inside the project.
    *   *Returns:* `Promise<Screen[]>`.
*   **`getScreen(screenId: string): Promise<Screen>`**  
    Fetches details of a specific screen by its identifier.
    *   *Parameters:* `screenId` (The bare ID string of the target screen)
    *   *Returns:* `Promise<Screen>`.
*   **`createDesignSystem(designSystem: object): Promise<DesignSystem>`**  
    Registers a new visual theme or brand system for the project.
    *   *Parameters:* `designSystem` (An object outlining color modes, typography, and primary styling parameters).
    *   *Returns:* `Promise<DesignSystem>`.
*   **`listDesignSystems(): Promise<DesignSystem[]>`**  
    Lists all visual brand definitions registered within the project.
    *   *Returns:* `Promise<DesignSystem[]>`.
*   **`designSystem(id: string): DesignSystem`**  
    Synchronously references an existing project design system by ID without an initial network round trip.
    *   *Returns:* `DesignSystem`.
*   **`upload(imageBuffer: Buffer, options?: any): Promise<any>`**  
    Unified method supporting the upload of physical assets (e.g., wireframe sketches or reference screenshots) for image-to-UI generation pipelines. Added in version `0.3.0`.

---

### 3. Screen Instance

The `Screen` instance represents a single visual UI canvas generated by Stitch.

#### Properties
*   **`id: string`**: Alias for `screenId`.
*   **`screenId: string`**: The bare unique identifier of the screen.
*   **`projectId: string`**: The parent project's identifier.

#### Methods
*   **`getHtml(): Promise<string>`**  
    Retrieves the asset path for the screen's visual layout.
    *   *Returns:* `Promise<string>` resolving to a **temporary download URL** hosting the generated static HTML (incorporating inline styles or CSS). *The SDK does not return raw code strings directly; developers must fetch the URL contents programmatically.*
*   **`getImage(): Promise<string>`**  
    Retrieves the asset path for the visual preview.
    *   *Returns:* `Promise<string>` resolving to a **download URL** pointing to the screenshot PNG.
*   **`edit(prompt: string, deviceType?: DeviceType, modelId?: string): Promise<Screen>`**  
    Modifies the existing screen iteratively using natural language prompts.
    *   *Parameters:*
        *   `prompt` (Required edit instructions, e.g., `"change background to dark gray and add a logout button"`)
        *   `deviceType` (Optional `"MOBILE" | "DESKTOP" | "TABLET" | "AGNOSTIC"`)
        *   `modelId` (Optional string representing model routing, e.g., `"GEMINI_3_PRO" | "GEMINI_3_FLASH"`).
    *   *Returns:* `Promise<Screen>` representing the newly generated iteration.
*   **`variants(prompt: string, variantOptions: VariantOptions, deviceType?: DeviceType, modelId?: string): Promise<Screen[]>`**  
    Generates a batch of design alternatives exploring varied styling options.
    *   *Parameters:*
        *   `prompt` (Required description of the variations, e.g., `"try multiple pastel colors"`)
        *   `variantOptions` (Structured configuration object for variance control):
            *   `variantCount: number` (Integer between 1 and 5)
            *   `creativeRange: "REFINE" | "EXPLORE" | "REIMAGINE"`
            *   `aspects?: Array<"LAYOUT" | "COLOR_SCHEME" | "IMAGES" | "TEXT_FONT" | "TEXT_CONTENT">`
    *   *Returns:* `Promise<Screen[]>` containing the alternative designs.

---

### 4. DesignSystem Instance

The `DesignSystem` class represents a cohesive visual theme applied to projects and screens.

#### Properties
*   **`id: string`**: Alias for `assetId`.
*   **`assetId: string`**: Bare design system identifier.
*   **`projectId: string`**: Associated parent project ID.

#### Methods
*   **`update(designSystem: object): Promise<DesignSystem>`**  
    Overwrites or amends the active properties of the visual system.
    *   *Parameters:* `designSystem` (An object implementing the design theme structure).
*   **`apply(selectedScreenInstances: Array<{ id: string; sourceScreen: string }>): Promise<Screen[]>`**  
    Applies the theme rules across a batch of project screen instances.
    *   *Parameters:* `selectedScreenInstances` (Array of objects specifying screen ID and parent resource path, retrievable from `project.data.screenInstances`).
    *   *Returns:* `Promise<Screen[]>`.

---

### 5. Low-Level Agent Tools

To integrate directly with custom AI agents and orchestrators, the SDK exports a dedicated, low-level MCP tool client.

```typescript
import { StitchToolClient, StitchProxy, stitchTools } from "@google/stitch-sdk";
```

#### `StitchToolClient`
A lower-level client that provides direct access to registered MCP tools.
*   **Constructor:** `new StitchToolClient(config: StitchToolConfig)`
*   **Methods:**
    *   `listTools(): Promise<{ tools: ToolDefinition[] }>`: Synchronously or asynchronously lists available MCP capabilities.
    *   `callTool<T = any>(name: string, arguments: object): Promise<T>`: Directly invokes an MCP tool (e.g., `"create_project"`, `"generate_screen_from_text"`) with strongly typed response assertions.
    *   `close(): Promise<void>`: Closes active client connections.

#### `StitchProxy`
An in-process proxy server forwarding requests directly to Stitch, allowing developers to expose Stitch tools over a local MCP server.
*   **Constructor:** `new StitchProxy(config: StitchProxyConfig)`
*   **Methods:**
    *   `start(transport: StdioServerTransport): Promise<void>`: Mounts and runs the proxy over standard I/O streams.

#### `stitchTools()`
Exposes Stitch tools directly formatted as Vercel AI SDK compatible tool structures.
*   *Usage:*
    ```typescript
    import { generateText } from "ai";
    import { stitchTools } from "@google/stitch-sdk/ai";

    const response = await generateText({
      model: yourModel,
      tools: stitchTools(), // Exposes all Stitch MCP capabilities as tools
      prompt: "Create a modern checkout form with responsive layout"
    });
    ```

---

## Capabilities Confirmed vs Claimed Impossible

A comparison of what development agents or unverified community sources claim the SDK cannot do versus its actual supported capabilities:

| Core Integration Category | Claimed Impossible / Misconceptions | Actual Supported Behavior |
| :--- | :--- | :--- |
| **Raw Buffer Manipulation** | The Screen instance has helper methods like `getRawHtml()` or `getRawImageBuffer()` to return raw strings or file buffers directly. | **No direct buffer access.** Both `getHtml()` and `getImage()` only return temporary download URLs. The developer must fetch the files manually via HTTP. |
| **Interactive Screen Edits** | Generative AI only supports full text-to-image screen creation from scratch; modifying layouts iteratively requires generating entirely new projects. | **Full iterative refinement.** `Screen.edit()` performs targeted modifications on existing frames, and `Screen.variants()` generates parallel aesthetic branches. |
| **OAuth and Multi-Tenant Auth** | Authentication is strictly limited to the `STITCH_API_KEY` variable, making multi-user/cloud platform integration impossible. | **Dual Authentication support.** The client accepts `accessToken` (OAuth) coupled with a Google Cloud `projectId` to safely run inside managed user scopes. |
| **Design Tokens Enforcement** | Stitch only outputs unstructured CSS mockups with arbitrary layouts, offering no support for structured design rules. | **Structured branding rules.** The SDK supports writing visual token themes via `createDesignSystem()` and exporting/syncing them via `DESIGN.md` representations. |
| **Direct Agent Tool Injection** | Writing custom tool wrappers and JSON validation schemas is required to pass Stitch commands to coding agents (e.g., Claude Code, ADK). | **Native engine compatibility.** The SDK ships pre-configured, type-safe bindings out of the box: `stitchTools` (for Vercel AI SDK) and `stitchAdkTools` (for Google's Agent Development Kit). |

---

## Trade-offs and Limitations

When building production tools or VS Code extension integrations, the following platform mechanics must be accounted for:

### 1. High Generation Latency
The visual screen creation pipeline (`generate`, `edit`, `variants`) runs through complex layout validation and multi-modal image rendering under the hood. A single call typically takes **10 to 20 seconds** to resolve. When running inside an IDE extension, callers should implement background workers and visual progress indicators to keep user experiences responsive.

### 2. Secondary Fetch Overheads
The URLs returned by `getHtml()` and `getImage()` point to secure Google storage buckets. Callers must execute a secondary network round trip to pull down the final markup or raw image files. In addition, these temporary URLs can expire, meaning the content should be fetched and cached locally immediately upon generation.

### 3. Lack of Native Progress Hooks
The high-level SDK is completely synchronous-by-promise and does not expose EventEmitters, callback protocols, or WebSocket progress channels. You cannot monitor real-time completion percentages (e.g., "50% rendered") on active generation calls; developers must handle timeouts gracefully (the default client timeout is **300,000 ms / 5 minutes**).

### 4. Scan-Based Projections
Historically, immediate listing calls directly following generation suffered from synchronization lag (e.g., `project.screens()` returning empty until the dashboard was accessed on the web UI). While version `0.1.1` mitigated this by transitioning to dynamic scans of generated component outputs rather than hardcoded array indices, developers should still account for potential transient latency in immediate sequential project listings.

---

## Glossary

*   **MCP (Model Context Protocol)**: An open standard specification enabling AI models and coding agents to safely read and write to local developer systems and third-party tools.
*   **ADK (Agent Development Kit)**: Google's developer toolkit designed to establish structured, type-safe workflows for autonomous AI agents.
*   **Fife Suffix**: A specialized suffix configuration parameter (`buildFifeSuffix`) used to dynamically append resolution, size, and cropping rules to image server asset requests.
*   **DESIGN.md**: A structured markdown standard for documenting visual identity specifications (color schemes, layout patterns, and typography) so that AI models can enforce styling consistency.
*   **creativeRange**: An option regulating how widely Stitch's generation engine should deviate from the seed interface layout when producing screen alternatives.

---

## Sources

1. **`@google/stitch-sdk` NPM Package Details**
   * *URL:* `https://www.npmjs.com/package/@google/stitch-sdk`
   * *Publication Date:* May 12, 2026
   * *Credibility Tier:* Tier 1 (Primary registry source)

2. **Official Google Labs Stitch SDK Repository & README**
   * *URL:* `https://github.com/google-labs-code/stitch-sdk`
   * *Publication Date:* June 2026 (Active/latest main branch)
   * *Credibility Tier:* Tier 1 (Official source code and documentation)

3. **Google Labs Stitch SDK Version 0.1.1 Release Notes**
   * *URL:* `https://github.com/google-labs-code/stitch-sdk/releases/tag/v0.1.1`
   * *Publication Date:* April 23, 2026
   * *Credibility Tier:* Tier 1 (Official releases ledger)

4. **Stitch Tool Schema Configuration Constraints Evaluation**
   * *URL:* `https://github.com/gemini-cli-extensions/stitch/issues/12`
   * *Publication Date:* May 20, 2026
   * *Credibility Tier:* Tier 2 (Developer community bug evaluation)

5. **Design Loop & Stitch Autonomous Agent Integration Spec**
   * *URL:* `https://github.com/claude-skills/plugins/frontend/skills/design-loop/SKILL.md`
   * *Publication Date:* May 2026
   * *Credibility Tier:* Tier 2 (Public multi-agent skill implementation guide)