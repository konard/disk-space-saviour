# Issue 18: application caches and safe defaults

## Timeline and cause

The October 8 macOS 0.13.1 scan identified 192 MiB Telegram pure cache, 17 MiB
container cache, 2.7 GiB media, 183 MiB additional Chromium caches, roughly
460 MiB across 14 embedded applications, and agent scratch copies. These are
reported measurements, not new measurements on this checkout. The paths and
details are preserved in [data/dss-issue-18.json](data/dss-issue-18.json).

Rules covered HTTP cache paths and a few known applications, missing actual
macOS Application Support locations and generic marker-validated profiles.
Project safety used the whole repository's dirty/unpushed state even for an
ignored regenerable artifact; old browser versions had conservative tiers.
The separate release failure kept npm users on older code.

## Every requirement, alternatives and solution

| Requirement                                                                         | Alternatives and implemented plan                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram App Store/Mac cache, container cache and Desktop on every OS               | Target only `cache`, `cache-storage`, `short-cache`, Desktop `cache`/`media_cache`, and sandbox Caches directories. Never remove group-container or tdata roots/databases.                                                   |
| Downloaded Telegram media with secret-chat warning                                  | Separate moderate rule excludes pure cache partitions and explains that cloud re-download may not restore secret-chat media.                                                                                                 |
| Chromium macOS code/GPU/Dawn/service-worker caches and root shader/component caches | Generate equivalent cache-leaf variants from every existing supported browser family, including Application Support paths, profile wildcard locations and root shader/component directories.                                 |
| Safari/WebKit and TCC diagnostics                                                   | Add the requested paths; propagate denied access as report errors with a Full Disk Access hint instead of silent absence.                                                                                                    |
| Generic Electron/embedded apps on macOS/Linux/Windows                               | Require sibling markers such as Local Storage or Preferences, target exact cache leaves and block a matching running application. Broad deletion of arbitrary Application Support folders is rejected.                       |
| Inactive Claude/Codex sessions, loose agent files and partial copies                | Discover identifiable session/project scratch and named agent logs/probes/copies. Require 30-day inactivity, liveness and Git checks when Git exists. Whole scratch remains moderate; unknown temporary files are preserved. |
| Safe inactive lockfile-backed node_modules                                          | Change only eligible inactive Node dependency artifacts to safe; retain lockfile, ignored-content and busy checks. Active project defaults remain aggressive.                                                                |
| Dirty/unpushed source does not block ignored outputs                                | Artifact-local Git inspection protects tracked and non-ignored contents while permitting unrelated source edits/unpushed commits. Whole-project/container Git checks remain conservative.                                    |
| Safe old Playwright revisions                                                       | Keep newest revision per browser family, remove eligible older ones in safe.                                                                                                                                                 |
| Explicit MCP/user-data exclusion                                                    | Reject MCP/profile/user-data directories independently of version-pattern matching, with pinned profile fixtures.                                                                                                            |
| Publish or loud failure                                                             | Preserve captured publish diagnostics, classify permanent E404/auth errors and give current publisher configuration guidance; see [issue 19](../issue-19/disk-space-saviour.md).                                             |
| Every rule tested; user data survives                                               | `issue-27-rule-families.test.js` scans and actually cleans each new family. Other tests retain Telegram database, browser cookies, Electron local storage and Playwright profile data.                                       |

## Coverage and research

Run `node --test --test-timeout=30000 tests/issue-27-caches.test.js tests/issue-27-rule-families.test.js tests/issue-27-details.test.js tests/scan-projects.test.js tests/scan-app-caches.test.js`.
The existing global scanner and common path/liveness policies are reused. No
new runtime library is needed. Electron app paths, Playwright persistence/GC,
runner documentation and BleachBit's declarative Chromium cleaner were evaluated
in the [component table](../issue-27/README.md#components-and-primary-source-research).
There is no verified upstream application bug to report: these are missing dss
rules and defaults. Tests model platforms without claiming a real macOS TCC
grant or live application cleanup was exercised here.
