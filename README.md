<div align="center">

<img src="assets/mycelium.svg" alt="mycelium" width="330" />

# mycelium

Live, named handles on the components of a codebase, so an agent can ask for "the settings dialog" and get back exactly its code, from every file it spans, without searching for it. The names keep pointing at the right code as it's edited, split, renamed and moved.

</div>

## Why

An agent asked to change "the settings dialog" usually starts by searching for it, and in a real app the answer is spread across several files: the component, its stylesheet, a hook, a defaults file, the toggle it renders. mycelium gives each component a name and works out its extent from the code itself. The agent keeps a one-line-per-component catalog in context, and when it needs one, `myc show <slug>` returns all of it in one call.

Only a component's root declaration is stored. The files it owns, the ones it shares, and the components it renders are traced from the import graph on every lookup, so they can't go stale.

## Install

Needs [bun](https://bun.sh).

```sh
make
```

This builds a single `myc` binary and installs it to `~/.local/bin`. `make update` rebuilds and reinstalls it, and `make test` runs the typecheck and the test suite.

## Quick start

From anywhere inside a project (or with `-C <dir>`):

```console
$ myc scan
src/app/page.tsx#Home                           screen              → home-page
src/components/Card.tsx#Card                    component           → card
src/components/ToggleSwitch.tsx#ToggleSwitch    component           → toggle-switch
src/settings/SettingsDialog.tsx#SettingsDialog  component           → settings-dialog
src/settings/SettingsDialog.tsx#SettingsBadge   component           → settings-badge

5 unregistered. Register one with: myc add <slug> <file#Symbol> --note "<what it is>"

$ myc add src/components/ToggleSwitch.tsx --note "on/off switch with a label"
$ myc add src/settings/SettingsDialog.tsx#SettingsDialog --note "preferences modal with tabs and toggles"

$ myc list
settings-dialog — preferences modal with tabs and toggles
toggle-switch — on/off switch with a label
```

`myc list` is the catalog to put in an agent's context: about 15 tokens per component. `show` returns the component itself:

```console
$ myc show settings-dialog
settings-dialog — Settings dialog  [ok]
preferences modal with tabs and toggles

root     src/settings/SettingsDialog.tsx#SettingsDialog:16
files    src/settings/SettingsDialog.tsx:1,3-24
         src/settings/SettingsDialog.module.css
         src/settings/defaults.ts
         src/settings/useSettings.ts
uses     toggle-switch
shared   src/lib/cn.ts
used by  src/app/page.tsx (home-page)

── src/settings/SettingsDialog.tsx:1,3-24
import styles from "./SettingsDialog.module.css";
// …
import { useSettings } from "./useSettings";
...
```

`SettingsDialog.tsx` also declares `SettingsBadge`, so only lines 1 and 3–24 belong to the dialog. Line 2 is the badge's own stylesheet import, and `// …` marks the gap. `ToggleSwitch` is registered separately, so the dialog lists it under `uses` and stops tracing there. `cn.ts` is imported from elsewhere in the app too, so it's linked under `shared` rather than included.

After edits, `check` finds every component again:

```console
$ myc check
changed   home-page        changed src/app/page.tsx
relinked  settings-dialog  src/settings/SettingsDialog.tsx#SettingsDialog → src/settings/SettingsDialog.tsx#PreferencesDialog (renamed)
ok        toggle-switch

2 changed since last recorded; myc check --update records them
```

## Commands

| Command | What it does |
|---|---|
| `myc list` | The catalog: `slug — note`, one line per registered component. |
| `myc search <words>` | Registered components by name, alias, note, tag or path, with typo suggestions. |
| `myc show <slug>... [--no-code]` | A component's code from every file it spans, root first, plus what it uses and what uses it. |
| `myc scan [--all]` | Components in the code that aren't registered yet, with suggested slugs. `--all` includes unexported ones. |
| `myc add [<slug>] <file[#Symbol]>` | Register a component by its root declaration. With no `#Symbol`, the file's only (or default) component is used. Takes `--name`, `--note`, `--tags a,b`, `--alias`, `--pin <file>`. |
| `myc edit <slug>` | Change an entry: `--name --note --tags --alias --unalias --root --pin --unpin`. |
| `myc check [--update]` | Re-find every component after edits. `--update` records the new state. Exits 1 if any component is orphaned. |
| `myc remove <slug>` | Unregister a component. The code is untouched. |

Every command takes `--json` for machine-readable output and `-C <dir>` to run against another directory.

## How it works

**Finding components.** The TypeScript adapter loads the project through its tsconfig (including `references`, which electron-vite and Tauri templates use) and treats any capitalized function, arrow function, `memo`/`forwardRef` call or `Component` class in a `.tsx`/`.jsx` file that returns JSX as a component. Next.js `app/**/page.tsx` and `pages/**` defaults are marked as screens, and `layout.tsx`, `_app` and `_document` as layouts. Tests, stories, `node_modules`, build output and `src-tauri` are skipped.

**Slicing.** From the root declaration, mycelium follows local declarations and imports, through barrel files and tsconfig `paths` aliases like `@/`, down to the files they come from, stopping at any other registered component. A file belongs to the component only if everything that imports it is also inside the component; formally, it's the largest such set. Anything imported from outside is listed as `shared`. Re-exports and tests don't count as importers, since passing a name along isn't using it. A bare `import "./x.css"` can't be tied to one declaration, so it joins a component only when it's the only component in its file. When a file holds several components, the root file is cut down to the lines its root actually reaches. `--pin` adds a file by hand when the graph can't see it.

**Following edits.** Each entry stores a fingerprint of its slice. Fingerprints are hashed from tokens, so formatting and comments don't count as changes. On every lookup the root is found again, the way git follows renamed files:

- `ok`: same root, same code.
- `changed`: same root, but the code changed. `show` says which files.
- `relinked`: the root is gone, but it was found as `moved` (same name, another file), `renamed` (same declaration body, new name) or `similar` (body at least 60% similar).
- `orphaned`: nothing matches well enough. Re-point it with `myc edit <slug> --root <file#Symbol>`.

Splitting a component into new files needs no relinking: the new files are traced from the root like the old ones.

## Frameworks

One TypeScript adapter covers the React stacks: Next.js (app and pages routers, `@/` aliases), Electron (the renderer is where the JSX is, and electron-vite's split tsconfigs are followed) and Tauri (a Vite frontend, with the Rust side skipped). Plain Vite or CRA React projects work the same way.

Swift/SwiftUI is planned as a second adapter behind the same `Workspace` interface. Swift has no imports between files in a module, so it will resolve names module-wide, and `#Preview` blocks will serve as each view's example.

## Storage

Each component is one file, `.mycelium/components/<slug>.json`, holding its name, note, tags, aliases, root (`file` + `symbol`), pins and last recorded fingerprint. Commit the directory: one file per component keeps merge conflicts rare and diffs readable.

## As a library

```ts
import { findRoot, Library, openWorkspace, Store } from "mycelium";

const root = findRoot(process.cwd());
const lib = new Library(openWorkspace(root), new Store(root));

const dialog = lib.resolve("settings-dialog");
for (const chunk of dialog?.slice?.chunks ?? []) console.log(chunk.file, chunk.ranges ?? "whole file");
```

`Library` exposes `resolve`, `resolveAll`, `register`, `record` and `unregistered`, which the CLI is built on.

## Limits

- Only TypeScript/JavaScript React for now.
- Roots that aren't components (a hook, a helper) can be registered and shown, but they don't relink after a rename.
- Global CSS selectors and anything wired up at runtime (dynamic imports by string, DI containers) aren't traced. Pin those files.
- No rendering or screenshots yet.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build    # bin/myc
```
