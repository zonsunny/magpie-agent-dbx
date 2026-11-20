[简体中文](README.md) | [English](README.en.md)

# DBX · Magpie Agent

Point DBX at Magpie's local gateway. After install, **DBX** shows up on Magpie's Agents page. Pick a model and the plugin writes it into DBX's AI config; disconnect restores what was there before.

Targets **DBX 0.6.x** (desktop, macOS / Windows / Linux).

---

## What it does

- Writes the tables DBX actually reads: `ai_configs` and `app_state` in `dbx.db`. No DBX source changes.
- Owns one row only (`id=magpie`, openai-compatible). Your other configs and secrets stay put.
- Snapshots the previous default and active chat model, then restores them on disconnect.
- Uses Magpie's `/v1` endpoint with `apiStyle: completions`.
- Finds the data dir on macOS (`~/Library/Application Support/com.dbx.app`), Windows (`%APPDATA%\com.dbx.app`), and Linux (`$XDG_DATA_HOME/com.dbx.app`). Honors `DBX_DATA_DIR`.

---

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/zonsunny/magpie-agent-dbx/main/install.sh | sh
```

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/zonsunny/magpie-agent-dbx/main/install.ps1 | iex"
```

Or add this in Magpie → **Plugins**:

```text
github:zonsunny/magpie-agent-dbx
```

Or: `magpie plugin add github:zonsunny/magpie-agent-dbx`

---

## Quick start

### Requirements

- **Magpie** installed, gateway answering on `127.0.0.1:3425`.
- **DBX** installed and opened at least once (`dbx.db` exists).
- At least one model configured in Magpie.

On load the plugin links `~/.config/magpie/dbx-home` → the DBX data dir so Magpie can detect it.

### Steps

1. **Preflight**: `node tools/doctor.mjs` (Node ≥ 22.5). Confirm it found `dbx.db`.
2. **Install the plugin**, then open Magpie so the host can create the home link. `magpie ls` should list DBX.
3. **Pick a model** on Magpie's Agents page → **DBX**.
4. **Restart DBX**. It loads AI configs from SQLite at startup and caches them in memory.
5. In DBX, select the **Magpie** config and talk through the local gateway.

Disconnect with `magpie dbx default`, then restart DBX again.

---

## Commands

| Action | Command |
| :--- | :--- |
| **Preflight** | `node tools/doctor.mjs` |
| **Install** | `magpie plugin add github:zonsunny/magpie-agent-dbx` |
| **List agents** | `magpie ls` |
| **Show / set DBX model** | `magpie dbx` / `magpie dbx <model>` |
| **Disconnect and restore** | `magpie dbx default` |
| **Remove plugin** | `magpie plugin rm magpie-agent-dbx` |
| **Tests** | `npm test` |

---

## How it works

DBX stores AI config in SQLite. Magpie's agent sandbox cannot write a database, so the plugin splits in two:

```text
index.mjs on load
    │  $DBX_DATA_DIR, else the OS app-data dir if dbx.db is there
    ▼
~/.config/magpie/dbx-home  →  real data dir (detection only)

Magpie Agents page picks a model
    │
    ▼
dbx.agent.mjs (Magpie sandbox)
    │  JSON only
    ▼
~/.config/magpie/dbx-agent.json
    │
    ▼
index.mjs (Magpie's Bun plugin host, ~2s poll)
    │  apply / restore dbx.db
    ▼
ai_configs row id=magpie
  provider=openai-compatible
  endpoint=<Magpie /v1>
  apiKey left empty (a plaintext key retriggers DBX's secret-store wizard)
app_state.ai_chat_selection_v1.active → that row + current model
    │
    ▼
Restart DBX to reload SQLite
    ▼
Local Magpie gateway  http://127.0.0.1:3425/v1
```

On disconnect it deletes the `id=magpie` row and its `connection_secrets`, then restores the previous default and active chat model.

---

## Troubleshooting

- **`magpie ls` has no DBX**: open Magpie first so the host can create `~/.config/magpie/dbx-home`, then rerun `node tools/doctor.mjs`.
- **DBX does not show Magpie**: restart DBX. It caches AI configs in memory.
- **Custom data dir**: set `DBX_DATA_DIR` on the **Magpie process** (a shell `export` is not inherited).
- **Do not edit** `dbx.db` by hand. Disconnect with `magpie dbx default`.

---

## License

MIT. The icon is taken from an installed DBX.app.
