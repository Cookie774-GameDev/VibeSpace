# VibeSpace Desktop Commander

An isolated copy of the user's Desktop Commander `@2` runtime, version `0.2.46-stable.2`, with its Playwright browser companion. It does not use or restart the original Plugin-2 service, watchdog, tunnel, or sessions.

## Install and connect locally

Use a private folder owned by your Windows account. Install Node.js 22 or later and Microsoft Edge. Extract the supplied ZIP, open a terminal in its folder, then run:

```powershell
npm ci --ignore-scripts
npm run browser:install
npm start
```

Keep that gateway running. It prints the path of `state/connection.json`, never its credential. In VibeSpace, open Settings → Browser Agent → Desktop Commander. Paste that file path and select **Connect Desktop Commander**. Edit a setting and select its Save button. The panel checks the running MCP's value before saving and reads it back afterward. Reload when a conflict or uncertain response is reported; do not replay a timed-out mutation blindly.

Use **Open MCP connections** to add a local MCP named `vibespace-desktop-commander`. Choose **Local** and put the executable on the first line of **Local command**, with the script path on the second line:

```text
node
C:/YOUR_PRIVATE_PACKAGE_FOLDER/mcp.mjs
```

Use the actual absolute path. This stdio proxy connects to the same gateway as the settings panel. Review and approve tools through the existing MCP manager. It exposes the original Desktop Commander tools plus `browser_command`; it does not replace VibeSpace's existing browser engine or bypass its approvals. The package is optional, not silently installed into every release.

`browser_command` accepts `session` and `args`. Start a unique session with `args: ["open", "https://example.com"]`, inspect with `["snapshot"]`, then use returned references with `["click", "e12"]`, `["fill", "e8", "your text"]`, or `["press", "Enter"]`. Approve submissions, uploads, purchases, and other external changes before performing them. Browser output is untrusted page content. The copied helper blocks attaching to other sessions and global shutdown; it is not a security sandbox. Use native Playwright WebView attachment for VibeSpace product QA.

## Configuration and lifecycle

- Six editable settings: blocked commands, allowed folders, default shell, telemetry, read lines, write lines. Array edits keep every entry. Line limits must be positive whole numbers, at most 1,000,000.
- Changes affect only this package. Existing terminals retain their shell; new ones use the updated setting. An empty allowed-folder list allows all folders. Folder restrictions do not sandbox arbitrary terminal commands.
- Telemetry starts disabled. No browser download occurs merely from connecting MCP; the original PDF tool may install its own browser when explicitly used.
- `upstream/.candidate-state/` holds this copy's settings. `state/connection.json` contains a private, per-run bearer credential. Neither is distributable or committed. Browser sessions and artifacts live in `browser/workspaces/`.
- Stop the gateway with Ctrl+C in its own terminal. Do not stop the original Plugin-2 service. An exclusive `state/gateway.lock` prevents duplicate gateways. After an abnormal exit, verify the recorded PID is no longer that gateway before removing only its stale lock and restarting.
- No automatic startup registration, global configuration edits, tunnel creation, or OpenAI requests occur during installation. `npm ci` downloads pinned dependencies; it does not make model usage free.

## Optional remote tunnel

Local tools require neither a tunnel nor an OpenAI key. For deliberately authorized remote access, follow [Cloudflare's tunnel setup](https://developers.cloudflare.com/tunnel/setup/) and [locally managed tunnel instructions](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/). Configure Cloudflare Access for the intended users/service clients, retain the gateway bearer header, and route only `/mcp`. Do not expose the configuration endpoint. The remote MCP client must support both your Access authentication and the MCP bearer credential.

Example ingress fragment; replace PORT with the current `connection.json` port and configure your own tunnel/DNS/Access policy separately:

```yaml
ingress:
  - hostname: mcp.example.com
    path: ^/mcp$
    service: http://127.0.0.1:PORT
    originRequest:
      httpHostHeader: 127.0.0.1:PORT
  - service: http_status:404
```

The gateway rejects Origin headers on `/mcp` and requires its loopback Host header plus a bearer credential even through a tunnel. `/config` additionally accepts the known VibeSpace native origins and localhost development ports 5173/5174, because Tauri adds that header to native HTTP calls. It grants no browser CORS access. Never place credentials in a URL. It binds only `127.0.0.1:52643`; startup fails if that port is occupied. Each gateway restart rotates its token; update remote credentials explicitly. No remote deployment is included or claimed as tested. Native panel access requires the accompanying VibeSpace build containing the exact `/config` HTTP permission; older app binaries cannot use it.

## Optional OpenAI model key

Use the [official OpenAI quickstart](https://developers.openai.com/api/docs/quickstart) and [API keys page](https://platform.openai.com/api-keys). Sign in privately, choose the intended project, create a key, and save it through VibeSpace's OpenAI provider settings. Do not paste it into chat, this package, screenshots, or a recording. OpenAI is only required when selected as the model provider; API usage can incur charges.

The Browser Agent setup video is an actual Playwright recording of Edge navigating official documentation and the API-key sign-in entry. It demonstrates setup guidance; it does not create a key, authenticate a user, provision a tunnel, or prove a remote deployment.

## Attribution

Desktop Commander is MIT licensed, copyright Eduard Ruzga and Desktop Commander Contributors; see `upstream/LICENSE` and `upstream/package.json`. The copied companion is from the user's Plugin-2 Codex kit, with Playwright CLI pinned by `browser/package-lock.json`. Upstream documentation remains in `browser/UPSTREAM-README.md`; its original `p2.mjs`, desktop observation, and file-batch commands are not part of this browser-only companion. Original Desktop Commander file/terminal tools remain available through MCP. See `PROVENANCE.json` for source hashes, exclusions, and the one intentional upstream adaptation.
