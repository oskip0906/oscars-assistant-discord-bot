# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Oscar's Obsidian Vault (oskip) - via GitHub

**Read from:** `~/.openclaw/vault-cache/oskip-vault`

This is a local clone of Oscar's private GitHub repo
`github.com/oskip0906/oskip-vault`, which is the source of truth. Plain
markdown - no Obsidian plugin, skill, or CLI is involved (none is installed).

**Do not read `~/Documents/oskip`.** That is the old local copy and is not the
source of truth anymore.

### How to answer any question about Oscar

**Step 1 - sync** (cheap, do it first so you aren't reading stale notes):

```bash
~/.openclaw/vault-sync.sh
```

**Step 2 - search:**

```bash
grep -rn -i "<keyword>" --include="*.md" ~/.openclaw/vault-cache/oskip-vault | head -20
```

**Step 3** - `read` the most relevant file(s) in full, then answer.

If the sync step fails (no network, auth problem), say so plainly and answer
from the cached copy, noting it may be out of date. Never silently skip the
search because sync failed.

### Credentials

The GitHub token lives in `~/.openclaw/secrets/` and is wired into git already -
you never need to handle, read, or type it. Never print it. If git asks for
auth, something is misconfigured; report it rather than working around it.

### Vault map (start here)

| Path | What's in it |
|------|--------------|
| `Knowledge/Oscar Pang - Profile.md` | Central hub note - start here for "who is Oscar" |
| `index.md` | Full catalog of every note |
| `_CLAUDE.md` | Vault operating manual |
| `Jobs/` | Roles held / starting (company, dates, responsibilities) |
| `Projects/` | Projects and publications |
| `People/` | People and companies |
| `Grad School/`, `Job Search/`, `Learning/`, `Knowledge/` | Self-explanatory |

### Non-negotiable

If asked something about Oscar and you have not run a search **this turn**, you
do not know the answer yet. Search first, then answer.

**Never claim you "checked his notes" unless you actually ran a tool call in
this turn.** Saying you checked when you did not is lying to the person asking.
If a search genuinely returns nothing, say the vault has no note on it - and say
what you searched for.

Privacy rules in SOUL.md still apply: only non-sensitive facts go to anyone but
Oscar.

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
