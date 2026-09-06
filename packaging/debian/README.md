# Debian packaging

`scripts/package-deb.sh` builds the package with `dpkg-deb` directly. It is the
only builder — there is no `debian/rules` and no debhelper run.

A `debian/rules` + `debian/control` pair used to sit here alongside it. Both
were dead: nothing invoked `dh`, so `override_dh_installsystemd`'s
`--no-start --no-enable` never ran, and `rules` wrote `DEBIAN/conffiles` into a
directory `dh_installdeb` had not created yet. Two packaging mechanisms where
only one runs is how a fix lands in the half that is never executed — so the
unused half is gone rather than kept "for later". If a full debhelper build is
ever wanted, add it *instead of* `package-deb.sh`, not beside it.

Files here that ARE used:

| File | Installed as | Purpose |
|---|---|---|
| `switchboard.service` | `/lib/systemd/system/switchboard.service` | Base unit. Carries only what systemd will interpolate — `ExecStart` — plus an `ExecStartPre` that refuses to start unconfigured. |
| `switchboard.env` | `/etc/switchboard/switchboard.env` (conffile) | Workspace, port, serve mode, user, extra PATH. Read by the unit's `EnvironmentFile`. |
| `postinst` / `prerm` / `postrm` | `DEBIAN/` | Install disabled; stop and disable on remove; drop `/etc/switchboard` on purge. Never touch board databases. |

`switchboard setup host` writes the drop-in
`/etc/systemd/system/switchboard.service.d/10-setup.conf`, which carries the
settings systemd will **not** expand `${VAR}` in — `User=`,
`WorkingDirectory=`, `Environment=HOME=`, `Environment=PATH=`. Interpolation
works in command lines only; putting `${SWITCHBOARD_USER}` in `User=` yields a
unit that fails to start with a username spelled `${SWITCHBOARD_USER}`.
