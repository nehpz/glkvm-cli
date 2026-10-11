# glkvm-cli

A small command-line client for GL.iNet KVM-over-IP devices (Comet / GL-RM series) and other PiKVM-compatible `kvmd` hosts. It drives the device's HTTP API, so scripts and AI agents can see the screen, type, switch ports and control ATX power without a browser.

```console
$ glkvm snap memtest.jpg          # JPEG of whatever the target machine is showing
$ glkvm key Escape                # tap a key
$ glkvm key Delete --delay 50     # e.g. enter firmware setup during POST
$ glkvm key ArrowDown*3 Enter     # navigate a menu
$ glkvm port 1                    # switch the built-in KVM switch to port 1
$ glkvm atx                       # power / LED state
$ glkvm atx click reset --yes     # press the reset button (needs the ATX board)
```

## Install

Requires [Bun](https://bun.sh) ≥ 1.2.

```sh
git clone https://github.com/nehpz/glkvm-cli && cd glkvm-cli
bun install
bun link            # puts `glkvm` on your PATH
# or build a standalone binary:
bun run build       # -> dist/glkvm
```

## Configure

Settings come from the environment, or from `KEY=value` lines in `~/.config/glkvm.env` (override the path with `KVM_ENV_FILE`). Environment variables win.

| Variable | Meaning |
| --- | --- |
| `KVM_HOST` | Hostname, IP or URL of the KVM (`https://` is assumed) |
| `KVM_USER` | Web UI username |
| `KVM_PASS` | Web UI password |
| `KVM_INSECURE` | `1` to skip TLS verification — the devices ship self-signed certificates |

```sh
install -m 600 /dev/null ~/.config/glkvm.env
cat >> ~/.config/glkvm.env <<'EOF'
KVM_HOST=192.168.8.100
KVM_USER=admin
KVM_PASS=change-me
KVM_INSECURE=1
EOF
```

The session token from `POST /api/auth/login` is cached at `${XDG_CACHE_HOME:-~/.cache}/glkvm-cli/<host>.token` (mode 0600) and refreshed automatically when the device rejects it.

## Commands

| Command | What it does |
| --- | --- |
| `status` | ATX, active port, video links, HID and streamer state as JSON |
| `snap [FILE\|-]` | Save a JPEG of the screen; `-` writes to stdout |
| `port [N]` | Show the active switch port, or switch to port `N` (0-based) |
| `key CODE[*N]... [--delay MS]` | Tap keys in order (default 150 ms apart) |
| `shortcut CODE+CODE...` | Press keys together, e.g. `ControlLeft+AltLeft+Delete` |
| `type TEXT` | Type text as keystrokes |
| `atx` | ATX power and LED state |
| `atx click power\|power_long\|reset [--port N] --yes` | Press a front-panel button (`--port` targets a switch port) |
| `atx power on\|off\|off_hard\|reset_hard --yes` | Ask kvmd to reach a power state |

Key codes are browser [`KeyboardEvent.code`](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_code_values) names: `Escape`, `Enter`, `F2`, `Delete`, `ArrowDown`, `KeyA`, `Digit1`, …

Commands that can cut power to the target require `--yes`.

Exit codes: `0` success, `1` device/config error, `2` usage error.

## How it works (device quirks)

These are what make the API awkward to use by hand; the CLI handles them:

- **Login** is `POST /api/auth/login` with form fields `user` and `passwd`; the response sets an `auth_token` cookie that every other call needs. Tokens can be invalidated by the device (for example when another session ends), so the client re-logs in once on `401`/`403`.
- **Snapshots** come from `GET /api/streamer/snapshot`, but the video streamer only runs while a client holds the `/api/ws?stream=1` websocket. Without one the endpoint answers `503`. `glkvm snap` opens the websocket, polls until a JPEG arrives, then closes it.
- **OCR** (`/api/streamer/snapshot?ocr=1`) returned `500` on the firmware this was tested with, so the CLI does not expose it.
- **TLS** certificates are self-signed; set `KVM_INSECURE=1` or put the device behind a trusted certificate.

Tested against a GL.iNet Comet (`RM4PE`, firmware V1.10.1, kvmd/uStreamer 6.37). Other PiKVM-based devices expose the same routes, but switch and ATX features depend on the hardware fitted.

## Development

Tooling is [Vite+](https://viteplus.dev) (`vp`) with [Ultracite](https://www.ultracite.ai)'s oxlint/oxfmt presets; Bun stays the runtime, test runner and package manager.

```sh
vp install          # installs deps with Bun (packageManager) and sets up git hooks
vp check            # oxfmt format check, oxlint with type-aware rules, type check
vp check --fix      # apply formatting and safe lint fixes
bun test
bun run build       # standalone binary -> dist/glkvm
```

The pre-commit hook (`.vite-hooks/pre-commit`) runs `vp check --fix` on staged files, and [`actionlint`](https://github.com/rhysd/actionlint) on staged workflow files. Install it first (`brew install actionlint` or `go install github.com/rhysd/actionlint/cmd/actionlint@latest`).

## License

[MIT](LICENSE)
