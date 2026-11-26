---
name: ship
description: Publish an app change so it can be opened on the phone. Use after every change to the app (web files or android/), before ending the turn.
---

# Ship a change to the phone

The phone runs what is on `main` (GitHub Pages deploys the web app; the Android app updates its screens from it). A change is not done until it is on `main`.

1. Run `bash .claude/skills/ship/bump.sh`. It raises the build number in `index.html` and `sw.js` and prints it (call it N).
2. Check the page still loads with no script errors (`node --check app.js` at least).
3. Commit everything on the session's working branch and push it.
4. Open a pull request from that branch into `main` (GitHub MCP `create_pull_request`), then merge it (`merge_pull_request`, method `merge`).
5. Look once at the "Deploy to GitHub Pages" run for the merge commit (`actions_list`, `list_workflow_runs`, branch `main`). If it already failed, fix and ship again.
6. End the reply to the user with a last line that is exactly: `build N`
